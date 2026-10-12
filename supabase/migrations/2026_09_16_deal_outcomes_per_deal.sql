-- One outcome row per DEAL, not per account (GET-270).
--
-- The ledger was unique on (workspace_id, entity_id, closed_at) where entity_id is the ACCOUNT.
-- Two CRM deals at one account closing on the same date (HubSpot close dates are often
-- date-only) collided: inside one upsert batch Postgres raised "cannot affect row a second time"
-- and the whole rebuild aborted; across batches the last write silently replaced the other deal.
--
-- `outcome_key` is the deal's id when the row came from a CRM deal, and the account's id for a
-- stage-derived row (a workspace with no CRM deals), so both paths keep one row per real outcome.
-- entity_id stays the account, so every reader that joins outcomes to account activity is unchanged.
--
-- Safe to run more than once.

ALTER TABLE public.deal_outcomes ADD COLUMN IF NOT EXISTS deal_id uuid;
ALTER TABLE public.deal_outcomes ADD COLUMN IF NOT EXISTS outcome_key text;
UPDATE public.deal_outcomes SET outcome_key = entity_id::text WHERE outcome_key IS NULL;
ALTER TABLE public.deal_outcomes ALTER COLUMN outcome_key SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_outcomes_workspace_id_entity_id_closed_at_key') THEN
    ALTER TABLE public.deal_outcomes DROP CONSTRAINT deal_outcomes_workspace_id_entity_id_closed_at_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_outcomes_workspace_outcome_key_closed_at_key') THEN
    ALTER TABLE public.deal_outcomes
      ADD CONSTRAINT deal_outcomes_workspace_outcome_key_closed_at_key UNIQUE (workspace_id, outcome_key, closed_at);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS deal_outcomes_workspace_entity_idx ON public.deal_outcomes (workspace_id, entity_id);
