-- Views read by the web app.

-- Active-geography wards with centroid, bbox and neighbours as plain columns.
create or replace view public.v_wards_active with (security_invoker = true) as
select
  w.ward_no,
  w.borough,
  st_x(w.centroid) as centroid_lng,
  st_y(w.centroid) as centroid_lat,
  w.area_km2,
  case when w.geom is not null
       then array[st_xmin(w.geom), st_ymin(w.geom), st_xmax(w.geom), st_ymax(w.geom)]
       else array[st_x(w.centroid) - 0.006, st_y(w.centroid) - 0.006, st_x(w.centroid) + 0.006, st_y(w.centroid) + 0.006]
  end as bbox,
  coalesce((select array_agg(n.neighbour_no order by n.neighbour_no) from public.ward_neighbours n
            where n.geo_version = w.geo_version and n.ward_no = w.ward_no), '{}') as neighbours,
  w.boundary_source,
  w.population
from public.wards w
where w.geo_version = public.active_geo_version();

-- Ward boundaries as GeoJSON (for deployments that load geometry from the database).
create or replace view public.v_wards_geojson with (security_invoker = true) as
select w.ward_no, w.borough, st_asgeojson(w.geom, 6)::jsonb as geometry
from public.wards w
where w.geo_version = public.active_geo_version() and w.geom is not null;

-- Weekly case counts per ward. Runs with the owner's rights so councillors can see
-- counts for their ward without access to the case line list; scope is enforced in WHERE.
create or replace view public.v_ward_weekly as
select c.ward_no, date_trunc('week', c.reported_on)::date as week_start, count(*)::int as cases,
       count(*) filter (where c.hospitalised)::int as hospitalised
from public.dengue_cases c
where public.ward_in_scope(c.ward_no)
group by 1, 2;

-- Larval indices per ward per week (WHO House, Container and Breteau indices).
create or replace view public.v_ward_larval_weekly with (security_invoker = true) as
select s.ward_no, date_trunc('week', s.survey_date)::date as week_start,
       sum(s.houses_visited) as houses_visited,
       round(100.0 * sum(s.houses_positive) / nullif(sum(s.houses_visited), 0), 1) as house_index,
       round(100.0 * sum(s.containers_positive) / nullif(sum(s.containers_inspected), 0), 1) as container_index,
       round(100.0 * sum(s.containers_positive) / nullif(sum(s.houses_visited), 0), 1) as breteau_index
from public.larval_surveys s
group by 1, 2;

-- Latest risk score per ward.
create or replace view public.v_ward_risk_latest with (security_invoker = true) as
select distinct on (ward_no) * from public.risk_scores order by ward_no, as_of desc;

grant select on public.v_wards_active, public.v_wards_geojson, public.v_ward_weekly,
                public.v_ward_larval_weekly, public.v_ward_risk_latest to authenticated;
