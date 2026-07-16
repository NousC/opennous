-- CRM hygiene — a scheduled routine that keeps the CRM reconciled with the
-- customer graph: fill gaps, refresh stale fields (with proof), enrich and score
-- net-new records, and back-fill milestone history. v1 is PROPOSE-ONLY — it
-- writes proposals here, never to the CRM, until a human approves.
--
-- Source-of-truth rule encoded by the engine (not the schema): Nous proposes a
-- change only when it holds an evidence-backed claim for that field; if we don't
-- know it, we never touch it. Every proposal carries its evidence.

-- Per-connection hygiene settings.
ALTER TABLE crm_sync_configs
  ADD COLUMN IF NOT EXISTS hygiene_enabled    BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS hygiene_cadence    TEXT        NOT NULL DEFAULT 'weekly',
  ADD COLUMN IF NOT EXISTS hygiene_last_run_at TIMESTAMPTZ,
  -- Forward-compat for Phase 2 auto-apply. v1 stays 'off' = propose-only.
  ADD COLUMN IF NOT EXISTS hygiene_auto_apply TEXT        NOT NULL DEFAULT 'off';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_sync_configs_hygiene_cadence_chk') THEN
    ALTER TABLE crm_sync_configs ADD CONSTRAINT crm_sync_configs_hygiene_cadence_chk
      CHECK (hygiene_cadence IN ('weekly', 'monthly'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_sync_configs_hygiene_auto_apply_chk') THEN
    ALTER TABLE crm_sync_configs ADD CONSTRAINT crm_sync_configs_hygiene_auto_apply_chk
      CHECK (hygiene_auto_apply IN ('off', 'safe', 'all'));
  END IF;
END $$;

-- One proposed change per row. The hygiene report reads these; approving one
-- flips status to 'approved' (Phase 2 applies it to the CRM and sets 'applied').
CREATE TABLE IF NOT EXISTS crm_hygiene_proposals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id         UUID,                       -- ties a batch to its worker_runs row
  provider       TEXT NOT NULL,
  entity_id      UUID,                        -- our entity/contact (null only for unmatched CRM rows)
  crm_record_id  TEXT,                        -- the CRM's record id (null for a net-new we're absorbing)
  kind           TEXT NOT NULL,               -- field_fill | field_update | conflict | net_new | icp_rescore | milestone_sync
  field          TEXT,                        -- CRM field this proposal targets (null for net_new / milestone)
  current_value  JSONB,                       -- what the CRM holds now
  proposed_value JSONB,                       -- what we'd write
  evidence       JSONB,                       -- {claim_id, source, confidence, freshness, epistemic_class, observed_at}
  confidence     NUMERIC,                     -- 0..1, for ranking + Phase 2 auto-apply gating
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'proposed',  -- proposed | approved | applied | dismissed | failed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_hygiene_kind_chk   CHECK (kind   IN ('field_fill', 'field_update', 'conflict', 'net_new', 'icp_rescore', 'milestone_sync')),
  CONSTRAINT crm_hygiene_status_chk CHECK (status IN ('proposed', 'approved', 'applied', 'dismissed', 'failed'))
);

CREATE INDEX IF NOT EXISTS crm_hygiene_proposals_ws_status_idx ON crm_hygiene_proposals (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS crm_hygiene_proposals_run_idx       ON crm_hygiene_proposals (run_id);

ALTER TABLE crm_hygiene_proposals ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'chp_all' AND tablename = 'crm_hygiene_proposals') THEN
    CREATE POLICY chp_all ON crm_hygiene_proposals FOR ALL USING (is_workspace_member(workspace_id));
  END IF;
END $$;

DROP TRIGGER IF EXISTS touch_crm_hygiene_proposals ON crm_hygiene_proposals;
CREATE TRIGGER touch_crm_hygiene_proposals BEFORE UPDATE ON crm_hygiene_proposals
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
