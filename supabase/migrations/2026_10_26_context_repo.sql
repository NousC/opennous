-- The company repo behind Settings > Context (GET-1037). A workspace connects one GitHub repo; every
-- context file shared with the workspace syncs both ways as <base_path>/<file>.md. An edit in the app
-- is committed (message: the version's change note, author: who wrote it, a person or OpenNous); an
-- edit in the repo is pulled back as a new version (author: the commit's). When both sides changed,
-- the latest edit wins and the other is kept as a version (Bennet, 2026-10-26).
-- The token is a fine-grained PAT with Contents read/write, encrypted by the API; never returned.
-- Service role only. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_context_repos (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  github_repo text NOT NULL,
  github_branch text NOT NULL DEFAULT 'main',
  base_path text NOT NULL DEFAULT 'context',
  github_token_enc text NOT NULL,
  webhook_id bigint,
  webhook_secret text,
  sync_token text UNIQUE,
  auto_sync boolean NOT NULL DEFAULT true,
  sync_status text NOT NULL DEFAULT 'idle',
  last_error text,
  last_synced_at timestamptz,
  last_synced_via text,
  last_polled_at timestamptz,
  connected_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.workspace_context_repos ENABLE ROW LEVEL SECURITY;

-- Where each file lives in the repo, and the blob it last matched.
ALTER TABLE public.workspace_context_files ADD COLUMN IF NOT EXISTS repo_path text;
ALTER TABLE public.workspace_context_files ADD COLUMN IF NOT EXISTS git_sha text;
ALTER TABLE public.workspace_context_files ADD COLUMN IF NOT EXISTS repo_synced_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_context_files_repo_path
  ON public.workspace_context_files(workspace_id, repo_path) WHERE repo_path IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
