-- The About us file (GET-1036): Settings > Context's designated "who we are and what we have", beside
-- the ICP file. Kind 'about': at most one per workspace, always shared with the workspace, like 'icp'.
-- The API mirrors its text into the workspace's positioning foundation (apps/api lib/aboutContextFile.mjs).
-- Idempotent.
BEGIN;

ALTER TABLE public.workspace_context_files DROP CONSTRAINT IF EXISTS workspace_context_files_kind_check;
ALTER TABLE public.workspace_context_files
  ADD CONSTRAINT workspace_context_files_kind_check CHECK (kind IN ('reference', 'instructions', 'icp', 'about'));

ALTER TABLE public.workspace_context_files DROP CONSTRAINT IF EXISTS workspace_context_files_about_is_shared;
ALTER TABLE public.workspace_context_files
  ADD CONSTRAINT workspace_context_files_about_is_shared CHECK (kind <> 'about' OR visibility = 'workspace');

CREATE UNIQUE INDEX IF NOT EXISTS workspace_context_files_one_about
  ON public.workspace_context_files(workspace_id) WHERE kind = 'about';

COMMIT;

NOTIFY pgrst, 'reload schema';
