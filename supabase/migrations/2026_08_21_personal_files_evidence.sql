-- Evidence layer — the raw conversations/emails/meetings an account or person has move
-- into the member's personal vault under new `accounts/` and `people/` folders (which
-- already sync to their git/local). Owner-private (RLS per workspace_id,user_id already).
-- Extracted CLAIMS are unchanged (their visibility stays the founder's open_account dial).
alter table public.personal_files drop constraint if exists personal_files_folder_check;
alter table public.personal_files add constraint personal_files_folder_check
  check (folder in ('inbox','thoughts','decisions','projects','briefs','content','company','accounts','people'));

-- 'sync' = Nous wrote it automatically from a connector (not a human file, not an agent
-- proposal that waits in the inbox) — it's filed straight away and pushes to the repo.
alter table public.personal_files drop constraint if exists personal_files_source_check;
alter table public.personal_files add constraint personal_files_source_check
  check (source in ('human','agent','git','local','sync'));

-- Idempotent dedup for connector-written evidence: (source, external_id) matches the
-- observations index, so re-running the backfill updates the same file, never dupes.
alter table public.personal_files add column if not exists external_id text;
create index if not exists personal_files_ws_user_extid_idx
  on public.personal_files (workspace_id, user_id, external_id) where external_id is not null;

-- Evidence files carry a content_hash (drift/verify), like company_files. The
-- personal_files table predates it, so add it (the evidence writer stamps it).
alter table public.personal_files add column if not exists content_hash text;
