-- 2026-06-26 — add the playbooks (policy layer) + reports tables.
-- These shipped to prod but were never back-ported to schema.sql, so fresh
-- self-host installs were missing them (get_playbook / sync_playbook and the
-- /playbooks + /reports pages would error). Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS playbooks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('voice','outreach','icp','positioning')),
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'nous' CHECK (source IN ('nous','claude_code')),
  file_path    TEXT,
  content_hash TEXT,
  version      INTEGER NOT NULL DEFAULT 1,
  synced_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind)
);
CREATE INDEX IF NOT EXISTS playbooks_workspace_idx ON playbooks(workspace_id);

CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  lead_list_id UUID,
  provider     TEXT,
  campaign_id  TEXT,
  title        TEXT NOT NULL,
  period_from  TIMESTAMPTZ,
  period_to    TIMESTAMPTZ,
  markdown     TEXT NOT NULL,
  metrics_json JSONB,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_ws_idx ON reports(workspace_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS reports_list_idx ON reports(lead_list_id, generated_at DESC);
