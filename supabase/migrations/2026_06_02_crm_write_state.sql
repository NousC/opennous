-- CRM hygiene echo suppression (Phase 2, Task C). Records what Nous WROTE to a
-- CRM so the next pull recognizes its own write and doesn't re-ingest it as a
-- fresh CRM-sourced observation (oscillation + noisy logs). One row per
-- (provider, record, field), upserted with the latest value; consumed (deleted)
-- when it's echoed back on a pull. Provider-agnostic — the pull normalizes every
-- CRM to the same shape, so the echo check is uniform. Only company/phone can
-- echo today (the pull doesn't read job_title or the nous_icp_* custom fields).

CREATE TABLE IF NOT EXISTS crm_write_state (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  crm_record_id TEXT NOT NULL,
  property      TEXT NOT NULL,
  value         JSONB,
  written_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider, crm_record_id, property)
);

CREATE INDEX IF NOT EXISTS crm_write_state_lookup_idx
  ON crm_write_state (workspace_id, provider, crm_record_id, property);

ALTER TABLE crm_write_state ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'cws_all' AND tablename = 'crm_write_state') THEN
    CREATE POLICY cws_all ON crm_write_state FOR ALL USING (is_workspace_member(workspace_id));
  END IF;
END $$;
