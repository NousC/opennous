-- Find people by phone number (GET-289).
--
-- A RingCentral call names the buyer by phone number and nothing else. Every contact the CRM
-- import brought in already carries a `phone` claim, in whatever format the CRM allowed:
-- "+1 (555) 123-4567", "555.123.4567", "15551234567". Those are one number, so the lookup compares
-- the LAST TEN DIGITS, and the index is on exactly that expression.
--
-- Scanning the `contacts` view instead is not an option: it computes every column with a
-- per-row subquery, so a phone filter over it evaluates the whole workspace.
--
-- Idempotent. Until this is applied the worker falls back to reading the workspace's phone claims
-- in pages, which is correct but slow on a CRM-sized workspace.

CREATE INDEX IF NOT EXISTS claims_phone_key
  ON public.claims (workspace_id, right(regexp_replace(value #>> '{}', '\D', '', 'g'), 10))
  WHERE invalid_at IS NULL AND property = 'phone';

CREATE OR REPLACE FUNCTION public.find_entities_by_phone(p_workspace_id uuid, p_phone_key text)
RETURNS TABLE (entity_id uuid)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.entity_id
    FROM public.claims c
   WHERE c.workspace_id = p_workspace_id
     AND c.property = 'phone'
     AND c.invalid_at IS NULL
     AND length(p_phone_key) = 10
     AND right(regexp_replace(c.value #>> '{}', '\D', '', 'g'), 10) = p_phone_key
   LIMIT 50;
$$;

-- Service role only: the worker calls it. Nothing in the browser should be able to ask
-- "who owns this number" across a workspace.
REVOKE ALL ON FUNCTION public.find_entities_by_phone(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_entities_by_phone(uuid, text) TO service_role;
