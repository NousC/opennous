-- The Scorecard — Adaptive Lead Scoring, Phase 4b.
--
-- The Scorecard is how a lead becomes a number: a short list of weighted
-- signals. A lead's score is the sum of the weights of every signal whose
-- `rule` fires on its feature snapshot, rescaled 0–100 — plain arithmetic, no
-- model call per lead, fully decomposable.
--
-- `scorecard_runs` records each pass of the learning loop (Phase 4c). Seed
-- signals translated from the plain-English ICP have `added_in = NULL`.
--
-- No RLS: service-role tables — the API enforces workspace scope on reads.
--
-- See docs/adaptive-lead-scoring.md. Safe to re-run.

-- One row per learning-loop run (Phase 4c). Created first — signals FK it.
CREATE TABLE IF NOT EXISTS scorecard_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target        NUMERIC,                       -- calibration-gap target for the run
  steps         INT         NOT NULL DEFAULT 0,
  gap_before    NUMERIC,
  gap_after     NUMERIC,
  signal_count  INT,
  note          TEXT,                          -- one-line summary of what it found
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scorecard_runs_workspace
  ON scorecard_runs(workspace_id, created_at DESC);

-- The Scorecard itself — one row per weighted signal.
CREATE TABLE IF NOT EXISTS scorecard_signals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT        NOT NULL,            -- 'recent_funding', 'role_inbox'
  label        TEXT        NOT NULL,            -- a plain sentence a human can read
  weight       INT         NOT NULL DEFAULT 0,  -- ± score contribution
  rule         JSONB       NOT NULL DEFAULT '{}',  -- { feature, op, value }
  coverage     INT         NOT NULL DEFAULT 0,  -- leads it fired on (recomputed each run)
  added_in     UUID        REFERENCES scorecard_runs(id) ON DELETE SET NULL,  -- NULL = seed
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS scorecard_signals_workspace
  ON scorecard_signals(workspace_id, active);

DROP TRIGGER IF EXISTS scorecard_signals_updated_at ON scorecard_signals;
CREATE TRIGGER scorecard_signals_updated_at
  BEFORE UPDATE ON scorecard_signals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
