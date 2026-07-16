-- The Mind — prediction/outcome ledger (Phase 1).
--
-- Background: Nous's memory layer is passive — `scoreICP()` reads ICP memories
-- and writes a score, but nothing ever records what the system predicted so it
-- can later be compared to what actually happened. Without that join there is
-- nothing for a judge to learn from.
--
-- This table is the ledger. One row is written per scored contact per scoring
-- run, capturing the prediction (score, fit, reasoning) AND the exact
-- `workspace_memories` versions that produced it (`basis_memory_ids`) — so a
-- later judge can attribute bad predictions to specific ICP memory versions.
-- The `outcome_*` columns are filled in later by a separate worker job that
-- derives the realized outcome (reply / pipeline advance / closed-won) from
-- `contact_activity_log`.
--
-- No RLS: like `webhook_inbox`, this is a service-role table — the worker and
-- API write it, the API enforces workspace scope on every read.
--
-- See docs/compound-intelligence-mind.md for the full design.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS mind_episodes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES contacts(id)  ON DELETE SET NULL,
  company_id    UUID        REFERENCES companies(id) ON DELETE SET NULL,

  -- ── The prediction (snapshot at scoring time — never mutated) ──────────────
  kind              TEXT        NOT NULL DEFAULT 'icp_score',  -- 'icp_score' | 'goal_step' | …
  predicted_score   INT,
  predicted_fit     BOOLEAN,
  predicted_reason  TEXT,
  basis_memory_ids  UUID[]      NOT NULL DEFAULT '{}',         -- workspace_memories versions used
  model             TEXT,
  predicted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── The realized outcome (filled in later by the outcome job) ─────────────
  outcome_replied       BOOLEAN,
  outcome_pipeline_from TEXT,
  outcome_pipeline_to   TEXT,
  outcome_revenue       NUMERIC,
  outcome_score         NUMERIC,                  -- weighted 0..1
  outcome_resolved_at   TIMESTAMPTZ,              -- NULL = still open
  outcome_window_days   INT         NOT NULL DEFAULT 30,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outcome job scan: open episodes, oldest first.
CREATE INDEX IF NOT EXISTS mind_episodes_open
  ON mind_episodes(workspace_id, predicted_at)
  WHERE outcome_resolved_at IS NULL;

-- Judge / calibration-metric scan: resolved episodes.
CREATE INDEX IF NOT EXISTS mind_episodes_resolved
  ON mind_episodes(workspace_id, outcome_resolved_at)
  WHERE outcome_resolved_at IS NOT NULL;

-- Per-contact lookup (UI: an episode's history for a contact).
CREATE INDEX IF NOT EXISTS mind_episodes_contact
  ON mind_episodes(contact_id) WHERE contact_id IS NOT NULL;
