-- Context library (GET-875): context is saved once for the workspace and TAGGED to RevBoxes, so the
-- same file serves several boxes. Before this, every reference was a revbox_context row on exactly
-- one box. Runs after 2026_10_14_revboxes.sql (it needs revboxes(id, workspace_id) and
-- revbox_context). One transaction: it applies whole or not at all. Idempotent: re-running it
-- creates nothing twice and adopts any revbox_context row written since the last run.
--
--   workspace_context_files  one piece of knowledge: text (body) or a linked document (document_id),
--                            a kind ('reference' | 'instructions' | 'icp') and a visibility:
--                              'boxes'     seen by the members of a box it is tagged to (and its
--                                          creator). Today's rule for a box's references.
--                              'workspace' seen by every workspace member.
--                            An ICP file is always 'workspace': it drives workspace-wide scores.
--   revbox_context_links     (revbox_id, context_file_id): which boxes a file is tagged to. A run
--                            reads ONLY the files linked to its box, whatever their visibility.
--
-- revbox_context is kept (no breaking drop in this release): every row is copied into a file with the
-- SAME id plus one link, so job snapshots that recorded context ids still name the same thing, and
-- the API reads the legacy rows next to the links until the table is retired.
-- Service role only, like every revbox table: access is checked by the server per box and file.
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

CREATE TABLE IF NOT EXISTS public.revbox_context_links (
  revbox_id uuid NOT NULL,
  context_file_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revbox_id, context_file_id),
  -- Both sides in the same workspace; deleting the box or the file drops the tag.
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (context_file_id, workspace_id) REFERENCES public.workspace_context_files(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS revbox_context_links_file
  ON public.revbox_context_links(workspace_id, context_file_id);

ALTER TABLE public.workspace_context_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_context_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_context_files, public.revbox_context_links FROM anon, authenticated;
GRANT ALL ON public.workspace_context_files, public.revbox_context_links TO service_role;

-- Backfill: one file per revbox_context row (same id, title, body, document, author, time; kind
-- 'reference', visibility 'boxes' = still private to that box) and one link to its box. A title like
-- "ICP.md" is NOT marked ICP: that stays an explicit choice in Settings > Context.
INSERT INTO public.workspace_context_files (id, workspace_id, title, kind, body, document_id, visibility, created_by, created_at, updated_at)
SELECT c.id, c.workspace_id, c.title, 'reference', c.body, c.document_id, 'boxes', c.created_by, c.created_at, c.created_at
FROM public.revbox_context c
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.revbox_context_links (revbox_id, context_file_id, workspace_id, created_by, created_at)
SELECT c.revbox_id, c.id, c.workspace_id, c.created_by, c.created_at
FROM public.revbox_context c
JOIN public.workspace_context_files f ON f.id = c.id AND f.workspace_id = c.workspace_id
ON CONFLICT (revbox_id, context_file_id) DO NOTHING;

COMMENT ON TABLE public.workspace_context_files IS
  'Workspace context library (GET-875): reference/instructions/ICP knowledge, tagged to RevBoxes through revbox_context_links. kind=icp (one per workspace, always visibility=workspace) is the file ICP scoring reads.';
COMMENT ON TABLE public.revbox_context_links IS
  'Which RevBoxes a workspace_context_files row is tagged to (GET-875). A box''s runs read only the files linked here.';
COMMENT ON TABLE public.revbox_context IS
  'LEGACY (GET-875): per-box references, copied into workspace_context_files + revbox_context_links by 2026_10_15_context_library.sql. Still read next to the links; new context is written to the library.';

COMMIT;
