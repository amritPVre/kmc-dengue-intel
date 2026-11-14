-- Computed public-data layers (satellite passes, land cover, weather, OpenStreetMap candidates).
-- Written only by the server functions with the service-role key; browsers read them through /api.
create table if not exists public.public_layers (
  key text primary key,
  data jsonb not null,
  source text,
  updated_at timestamptz not null default now()
);
create index if not exists public_layers_prefix on public.public_layers (key text_pattern_ops);
alter table public.public_layers enable row level security;
-- no policies: anon and authenticated users have no direct access
revoke all on public.public_layers from anon, authenticated;
