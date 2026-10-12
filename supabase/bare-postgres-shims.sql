-- Minimal stand-ins for what a Supabase project provides, so supabase/schema.sql
-- applies on a plain Postgres 15+ with pgvector (e.g. pgvector/pgvector:pg17).
--
-- Do NOT run this against a real Supabase project: it already has these roles,
-- the auth schema and the extensions.
--
-- Covers: the three PostgREST roles the schema grants to, the auth schema with
-- auth.users and the auth.uid()/auth.role()/auth.jwt() helpers the RLS policies
-- call, and Supabase's default privileges on schema public (every new table,
-- sequence and function is granted to anon, authenticated and service_role;
-- RLS and the schema's own REVOKEs then narrow that). schema.sql creates the
-- extensions it needs (pgcrypto, vector, pg_trgm) itself; the image must ship
-- pgvector.
-- auth.uid()/role()/jwt() read the same request.jwt.claims GUC PostgREST sets,
-- so they behave like Supabase's when a JWT is present and return null otherwise.

do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

-- Supabase's default privileges, so the ACLs schema.sql ends with match a Supabase project.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
