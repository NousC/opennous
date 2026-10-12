-- api_request_log: members no longer read it directly (GET-620 review).
--
-- 2026_10_03_api_request_log.sql gave every workspace member SELECT on the whole log. The log
-- records every member's agent calls (route, target, client), while the API narrows a member to
-- the keys that act as them or that they minted (canSeeKey). Nothing in the frontend reads the
-- table directly: it goes through /api/keys/:id/* and /api/usage/by-key, which use the service
-- role. So the member policy only offered a way around that narrowing. With it dropped, RLS stays
-- on and only the service-role policy remains.
--
-- Additive-safe and idempotent. Rollback: re-run the CREATE POLICY from the original migration.

drop policy if exists "Members can read workspace api request log" on public.api_request_log;
