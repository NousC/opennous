#!/bin/bash
# First-boot init for the bundled Postgres (runs once, from /docker-entrypoint-initdb.d).
#
# A bare Postgres lacks what a Supabase project ships with. This adds the parts the
# app, GoTrue and PostgREST need, and nothing else:
#   - pgcrypto + pgvector (schema.sql also creates them; doing it here is harmless)
#   - the API roles PostgREST switches into: anon, authenticated, service_role
#   - authenticator: the login role PostgREST connects as
#   - supabase_auth_admin: the login role GoTrue connects as; it owns the auth schema
#     and creates auth.users, auth.uid(), auth.role() with its own migrations
#
# Both login roles use POSTGRES_PASSWORD. The database is not published outside the
# compose network.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$POSTGRES_PASSWORD" <<'SQL'
create extension if not exists pgcrypto with schema public;
create extension if not exists vector with schema public;

do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit; end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit createrole; end if;
end $$;

alter role authenticator with password :'pw';
alter role supabase_auth_admin with password :'pw';
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth authorization supabase_auth_admin;
grant create on database postgres to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
grant usage on schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
SQL
