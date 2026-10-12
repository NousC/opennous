-- Security hardening — lock the Phase 4 functions to trusted server-side callers.
--
-- Supabase grants anon/authenticated EXECUTE on functions by default. visible_observations()
-- trusts an is_admin PARAMETER (the app passes the value it derived from auth), so if anon can
-- execute it they pass is_admin=true and read any member's private observations — bypassing the
-- very RLS the function exists to enforce. traverse_graph() would likewise expose the private
-- relationship graph. The app calls both as service_role, which is unaffected by this revoke.
--
-- This is a targeted fix for the two functions this repo added; the broader posture (blanket
-- anon/authenticated grants + 35 RLS-disabled tables) is tracked separately in the security audit.

revoke execute on function public.visible_observations(uuid, uuid, uuid, boolean, text, text, timestamptz, integer) from anon, authenticated, public;
revoke execute on function public.traverse_graph(uuid, uuid, integer, text[]) from anon, authenticated, public;
