-- Intelligence v2, "edit, don't rewrite" (GET-1054). A living file is kept as a document of sections
-- and blocks with persistent ids, and each pass edits it with small operations instead of rewriting
-- it. doc is that structure, as OpenNous last wrote it: { sections: [{ id, heading, level, blocks:
-- [{ id, text }] }], rebuilt_at } (rebuilt_at: the last weekly whole-file rebuild). The body stays the
-- source people read and edit; when it differs from what doc renders to, it was hand-edited and is
-- re-parsed, keeping the ids of unchanged blocks. Each version OpenNous writes also records what it
-- read: based_on { deals: [...] } or { claims: [...] }.
-- Until this runs, the code works without both columns (ids derived from the body each pass, no
-- based_on). Service role only, like both tables. Idempotent.
BEGIN;

ALTER TABLE public.workspace_living_files ADD COLUMN IF NOT EXISTS doc jsonb;
ALTER TABLE public.workspace_context_file_versions ADD COLUMN IF NOT EXISTS based_on jsonb;

COMMIT;

NOTIFY pgrst, 'reload schema';
