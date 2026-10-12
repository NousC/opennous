-- On-demand LinkedIn engagement scrape + last-scraped tracking.
--
-- Adds three columns to workspace_linkedin_connections so the weekly cron is no
-- longer the only way to mine engagers:
--   * last_engagement_scrape_at        — when this account was last scraped (cron
--                                         OR on-demand). Drives the "it's been 2
--                                         months, backfill that window" suggestion
--                                         and lets the UI show freshness.
--   * engagement_scrape_requested_days — a pending on-demand request: the window
--                                         (in days) the user asked to scrape now.
--                                         The worker poller picks up any row where
--                                         this is NOT NULL, runs it, then clears it.
--   * engagement_scrape_requested_at   — when that request was filed (for ordering
--                                         + staleness).
--
-- The Apify key moves to BYOK (per-workspace, stored in
-- workflow_provider_connections under the 'apify' provider). No schema change is
-- needed for that — the provider row is seeded at API boot (bootstrapProviders).

ALTER TABLE workspace_linkedin_connections
  ADD COLUMN IF NOT EXISTS last_engagement_scrape_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS engagement_scrape_requested_days INTEGER,
  ADD COLUMN IF NOT EXISTS engagement_scrape_requested_at   TIMESTAMPTZ;

-- Partial index so the worker's "any pending on-demand request?" poll (every
-- minute) stays cheap — it only ever scans rows with an open request.
CREATE INDEX IF NOT EXISTS wlc_engagement_request
  ON workspace_linkedin_connections (engagement_scrape_requested_at)
  WHERE engagement_scrape_requested_days IS NOT NULL;
