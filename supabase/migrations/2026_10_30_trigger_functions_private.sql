-- Trigger functions are not an API. These three kept the default EXECUTE grant, so anon and
-- authenticated could hold it; only the service role and the trigger itself need them.
-- Idempotent.
BEGIN;

REVOKE ALL ON FUNCTION public.agent_routines_version_keep() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_signals_from_claims() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_links_follow_claim() FROM PUBLIC, anon, authenticated;

COMMIT;
