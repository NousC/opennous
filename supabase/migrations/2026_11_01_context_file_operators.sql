-- GET-1117: a file in Documents can be shared with operators (workspace owners and admins), and a
-- pushed document has a folder.
ALTER TABLE public.workspace_context_files ADD COLUMN IF NOT EXISTS folder text;
ALTER TABLE public.workspace_context_files DROP CONSTRAINT IF EXISTS workspace_context_files_visibility_check;
ALTER TABLE public.workspace_context_files ADD CONSTRAINT workspace_context_files_visibility_check
  CHECK (visibility = ANY (ARRAY['boxes'::text, 'workspace'::text, 'operators'::text]));
ALTER TABLE public.workspace_context_files DROP CONSTRAINT IF EXISTS workspace_context_files_visibility_before_icp_check;
ALTER TABLE public.workspace_context_files ADD CONSTRAINT workspace_context_files_visibility_before_icp_check
  CHECK (visibility_before_icp = ANY (ARRAY['boxes'::text, 'workspace'::text, 'operators'::text]));
