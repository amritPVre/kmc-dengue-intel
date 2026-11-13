-- Standing-water detection: the prevention core of the platform.
-- Detections arrive from the satellite pipeline (Sentinel-1/2, NISAR), drone imagery, field and
-- citizen photos (AI vision), KMC flood sensors and the rain + terrain model. Ward teams verify
-- each one; their confirm / false-alarm decisions are the training labels for better detectors.

create table public.water_detections (
  id           uuid primary key default gen_random_uuid(),
  ward_no      int  not null,
  lat          double precision not null,
  lng          double precision not null,
  geom         geometry(Point, 4326) generated always as (st_setsrid(st_makepoint(lng, lat), 4326)) stored,
  footprint    geometry(MultiPolygon, 4326),         -- water patch outline from satellite, when available
  area_m2      numeric(10,1),
  source       text not null check (source in ('Satellite radar', 'Satellite optical', 'Drone AI', 'Field photo AI', 'Citizen photo AI', 'Rain + terrain model', 'Flood sensor')),
  sensor       text,                                 -- Sentinel-1C, Sentinel-2B, NISAR, drone mission id, FFEWS node…
  kind         text not null,
  detected_at  timestamptz not null default now(),
  water_since  date not null,                        -- first day the water was seen (or the rain that caused it)
  confidence   numeric(3,2) not null check (confidence between 0 and 1),
  status       text not null default 'New' check (status in ('New', 'Confirmed', 'False alarm', 'Cleared')),
  aedes_risk   text not null default 'Medium' check (aedes_risk in ('High', 'Medium', 'Low')),
  ai           jsonb,                                -- vision model output: summary, objects, larvae, action, reasons, model
  photo_path   text,                                 -- Storage path in bucket detection-photos
  task_id      uuid references public.field_tasks(id) on delete set null,
  verified_by  uuid,
  verified_at  timestamptz,
  cleared_on   date,
  created_by   uuid default auth.uid()
);
create index water_detections_ward_status on public.water_detections (ward_no, status, water_since);
create index water_detections_geom_gix on public.water_detections using gist (geom);

create trigger assign_ward before insert or update of lat, lng on public.water_detections
  for each row execute function public.tg_assign_ward();
create trigger audit after insert or update or delete on public.water_detections for each row execute function public.tg_audit();

-- record who verified, automatically
create or replace function public.tg_water_verified() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status and old.status = 'New' then
    new.verified_by := auth.uid(); new.verified_at := coalesce(new.verified_at, now());
  end if;
  if new.status = 'Cleared' and new.cleared_on is null then new.cleared_on := current_date; end if;
  return new;
end $$;
create trigger water_verified before update on public.water_detections for each row execute function public.tg_water_verified();

-- A satellite patch found again on a later pass is the same water: keep the older record (its
-- water_since is what the breeding window counts from), refresh it, and drop the duplicate.
create or replace function public.merge_persisting_water(p_radius_m double precision default 30) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with pairs as (
    select distinct on (nd.id) nd.id as new_id, od.id as old_id, nd.detected_at, nd.confidence, nd.area_m2
    from public.water_detections nd
    join public.water_detections od
      on od.id <> nd.id and od.status in ('New', 'Confirmed') and od.detected_at < nd.detected_at
     and od.source in ('Satellite radar', 'Satellite optical')
     and st_dwithin(od.geom::geography, nd.geom::geography, p_radius_m)
    where nd.source in ('Satellite radar', 'Satellite optical') and nd.status = 'New'
      and nd.detected_at > now() - interval '1 day'
    order by nd.id, od.detected_at
  ), refreshed as (
    update public.water_detections o
       set detected_at = p.detected_at, confidence = greatest(o.confidence, p.confidence), area_m2 = coalesce(p.area_m2, o.area_m2)
      from pairs p where o.id = p.old_id
    returning o.id
  )
  delete from public.water_detections d using pairs p where d.id = p.new_id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.merge_persisting_water(double precision) from public, anon, authenticated;

-- satellite acquisitions processed by the pipeline
create table public.satellite_passes (
  id          uuid primary key default gen_random_uuid(),
  sensor      text not null check (sensor in ('Sentinel-1', 'Sentinel-2', 'NISAR')),
  platform    text not null,
  pass_date   date not null,
  cloud_pct   numeric(5,1),
  detections  int not null default 0,
  status      text not null check (status in ('Processed', 'Too cloudy', 'Awaiting data')),
  scene_id    text,
  created_at  timestamptz not null default now(),
  unique (sensor, platform, pass_date)
);

-- rain by gauge and day (KMC automatic rain gauges / FFEWS, IMD, or Open-Meteo fallback)
create table public.rain_daily (
  gauge   text not null,
  day     date not null,
  rain_mm numeric(6,1) not null,
  lat     double precision,
  lng     double precision,
  source  text not null default 'KMC FFEWS',
  primary key (gauge, day)
);
create or replace view public.rain_daily_city with (security_invoker = true) as
  select day, round(avg(rain_mm), 1) as rain_mm, max(rain_mm) as max_gauge_mm, count(*) as gauges
  from public.rain_daily group by day;

-- waterlogging susceptibility per ward (0–1): share of monsoon satellite passes in which the ward's
-- low-lying pockets were wet, blended with terrain; refreshed by the satellite pipeline each year
create table public.ward_susceptibility (
  ward_no        int primary key,
  susceptibility numeric(4,3) not null check (susceptibility between 0 and 1),
  pockets        jsonb,              -- [{lat, lng, wet_frequency}] used by the rain + terrain model
  method         text not null default 'S1 wet frequency 2023-2026 + Copernicus DEM',
  updated_at     timestamptz not null default now()
);

alter table public.water_detections   enable row level security;
alter table public.satellite_passes   enable row level security;
alter table public.rain_daily         enable row level security;
alter table public.ward_susceptibility enable row level security;

create policy read_scope   on public.water_detections for select to authenticated using (public.ward_in_scope(ward_no));
create policy insert_scope on public.water_detections for insert to authenticated with check (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward', 'field'));
create policy update_scope on public.water_detections for update to authenticated using (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward', 'field'));
create policy read_all on public.satellite_passes    for select to authenticated using (true);
create policy read_all on public.rain_daily          for select to authenticated using (true);
create policy read_all on public.ward_susceptibility for select to authenticated using (true);
-- satellite, sensor and rain-model writes come from Edge Functions / pipelines with the service role.

-- water alerts and the clearance task type
alter table public.alerts drop constraint if exists alerts_alert_type_check;
alter table public.alerts add constraint alerts_alert_type_check
  check (alert_type in ('exceedance', 'cluster', 'entomological', 'predicted', 'water'));

grant select on public.rain_daily_city to authenticated;

-- Storage bucket for photos (run once in the dashboard or here):
-- insert into storage.buckets (id, name, public) values ('detection-photos', 'detection-photos', false) on conflict do nothing;
