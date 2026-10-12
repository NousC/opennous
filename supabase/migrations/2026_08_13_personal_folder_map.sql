-- Folder mapping for the personal vault's GitHub sync.
--
-- Until now a connected repo had to have its files under literal top-level folders
-- named inbox/thoughts/decisions/projects/briefs/content/company (optionally under a
-- single base_path). Real repos don't look like that — a member's content might live
-- at people/theo/content, their decisions at decisions/, their company context at
-- context/nous. folder_map lets each vault folder be SOURCED from any path in the repo:
--
--   { "content": "notes/people/theo/content", "decisions": "notes/decisions", ... }
--
-- Keys are the seven foundation folders; values are repo paths (relative to the repo
-- root). Files under a mapped path — and their subfolders — mirror into that vault
-- folder. An empty map falls back to the old base_path behaviour, so existing
-- connections are unaffected.

alter table public.personal_workspaces
  add column if not exists folder_map jsonb not null default '{}'::jsonb;
