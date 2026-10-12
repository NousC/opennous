-- Company vault, part 2: mirror the founder's company git.
--
-- Decision (2026-08-20): the vault MIRRORS whatever the founder syncs from his company
-- repo — arbitrary top-level folders, each with its own ACL — and git is canonical (the
-- DB rows are a mirror). The canonical 4 folders (knowledge/policies/playbooks/decisions)
-- become just the default when no git is connected. So the closed folder CHECK has to go.

alter table public.company_files        drop constraint if exists company_files_folder_check;
alter table public.company_folder_policy drop constraint if exists company_folder_policy_folder_check;

-- Guard against empty/path-y folder names without pinning to a fixed set.
alter table public.company_files
  add constraint company_files_folder_nonempty check (length(trim(folder)) > 0 and folder not like '%/%');
alter table public.company_folder_policy
  add constraint company_folder_policy_folder_nonempty check (length(trim(folder)) > 0 and folder not like '%/%');

-- The company vault's git source config — the workspace-scoped counterpart to
-- personal_workspaces. Always a git repo (never a local daemon) so the company vault is
-- reachable server-side for agents. base_path scopes to a subtree; the mirror ingest
-- takes each top-level dir under it as a folder.
create table if not exists public.company_workspaces (
  workspace_id     uuid primary key references public.workspaces(id) on delete cascade,
  source_type      text not null default 'none' check (source_type in ('none','github')),
  github_repo      text,
  github_branch    text default 'main',
  github_token_enc text,                 -- encrypted PAT (providers/crypto.mjs); never returned
  base_path        text,                 -- subtree to mirror ('' or null = whole repo)
  webhook_id       bigint,               -- GitHub webhook id (Layer-B auto-sync, §5b)
  webhook_secret   text,
  last_synced_at   timestamptz,
  last_synced_via  text,                 -- 'manual' | 'webhook' | 'poll'
  sync_status      text,
  connected_by     uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.company_workspaces is
  'Company vault git source config (workspace-scoped). github only (no local daemon at company scope). The connected repo is canonical; company_files rows are the mirror. base_path scopes the subtree; the mirror ingest maps each top-level dir under it to a folder.';

alter table public.company_workspaces enable row level security;

-- git_sha already exists on company_files (from part 1); the mirror ingest uses it to
-- diff the repo tree against the mirror (add / update / delete), same as personal_files.
