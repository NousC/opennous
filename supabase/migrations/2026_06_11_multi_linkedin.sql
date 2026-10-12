-- Multi-account foundation, Phase 1 — allow N LinkedIn accounts per workspace.
--
-- Until now workspace_linkedin_connections had UNIQUE (workspace_id), capping a
-- workspace at one connected LinkedIn account. A GTM agency runs several reps in
-- one workspace (shared, deduped graph), each with their own LinkedIn — so we
-- lift the cap. The plan's linkedinProfiles limit (Pro 1, Growth 5, …) is enforced
-- in code at connect time (access.mjs checkLinkedinSlot), not by the schema.
--
-- A given LinkedIn account still maps to one row per workspace (re-connecting
-- updates in place), so the uniqueness moves to (workspace_id, unipile_account_id).

ALTER TABLE workspace_linkedin_connections
  DROP CONSTRAINT IF EXISTS workspace_linkedin_connections_workspace_id_key;

-- The old UNIQUE created an implicit index on (workspace_id); keep an explicit one
-- for the per-workspace lookups the readers do.
CREATE INDEX IF NOT EXISTS wlc_workspace ON workspace_linkedin_connections(workspace_id);

-- Re-connecting the same account updates its row instead of inserting a duplicate.
ALTER TABLE workspace_linkedin_connections
  ADD CONSTRAINT workspace_linkedin_connections_ws_account_key
  UNIQUE (workspace_id, unipile_account_id);

-- Per-account metadata so each connection can be labelled and owned by a rep.
ALTER TABLE workspace_linkedin_connections
  ADD COLUMN IF NOT EXISTS label         TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT true;
