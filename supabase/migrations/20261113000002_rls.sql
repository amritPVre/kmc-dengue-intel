-- Row-level security: every signed-in user sees only their own area.
--   hq          → all wards
--   borough     → wards of their borough
--   ward/field  → their ward
--   councillor  → their ward, aggregates only (no case line list)
--   lab         → may report cases anywhere, sees only what it reported

create or replace function public.my_profile() returns public.profiles
language sql stable security definer set search_path = public as $$
  select * from public.profiles where user_id = auth.uid()
$$;

create or replace function public.ward_in_scope(p_ward int) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare p public.profiles;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if p is null then return false; end if;
  if p.role = 'hq' then return true; end if;
  if p.role = 'borough' then
    return exists (select 1 from public.wards w
                   where w.geo_version = public.active_geo_version() and w.ward_no = p_ward and w.borough = p.borough);
  end if;
  if p.role in ('ward', 'field', 'councillor') then return p.ward_no = p_ward; end if;
  return false;
end $$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;

alter table public.geo_versions    enable row level security;
alter table public.boroughs        enable row level security;
alter table public.wards           enable row level security;
alter table public.ward_neighbours enable row level security;
alter table public.profiles        enable row level security;
alter table public.teams           enable row level security;
alter table public.dengue_cases    enable row level security;
alter table public.case_contacts   enable row level security;
alter table public.larval_surveys  enable row level security;
alter table public.breeding_sites  enable row level security;
alter table public.weather_weekly  enable row level security;
alter table public.risk_scores     enable row level security;
alter table public.alerts          enable row level security;
alter table public.field_tasks     enable row level security;
alter table public.citizen_reports enable row level security;
alter table public.audit_log       enable row level security;

-- reference data: readable by any signed-in user
create policy read_all on public.geo_versions    for select to authenticated using (true);
create policy read_all on public.boroughs        for select to authenticated using (true);
create policy read_all on public.wards           for select to authenticated using (true);
create policy read_all on public.ward_neighbours for select to authenticated using (true);
create policy read_all on public.weather_weekly  for select to authenticated using (true);
create policy read_scope on public.teams         for select to authenticated using (public.ward_in_scope(ward_no));

create policy own_profile on public.profiles for select to authenticated using (user_id = auth.uid() or public.my_role() = 'hq');

-- cases: health roles in scope; labs see their own submissions; councillors see none (aggregates via v_ward_weekly)
create policy read_cases on public.dengue_cases for select to authenticated
  using ((public.my_role() in ('hq', 'borough', 'ward', 'field') and public.ward_in_scope(ward_no)) or created_by = auth.uid());
create policy insert_cases on public.dengue_cases for insert to authenticated
  with check (public.my_role() = 'lab' or (public.my_role() in ('hq', 'borough', 'ward') and public.ward_in_scope(ward_no)));

create policy pii_read on public.case_contacts for select to authenticated
  using (exists (select 1 from public.dengue_cases c where c.id = case_id and public.ward_in_scope(c.ward_no))
         and coalesce((public.my_profile()).pii_access, false));
create policy pii_insert on public.case_contacts for insert to authenticated
  with check (public.my_role() in ('lab', 'hq', 'borough', 'ward'));

-- field data
create policy read_scope   on public.larval_surveys for select to authenticated using (public.ward_in_scope(ward_no));
create policy write_scope  on public.larval_surveys for insert to authenticated with check (public.ward_in_scope(ward_no) and public.my_role() <> 'councillor');
create policy read_scope   on public.breeding_sites for select to authenticated using (public.ward_in_scope(ward_no));
create policy write_scope  on public.breeding_sites for insert to authenticated with check (public.ward_in_scope(ward_no) and public.my_role() <> 'councillor');
create policy update_scope on public.breeding_sites for update to authenticated using (public.ward_in_scope(ward_no) and public.my_role() <> 'councillor');

-- analytics outputs
create policy read_scope on public.risk_scores for select to authenticated using (public.ward_in_scope(ward_no));
create policy read_scope on public.alerts      for select to authenticated using (public.ward_in_scope(ward_no));
create policy insert_hq  on public.alerts      for insert to authenticated with check (public.my_role() in ('hq', 'borough') and public.ward_in_scope(ward_no));
create policy update_scope on public.alerts    for update to authenticated using (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward'));

-- tasks: supervisors create and verify; field teams move their own ward's tasks
create policy read_scope   on public.field_tasks for select to authenticated using (public.ward_in_scope(ward_no));
create policy insert_scope on public.field_tasks for insert to authenticated with check (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward'));
create policy update_scope on public.field_tasks for update to authenticated
  using (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward', 'field'))
  with check (public.my_role() <> 'field' or status in ('In progress', 'Done'));

create policy read_scope   on public.citizen_reports for select to authenticated using (public.ward_in_scope(ward_no) and public.my_role() <> 'councillor');
create policy update_scope on public.citizen_reports for update to authenticated using (public.ward_in_scope(ward_no) and public.my_role() in ('hq', 'borough', 'ward'));
-- citizen intake (WhatsApp bot, app) writes through an edge function with the service role.

create policy read_hq on public.audit_log for select to authenticated using (public.my_role() = 'hq');
