-- Privileges match prod (read from prod's catalog, read-only, 2026-10-07).
-- On prod, anon and authenticated hold no privilege on any table or view in public, and no
-- EXECUTE on any SECURITY DEFINER function. Every read and write goes through the API with the
-- service role; the frontend never queries PostgREST as a user. The repo's migrations left
-- Supabase's default grants in place, so a fresh install was more open than prod. This closes it.
-- On prod it changes nothing except 7 invoker helper functions, which reach no table for these
-- roles anyway.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- And for objects later migrations create.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
