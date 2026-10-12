-- Caps "Rebuild from your site" (the GTM Playbook site-read + AI draft) at a
-- lifetime 3 per workspace. Each rebuild runs an AI call, so this counter lets
-- the API enforce a hard cap that holds across devices and sessions.
-- Incremented in POST /api/mind/playbook/research; enforced there with a 429.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS playbook_rebuild_count INTEGER NOT NULL DEFAULT 0;
