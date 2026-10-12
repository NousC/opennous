-- Workspace-level account visibility toggle.
--
-- When true (the default), every member of the workspace sees all accounts — the
-- open, "one team" mode. When false, a member sees only the accounts they own or
-- are in touch with (their relationship_owner membership); owners and admins always
-- see everything. The founder/admin decides which mode the workspace runs in.
--
-- Applied to prod via MCP on 2026-08-06; this file is the tracked record.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS open_account_visibility boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.workspaces.open_account_visibility IS
  'When true (default), every workspace member sees all accounts. When false, members see only accounts they own / are in touch with; owners+admins always see all.';
