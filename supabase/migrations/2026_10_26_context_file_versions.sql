-- Versions of every context file (GET-1038). Each change to a file's title or text keeps the text it
-- now has as a version, with who wrote it (a person, OpenNous, or an edit pulled from the company
-- repo, GET-1037) and a one-line changelog. A file deleted later keeps its versions: no foreign key,
-- the history outlives the file. With a repo connected, git_sha is the commit the version became.
-- Service role only, like every context table. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_context_file_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL DEFAULT '',
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'opennous', 'repo')),
  author_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  author_name text,
  changelog text CHECK (changelog IS NULL OR length(changelog) <= 200),
  git_sha text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_context_file_versions_file
  ON public.workspace_context_file_versions(workspace_id, file_id, created_at DESC);
ALTER TABLE public.workspace_context_file_versions ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
