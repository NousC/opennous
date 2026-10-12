-- The CRM agent: the human-in-the-loop half of the multi-deal model.
--
-- Three additions, all additive and all default-off:
--
--   crm_sync_configs.baseline_completed_at   The cutover. Set once, when a CRM's first full
--       sync finishes. Everything before it is the CRM's own state taken on trust (mirrored,
--       never questioned); everything after it goes through the agent. This is what stops a
--       year of already-tagged history arriving as hundreds of questions.
--
--   crm_sync_configs.crm_agent_enabled        Per-workspace switch for the agent's proposals.
--       Default false, so no existing workspace changes behaviour when this ships.
--
--   ri_decisions.payload                      Structured proposal data the one-line `proposal`
--       cannot carry: the candidate deals with their evidence, the activity in question,
--       and, once answered, the chosen deal(s). The decision loop's existing verdict /
--       status columns are reused as-is.
--
-- Safe to run more than once: every statement is guarded.

ALTER TABLE public.crm_sync_configs ADD COLUMN IF NOT EXISTS baseline_completed_at timestamp with time zone;
ALTER TABLE public.crm_sync_configs ADD COLUMN IF NOT EXISTS crm_agent_enabled boolean DEFAULT false NOT NULL;

ALTER TABLE public.ri_decisions ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb NOT NULL;

-- The agent's queue read: pending proposals for a workspace, newest first, by category.
CREATE INDEX IF NOT EXISTS ri_decisions_ws_category_pending_idx
  ON public.ri_decisions (workspace_id, category, created_at DESC)
  WHERE verdict = 'pending';
