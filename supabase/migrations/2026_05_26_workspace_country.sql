-- ─────────────────────────────────────────────────────────────────────────────
-- Add ISO 3166-1 alpha-2 country code to workspaces for the public /live
-- dashboard's "activity by region" map. Captured server-side from the
-- requester's IP at workspace-creation time, then backfilled lazily on
-- /api/me for existing workspaces.
--
-- Nullable on purpose: not every workspace will have a known country
-- (e.g. self-hosted, VPN, geo lookup failure). The /live snapshot just
-- counts rows that have a country and ignores the rest.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS country VARCHAR(2);

-- Partial index — only indexes rows with a country, keeping the index tiny
-- and the snapshot's GROUP BY country query fast.
CREATE INDEX IF NOT EXISTS workspaces_country_idx
  ON workspaces (country)
  WHERE country IS NOT NULL;
