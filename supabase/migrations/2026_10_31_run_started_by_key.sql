-- Which API key started a run, so that key can't approve it (GET-1062). Null for a run started by
-- a person or a trigger. A column, because a run's state is rewritten each time it pauses.
-- Public: the approvals route is open-source code. Idempotent.
BEGIN;

ALTER TABLE public.agent_routine_runs
  ADD COLUMN IF NOT EXISTS started_by_key uuid REFERENCES public.api_keys(id) ON DELETE SET NULL;

COMMIT;
