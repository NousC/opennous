-- Phase 2: per-observation CRM push dedup
--
-- contact_activity_log carried a `pushed_to_crms` JSONB column tracking which
-- CRMs we'd already pushed each activity to (so retries don't double-post).
-- Observations are immutable, so we lift that state into a tiny side table
-- keyed by (observation_id, provider).

CREATE TABLE IF NOT EXISTS observation_crm_pushes (
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  engagement_id  TEXT NOT NULL,
  pushed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (observation_id, provider)
);

CREATE INDEX IF NOT EXISTS observation_crm_pushes_ws
  ON observation_crm_pushes(workspace_id);

ALTER TABLE observation_crm_pushes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ocp_select ON observation_crm_pushes;
CREATE POLICY ocp_select ON observation_crm_pushes
  FOR SELECT USING (is_workspace_member(workspace_id));
