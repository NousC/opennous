-- Context library (GET-875), Settings > Knowledge: context is saved once for the workspace. Open
-- source since 2026-10-29 (it was Cloud's, supabase/cloud/migrations/, with RevBoxes); the RevBox
-- side, which boxes a file is TAGGED to and the copy of the old per-box references, is Cloud's
-- 2026_10_15_context_library_links.sql. Idempotent. Production ran this file whole (with the links)
-- on 2026-10-15, so re-running it creates nothing.
--
--   workspace_context_files  one piece of knowledge: text (body) or a linked document (document_id),
--                            a kind ('reference' | 'instructions' | 'icp'; 'about' since
--                            2026_10_26_context_about_file.sql) and a visibility:
--                              'boxes'     its creator (and on Cloud, the members of a RevBox it is
--                                          tagged to). "Private" in the app.
--                              'workspace' seen by every workspace member.
--                            An ICP file is always 'workspace': it drives workspace-wide scores.
-- Service role only: access is checked by the server per file.
BEGIN;

CREATE TABLE IF NOT EXISTS public.workspace_context_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'reference' CHECK (kind IN ('reference', 'instructions', 'icp')),
  body text NOT NULL DEFAULT '' CHECK (octet_length(body) <= 262144),
  document_id uuid REFERENCES public.documents(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'boxes' CHECK (visibility IN ('boxes', 'workspace')),
  -- The visibility the file had before it was marked ICP; unmarking puts it back.
  visibility_before_icp text CHECK (visibility_before_icp IN ('boxes', 'workspace')),
  created_by uuid NOT NULL REFERENCES public.users(id),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  icp_marked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CONSTRAINT workspace_context_files_icp_is_shared CHECK (kind <> 'icp' OR visibility = 'workspace')
);
-- A database that ran an earlier draft of this file gets the column too.
ALTER TABLE public.workspace_context_files ADD COLUMN IF NOT EXISTS visibility_before_icp text CHECK (visibility_before_icp IN ('boxes', 'workspace'));
-- At most one ICP file per workspace: marking another one is a 409 until the first is unmarked.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_context_files_one_icp
  ON public.workspace_context_files(workspace_id) WHERE kind = 'icp';
CREATE INDEX IF NOT EXISTS workspace_context_files_ws
  ON public.workspace_context_files(workspace_id, updated_at DESC);

ALTER TABLE public.workspace_context_files ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_context_files FROM anon, authenticated;
GRANT ALL ON public.workspace_context_files TO service_role;

COMMENT ON TABLE public.workspace_context_files IS
  'Workspace context library (GET-875): reference/instructions/ICP knowledge. kind=icp (one per workspace, always visibility=workspace) is the file ICP scoring reads. On Cloud, tagged to RevBoxes through revbox_context_links.';

COMMIT;
