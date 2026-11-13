-- KMC Dengue Intelligence — core schema
-- Postgres 15+ with PostGIS (available on Supabase as an extension). gen_random_uuid() is built in.

create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- Geography (versioned: 144 wards today, 209 wards after the 2026 delimitation)
-- ---------------------------------------------------------------------------
create table public.geo_versions (
  id            smallint primary key,
  name          text not null,
  ward_count    int  not null,
  is_active     boolean not null default false,
  effective_from date,
  notes         text
);
create unique index geo_versions_one_active on public.geo_versions (is_active) where is_active;

insert into public.geo_versions (id, name, ward_count, is_active, notes) values
  (1, 'KMC 144 wards, 16 boroughs', 144, true,  '141 boundaries from DataMeet open data; wards 142–144 approximate until KMC supplies official GIS'),
  (2, 'KMC 209 wards (2026 delimitation)', 209, false, 'Load official boundaries when published, then switch is_active');

create table public.boroughs (
  geo_version smallint not null references public.geo_versions(id),
  code        text not null,           -- 'I' … 'XVI'
  name        text,
  primary key (geo_version, code)
);

create table public.wards (
  geo_version     smallint not null references public.geo_versions(id),
  ward_no         int  not null,
  borough         text not null,
  population      int,
  area_km2        numeric(8,3),
  geom            geometry(MultiPolygon, 4326),
  centroid        geometry(Point, 4326) not null,
  boundary_source text not null default 'datameet' check (boundary_source in ('datameet', 'pending', 'official')),
  primary key (geo_version, ward_no),
  foreign key (geo_version, borough) references public.boroughs(geo_version, code)
);
create index wards_geom_gix on public.wards using gist (geom);
create index wards_centroid_gix on public.wards using gist (centroid);

-- adjacency: wards whose boundaries are within 40 m (or centroids within 2.5 km when no boundary)
create table public.ward_neighbours (
  geo_version  smallint not null,
  ward_no      int not null,
  neighbour_no int not null,
  primary key (geo_version, ward_no, neighbour_no)
);

create or replace function public.active_geo_version() returns smallint
language sql stable as $$ select id from public.geo_versions where is_active limit 1 $$;

create or replace function public.refresh_ward_neighbours(p_version smallint default null) returns int
language plpgsql as $$
declare v smallint := coalesce(p_version, public.active_geo_version()); n int;
begin
  delete from public.ward_neighbours where geo_version = v;
  insert into public.ward_neighbours (geo_version, ward_no, neighbour_no)
  select a.geo_version, a.ward_no, b.ward_no
  from public.wards a
  join public.wards b on b.geo_version = a.geo_version and b.ward_no <> a.ward_no
  where a.geo_version = v
    and case
          when a.geom is not null and b.geom is not null then st_dwithin(a.geom::geography, b.geom::geography, 40)
          else st_dwithin(a.centroid::geography, b.centroid::geography, 2500)
        end;
  get diagnostics n = row_count;
  return n;
end $$;

-- ward that contains a point, in the active geography
create or replace function public.ward_at(p_lng double precision, p_lat double precision) returns int
language sql stable as $$
  select w.ward_no from public.wards w
  where w.geo_version = public.active_geo_version()
    and w.geom is not null
    and st_contains(w.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326))
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- People and access
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null check (role in ('hq', 'borough', 'ward', 'field', 'councillor', 'lab')),
  borough      text,          -- for borough officers
  ward_no      int,           -- for ward officers, field teams, councillors
  facility     text,          -- for lab / hospital reporters
  pii_access   boolean not null default false,
  created_at   timestamptz not null default now(),
  check ((role <> 'borough') or borough is not null),
  check ((role not in ('ward', 'field', 'councillor')) or ward_no is not null)
);

create table public.teams (
  id      uuid primary key default gen_random_uuid(),
  ward_no int  not null,
  name    text not null unique,
  members int  not null default 4
);

-- ---------------------------------------------------------------------------
-- Surveillance data
-- ---------------------------------------------------------------------------
create table public.dengue_cases (
  id            uuid primary key default gen_random_uuid(),
  ward_no       int  not null,
  reported_on   date not null,
  onset_on      date,
  test_type     text not null check (test_type in ('NS1', 'IgM', 'NS1 + IgM', 'RT-PCR')),
  source        text not null check (source in ('KMC lab', 'Private lab', 'Govt hospital', 'Private hospital', 'IHIP')),
  age_band      text check (age_band in ('0–4', '5–14', '15–24', '25–44', '45–59', '60+')),
  sex           text check (sex in ('M', 'F', 'Other')),
  lat           double precision,
  lng           double precision,
  geom          geometry(Point, 4326) generated always as (
                  case when lat is not null and lng is not null then st_setsrid(st_makepoint(lng, lat), 4326) end
                ) stored,
  hospitalised  boolean not null default false,
  severity      text check (severity in ('Dengue', 'Dengue with warning signs', 'Severe dengue')),
  dedupe_key    text not null unique,     -- salted hash of identity fields; no names or phone numbers here
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  check (onset_on is null or onset_on <= reported_on)
);
create index dengue_cases_ward_date on public.dengue_cases (ward_no, reported_on);
create index dengue_cases_geom_gix on public.dengue_cases using gist (geom);

-- Identifiable details, only for officers with pii_access (contact tracing, follow-up)
create table public.case_contacts (
  case_id      uuid primary key references public.dengue_cases(id) on delete cascade,
  patient_name text,
  phone        text,
  address      text,
  created_at   timestamptz not null default now()
);

