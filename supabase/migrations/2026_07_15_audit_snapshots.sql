-- Audit snapshots — the memory that makes the audit self-watching.
--
-- `nous audit` is a point-in-time command: it tells you what's broken NOW. To catch a
-- regression, something has to remember what was true last night. That is this table.
--
-- The nightly audit sweep (apps/worker/src/workers/auditSweep.mjs) writes one row per
-- workspace per run: the overall health, each check's score, and the set of finding
-- keys present. The next run diffs against the latest row to decide what's NEW — a
-- connector that just died, a check that just regressed — and only new breakage alerts.
-- Without this row, every night would either re-alert the same standing issues or alert
-- on nothing at all.
--
-- It also gives health a HISTORY: "resolved has been 100% for 90 days" is both a trust
-- signal and an early warning when it starts to slip.

CREATE TABLE IF NOT EXISTS workspace_audit_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The one number: the WORST check, not an average (a dead connector averaged against
  -- 98% freshness reads as comfortable and is a lie). 0-100.
  health        INTEGER NOT NULL,
  -- [{ key, pct }] per check, so the trend of any single check is queryable.
  checks        JSONB   NOT NULL DEFAULT '[]',
  -- Stable keys of the findings present at this run — the diff input for "what's new".
  finding_keys  TEXT[]  NOT NULL DEFAULT '{}',
  high_count    INTEGER NOT NULL DEFAULT 0,
  failing       INTEGER NOT NULL DEFAULT 0,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep's only read pattern: newest snapshot for a workspace.
CREATE INDEX IF NOT EXISTS idx_audit_snapshots_ws_time
  ON workspace_audit_snapshots(workspace_id, checked_at DESC);
