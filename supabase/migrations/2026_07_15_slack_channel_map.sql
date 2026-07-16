-- Slack bot: channel <-> account binding.
--
-- The one net-new concept for the in-channel bot. A team runs `/nous link acme.com`
-- in a deal channel; every @mention there then defaults to that account. account_ref
-- is a free-text focus (domain, name, email, or entity id) — whatever get_context
-- accepts — so linking needs no identity resolution up front.
--
-- The bot TOKEN itself is not here: it lives on the existing Slack row in
-- workflow_provider_connections (encrypted_credentials.bot_token), keyed by team_id.

CREATE TABLE IF NOT EXISTS slack_channel_map (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_team_id      TEXT NOT NULL,
  slack_channel_id   TEXT NOT NULL,
  slack_channel_name TEXT,
  account_ref        TEXT NOT NULL,          -- focus string: domain / name / email / entity id
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slack_channel_id)
);

CREATE INDEX IF NOT EXISTS scm_workspace ON slack_channel_map(workspace_id);
CREATE INDEX IF NOT EXISTS scm_channel   ON slack_channel_map(slack_channel_id);

ALTER TABLE slack_channel_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY scm_all ON slack_channel_map
  FOR ALL USING (is_workspace_member(workspace_id));

CREATE TRIGGER scm_touch BEFORE UPDATE ON slack_channel_map
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Fast tenant lookup: find the Slack connection by the team_id in its JSONB creds.
-- (Partial index scoped to the Slack provider's rows.)
CREATE INDEX IF NOT EXISTS wpc_slack_team
  ON workflow_provider_connections ((encrypted_credentials->>'slack_team_id'));
