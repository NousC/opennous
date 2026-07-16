-- Records-limit enforcement — the grace clock (stock-meter twin of team_ops_grace).
--
-- Records = unique people + companies a team holds in the entity graph. When a
-- team crosses its plan's records allowance we DON'T hard-block. We give a 3-day
-- grace window (everything keeps working), and only after it expires — if they
-- still haven't upgraded or pruned — do we restrict PROACTIVE record creation
-- (lead-list imports, scraper enqueue, bulk adds). Organic ingest (webhooks,
-- pollers, the CRM-sync worker) is NEVER blocked, so no GTM signal is ever lost.
--
-- Like team_ops_grace, all we persist is ONE timestamp per team: when they first
-- went over. ok / 80%-warn / grace / restricted is derived from live count + this
-- clock in code (see plans.mjs getTeamRecordsState). Records is a stock, not a
-- monthly flow, so "back under" happens by pruning or upgrading — the clock
-- clears automatically either way.

CREATE TABLE IF NOT EXISTS team_records_grace (
  team_id          uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  -- NULL = not over the limit. Set the moment the count first crosses the
  -- allowance; cleared automatically when the count drops back under (prune /
  -- upgrade).
  grace_started_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Backend-only table (service role). Enable RLS with no policies so it is never
-- readable/writable via the anon/auth client, matching team_ops_grace.
ALTER TABLE team_records_grace ENABLE ROW LEVEL SECURITY;
