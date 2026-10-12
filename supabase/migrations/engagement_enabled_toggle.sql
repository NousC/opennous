-- LinkedIn Engagers: per-workspace on/off toggle for the weekly engagement scrape.
-- Default true so every already-connected workspace keeps its current behavior;
-- the worker skips a workspace when this is false. Surfaced in the Lists page
-- "manage" panel for the LinkedIn Engagers list.
ALTER TABLE workspace_linkedin_connections
  ADD COLUMN IF NOT EXISTS engagement_enabled BOOLEAN NOT NULL DEFAULT true;
