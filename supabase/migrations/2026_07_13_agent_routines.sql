-- Agent routines — work the agent does on a schedule, without being asked.
--
-- The Tasks page has two owners of work: a PERSON (commitments extracted from
-- calls: "you owe them the MVP") and the AGENT (routines: "review the pipeline
-- every Monday"). This table is the agent's half.
--
-- A routine is three things: a prompt (what to do), a trigger (when), and a
-- destination (a thread, so the result is a conversation you can continue rather
-- than a notification you dismiss).

CREATE TABLE IF NOT EXISTS agent_routines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Whose routine it is. Runs are attributed to this person, so Adoption shows
  -- scheduled work next to the work they did by hand.
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  name          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,

  -- 'clock'          — every Monday at 07:00
  -- 'before_meeting' — one hour before each call starts
  --
  -- These are genuinely different mechanisms, not one with a flag. A clock
  -- routine's next run is a pure function of the calendar arithmetic. A meeting
  -- routine's is a function of YOUR calendar, so the scheduler has to look at
  -- your upcoming meetings to know when to fire. Keeping them as distinct kinds
  -- keeps that honest instead of smuggling one into the other.
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('clock', 'before_meeting')),

  -- ── clock ──
  frequency     TEXT CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly')),
  at_time       TIME,                  -- local wall-clock time, e.g. 07:00
  day_of_week   SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday; weekly
  day_of_month  SMALLINT CHECK (day_of_month BETWEEN 1 AND 28), -- monthly/quarterly; 28 so every month has one
  -- IANA zone. "07:00" means nothing without it, and a founder in Berlin does not
  -- want a Monday briefing at 08:00 UTC in summer and 07:00 in winter.
  timezone      TEXT NOT NULL DEFAULT 'UTC',

  -- ── before_meeting ──
  -- Minutes before the meeting STARTS. 60 = an hour before, 1440 = the day before.
  offset_minutes INTEGER,

  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,           -- clock routines only; meeting runs are derived from the calendar
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Each kind must carry its own fields and not the other's.
  CONSTRAINT routine_shape CHECK (
    (trigger_kind = 'clock'          AND frequency IS NOT NULL AND at_time IS NOT NULL AND offset_minutes IS NULL)
    OR
    (trigger_kind = 'before_meeting' AND offset_minutes IS NOT NULL AND frequency IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_routines_workspace ON agent_routines(workspace_id) WHERE enabled;
-- The scheduler's hot path: "what is due?"
CREATE INDEX IF NOT EXISTS idx_routines_due ON agent_routines(next_run_at) WHERE enabled AND trigger_kind = 'clock';

-- ── Runs ────────────────────────────────────────────────────────────────────
-- One row per execution. Also the idempotency ledger: `dedupe_key` is what stops
-- a re-synced calendar entry from briefing you about the same call twice, and
-- stops a worker restart from re-running Monday's review.
CREATE TABLE IF NOT EXISTS agent_routine_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id    UUID NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The occurrence this run is FOR, not the moment it happened:
  --   clock          → 'clock|2026-07-13T07:00'   (the scheduled slot)
  --   before_meeting → 'meeting|<entity>|<start>' (the specific call)
  -- UNIQUE on it, so "did we already do this?" is a database guarantee rather
  -- than something the worker has to remember.
  dedupe_key    TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  thread_id     UUID REFERENCES playground_threads(id) ON DELETE SET NULL,
  entity_id     UUID,                  -- who the meeting was with, for a meeting brief
  error         TEXT,
  -- Unread until you open the thread. This drives the badge on Tasks.
  seen_at       TIMESTAMPTZ,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,

  CONSTRAINT uniq_run_per_occurrence UNIQUE (routine_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_runs_routine ON agent_routine_runs(routine_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_unseen  ON agent_routine_runs(workspace_id) WHERE seen_at IS NULL;
