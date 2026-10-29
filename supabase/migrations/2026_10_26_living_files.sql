-- Living context files (GET-1039, GET-1040): context files OpenNous writes and keeps current from what
-- happens in the workspace, turned on per workspace and per file: win/loss (every deal that closes),
-- battlecards (every competitor mention) and the objection playbook (every objection raised). Each
-- update is a version authored by OpenNous with a one-line changelog and, with a repo connected
-- (GET-1037), a commit. cursor_at is the last close or mention it has read.
-- Service role only. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_living_files (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('win_loss', 'battlecards', 'objections')),
  file_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  cursor_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  enabled_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
ALTER TABLE public.workspace_living_files ENABLE ROW LEVEL SECURITY;

COMMIT;

NOTIFY pgrst, 'reload schema';
