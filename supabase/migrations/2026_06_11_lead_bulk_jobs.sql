-- Async bulk enrich / verify jobs for lead lists.
--
-- Small selections run synchronously in the API request (instant). Large ones
-- are enqueued here and drained by the worker (workers/bulkLeadJobs.mjs), which
-- processes the leads with bounded concurrency, advancing `processed` so the
-- frontend can show a live progress bar and let rows fill in as results land.
--
-- `lead_list_id` is a plain UUID (no FK) because `leads`/`lead_lists` are v2
-- VIEWs. `lead_ids` is the captured selection at enqueue time.
CREATE TABLE IF NOT EXISTS lead_bulk_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_list_id  UUID NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('enrich', 'verify')),
  provider      TEXT,                              -- chosen verifier; null = auto / enrich
  status        TEXT NOT NULL DEFAULT 'pending'    -- pending | running | complete | failed
                  CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  total         INT  NOT NULL DEFAULT 0,           -- leads to work through
  processed     INT  NOT NULL DEFAULT 0,           -- progress counter
  result        JSONB,                             -- final counts (deliverable/risky/… or enriched/…)
  lead_ids      UUID[] NOT NULL DEFAULT '{}',
  error         TEXT,
  created_by    UUID,
  locked_at     TIMESTAMPTZ,                        -- heartbeat so a long job isn't double-picked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

-- Worker pickup: pending first, then running jobs whose lock has gone stale.
CREATE INDEX IF NOT EXISTS lead_bulk_jobs_pickup
  ON lead_bulk_jobs(created_at) WHERE status IN ('pending', 'running');

-- Frontend: the latest job for a list (resume the progress bar on reload).
CREATE INDEX IF NOT EXISTS lead_bulk_jobs_list
  ON lead_bulk_jobs(lead_list_id, created_at DESC);