create table public.larval_surveys (
  id                    uuid primary key default gen_random_uuid(),
  ward_no               int  not null,
  survey_date           date not null,
  team                  text,
  houses_visited        int  not null check (houses_visited > 0),
  houses_positive       int  not null check (houses_positive >= 0),
  containers_inspected  int  not null check (containers_inspected >= 0),
  containers_positive   int  not null check (containers_positive >= 0),
  notes                 text,
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  check (houses_positive <= houses_visited),
  check (containers_positive <= containers_inspected)
);
create index larval_surveys_ward_date on public.larval_surveys (ward_no, survey_date);

create table public.breeding_sites (
  id             uuid primary key default gen_random_uuid(),
  ward_no        int  not null,
  site_type      text not null,
  lat            double precision not null,
  lng            double precision not null,
  status         text not null default 'Open' check (status in ('Open', 'Treated', 'Closed')),
  detected_by    text not null check (detected_by in ('Field team', 'Drone', 'Citizen')),
  first_seen     date not null default current_date,
  last_action_on date,
  description    text,
  photo_path     text,      -- Supabase Storage object path (bucket: site-photos)
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
create index breeding_sites_ward on public.breeding_sites (ward_no, status);

create table public.weather_weekly (
  week_start date primary key,   -- Monday
  rain_mm    numeric(7,1) not null,
  t_mean_c   numeric(4,1) not null,
  rh_pct     numeric(4,1) not null,
  source     text not null default 'open-meteo'
);

-- ---------------------------------------------------------------------------
-- Analytics outputs and response
-- ---------------------------------------------------------------------------
create table public.risk_scores (
  ward_no       int  not null,
  as_of         date not null,
  score         int  not null check (score between 0 and 100),
  level         text not null check (level in ('Low', 'Moderate', 'High', 'Very high')),
  drivers       jsonb not null,
  forecast      jsonb not null,
  model_version text not null,
  created_at    timestamptz not null default now(),
  primary key (ward_no, as_of)
);

create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  ward_no      int  not null,
  alert_type   text not null check (alert_type in ('exceedance', 'cluster', 'entomological', 'predicted')),
  level        text not null check (level in ('Watch', 'Warning', 'Outbreak')),
  title        text not null,
  detail       text not null,
  status       text not null default 'New' check (status in ('New', 'Acknowledged', 'Closed')),
  cluster_lng  double precision,
  cluster_lat  double precision,
  case_ids     text[],
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index alerts_ward_created on public.alerts (ward_no, created_at desc);

create table public.field_tasks (
  id           uuid primary key default gen_random_uuid(),
  ward_no      int  not null,
  task_type    text not null,
  title        text not null,
  priority     text not null check (priority in ('P1', 'P2', 'P3')),
  status       text not null default 'Open' check (status in ('Open', 'In progress', 'Done', 'Verified')),
  source       text not null default 'Manual' check (source in ('Alert', 'Manual', 'Citizen')),
  alert_id     uuid references public.alerts(id) on delete set null,
  team         text,
  notes        text,
  due_at       timestamptz not null,
  completed_at timestamptz,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index field_tasks_ward_status on public.field_tasks (ward_no, status);

create table public.citizen_reports (
  id          uuid primary key default gen_random_uuid(),
  ward_no     int  not null,
  kind        text not null check (kind in ('Stagnant water', 'Garbage dump', 'Fever in neighbourhood', 'Mosquito nuisance')),
  text        text not null,
  lat         double precision,
  lng         double precision,
  channel     text not null default 'App' check (channel in ('App', 'WhatsApp', 'Helpline', 'Web')),
  status      text not null default 'New' check (status in ('New', 'Task created', 'Resolved')),
  reported_at timestamptz not null default now()
);

create table public.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  table_name text not null,
  row_id     text,
  action     text not null,
  diff       jsonb
);

-- ---------------------------------------------------------------------------
-- Triggers: assign ward from location, keep updated_at, audit writes
-- ---------------------------------------------------------------------------
create or replace function public.tg_assign_ward() returns trigger
language plpgsql as $$
declare w int;
begin
  if new.lat is not null and new.lng is not null then
    w := public.ward_at(new.lng, new.lat);
    if w is not null then new.ward_no := w; end if;
  end if;
  return new;
end $$;
create trigger assign_ward before insert or update of lat, lng on public.dengue_cases
  for each row execute function public.tg_assign_ward();
create trigger assign_ward before insert or update of lat, lng on public.breeding_sites
  for each row execute function public.tg_assign_ward();
create trigger assign_ward before insert or update of lat, lng on public.citizen_reports
  for each row execute function public.tg_assign_ward();

create or replace function public.tg_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger touch before update on public.alerts for each row execute function public.tg_touch();

create or replace function public.tg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor, table_name, row_id, action, diff)
  values (auth.uid(), tg_table_name,
          coalesce((to_jsonb(new) ->> 'id'), (to_jsonb(old) ->> 'id'), (to_jsonb(new) ->> 'case_id'), (to_jsonb(old) ->> 'case_id')), tg_op,
          case when tg_table_name = 'case_contacts' then null   -- never copy identifiable details into the audit trail
               when tg_op = 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
               when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end);
  return coalesce(new, old);
end $$;
create trigger audit after insert or update or delete on public.dengue_cases   for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.case_contacts  for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.field_tasks    for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.alerts         for each row execute function public.tg_audit();
create trigger audit after insert or update or delete on public.breeding_sites for each row execute function public.tg_audit();
