-- Per-member notification preferences.
--
-- Like the agent profile, notification settings are scoped to (workspace, member):
-- the same person can want the weekly Revenue Report loud in their own workspace
-- and quiet in a client's. Stored as JSON so we can add channels/categories
-- without another migration.
--
-- NULL means "never set" — the frontend falls back to its own defaults, so an
-- existing member reads as all-on until they turn something off.

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB;

COMMENT ON COLUMN workspace_members.notification_prefs IS
  'Per-member notification preferences (daily digest + per-category email/app toggles). Shape owned by the frontend Settings → Notifications section; NULL = use defaults.';
