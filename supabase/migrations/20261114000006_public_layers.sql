-- Computed public-data layers (satellite passes, land cover, weather, OpenStreetMap candidates).
-- The server functions read and write them through the three functions below; browsers read
-- them through /api. Writing needs the token stored in private.app_secrets.
create schema if not exists private;
create table if not exists private.app_secrets (name text primary key, value text not null);
revoke all on schema private from public, anon, authenticated;

create table if not exists public.public_layers (
  key text primary key,
  data jsonb not null,
  source text,
  updated_at timestamptz not null default now()
);
create index if not exists public_layers_prefix on public.public_layers (key text_pattern_ops);
alter table public.public_layers enable row level security;
revoke all on public.public_layers from anon, authenticated;

create or replace function public.layer_get(p_key text)
returns table (data jsonb, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.data, l.updated_at from public.public_layers l where l.key = p_key
$$;

create or replace function public.layer_list(p_prefix text, p_meta boolean default false, p_limit int default 500)
returns table (key text, data jsonb, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.key, case when p_meta then null else l.data end, l.updated_at
  from public.public_layers l
  where l.key like replace(replace(p_prefix, '%', '\%'), '_', '\_') || '%'
  order by l.key limit least(greatest(p_limit, 1), 2000)
$$;

create or replace function public.layer_put(p_key text, p_data jsonb, p_source text, p_token text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or p_token <> (select value from private.app_secrets where name = 'layer_write_token') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  insert into public.public_layers (key, data, source, updated_at) values (p_key, p_data, p_source, now())
  on conflict (key) do update set data = excluded.data, source = excluded.source, updated_at = now();
  return true;
end $$;

revoke all on function public.layer_get(text), public.layer_list(text, boolean, int), public.layer_put(text, jsonb, text, text) from public;
grant execute on function public.layer_get(text), public.layer_list(text, boolean, int), public.layer_put(text, jsonb, text, text) to anon, authenticated;
