-- Grants for the bundled stack, applied after supabase/schema.sql on every start.
--
-- The API, worker and MCP reach the database only through PostgREST with the
-- service_role key, so service_role gets everything in public, now and for tables
-- added later. anon and authenticated get no table grants here: PostgREST is not
-- published outside the compose network, and the browser talks only to GoTrue
-- (/auth/v1) and the API.
set client_min_messages = warning;

-- The instance owner claim (apps/api/src/lib/instanceOwner.mjs). One row at most: the
-- primary key is a boolean that can only be true, so of two first sign-ups racing each
-- other only one INSERT succeeds. Bundled stack only, so it lives here and not in
-- supabase/migrations. Only the API (service_role) touches it.
create table if not exists public.selfhost_instance_owner (
  id boolean primary key default true check (id),
  auth_user_id uuid not null,
  claimed_at timestamptz not null default now()
);
alter table public.selfhost_instance_owner enable row level security;
revoke all on public.selfhost_instance_owner from public, anon, authenticated;
-- A database that already has users (set up before the claim existed) is already owned:
-- record its first user, so the setup token cannot mint a second owner on it.
insert into public.selfhost_instance_owner (id, auth_user_id, claimed_at)
select true, u.supabase_user_id, u.created_at
from public.users u
where u.supabase_user_id is not null
order by u.created_at
limit 1
on conflict (id) do nothing;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

-- PostgREST caches the schema; tell it to reload.
notify pgrst, 'reload schema';
