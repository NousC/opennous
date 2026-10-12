-- Workspace.website surfaces the company URL the founder entered during
-- onboarding so the Settings → Team page can read + edit it the same way
-- it edits the workspace name. Without it the URL only lived as a note,
-- which Settings has no UI to fetch back.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS website TEXT;
