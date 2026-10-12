-- Worker run log — transparency for the Intelligence page.
--
-- One row per worker invocation. For per-workspace workers (mindOutcomes,
-- scorecardLoop, scoreEntities, crmSync, leadReplies, pipelineDecay) we write
-- one row per workspace per run. For system-wide workers (claimEngine,
-- embeddings) we write one row per cron tick with workspace_id = NULL.
--
-- The Intelligence page reads from this so the user can see, at a glance,
-- whether the compound-intelligence loop is actually running.
--
-- No RLS — service-role table. The API enforces workspace scope on reads.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS worker_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        REFERENCES workspaces(id) ON DELETE CASCADE,  -- NULL = system-wide
  worker        TEXT        NOT NULL,             -- 'mind_outcomes', 'scorecard_loop', 'claim_engine', etc.
  status        TEXT        NOT NULL,             -- 'success' | 'error' | 'no_op'
  summary       TEXT,                             -- one-line human-readable summary
  details       JSONB       NOT NULL DEFAULT '{}',
  error         TEXT,
  duration_ms   INT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_runs_workspace
  ON worker_runs(workspace_id, finished_at DESC);

CREATE INDEX IF NOT EXISTS worker_runs_worker
  ON worker_runs(worker, finished_at DESC);

CREATE INDEX IF NOT EXISTS worker_runs_finished
  ON worker_runs(finished_at DESC);
