-- Ops-limit enforcement — the grace clock.
--
-- When a team crosses its monthly GTM-ops allowance we DON'T hard-block. We give
-- a 3-day grace window (everything keeps working), and only after it expires —
-- if they still haven't upgraded — do we restrict the ACTIVE surfaces (agent/MCP
-- calls, scans, enrich, campaign pushes). Inbound ingest (webhooks, pollers) is
-- never blocked, so no GTM signal is ever lost.
--
-- All the state we need to persist is ONE timestamp per team: when they first
-- went over this period. Everything else (ok / 80%-warn / grace / restricted) is
-- derived from live usage + this clock in code (see plans.mjs getTeamOpsState).
-- A dedicated table (not a subscriptions column) so it works for every team,
-- including free teams that may not have a subscriptions row yet.

CREATE TABLE IF NOT EXISTS team_ops_grace (
  team_id          uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  -- NULL = not over the limit. Set the moment usage first crosses the allowance;
  -- cleared automatically when usage drops back under (e.g. new billing period).
  grace_started_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Backend-only table (service role). Enable RLS with no policies so it is never
-- readable/writable via the anon/auth client, matching the other internal tables.
ALTER TABLE team_ops_grace ENABLE ROW LEVEL SECURITY;
