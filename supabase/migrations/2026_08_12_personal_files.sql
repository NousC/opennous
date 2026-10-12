-- The personal workspace — each member's private vault of markdown files, the
-- counterpart to the shared RevBox. A closed set of foundation folders (inbox,
-- thoughts, decisions, projects, briefs, content); the member cannot add or delete
-- folders. Phase 1 is Nous-native (source = human/agent); Phase 2/3 add Git + local
-- sync, where the connected source becomes canonical and these rows are the mirror.
-- Private to (workspace_id, user_id) — other members and their agents cannot read it.
create table if not exists public.personal_files (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null,
  -- Foundation folders only. Enforced here so no other folder can ever be synced.
  folder       text not null check (folder in ('inbox','thoughts','decisions','projects','briefs','content')),
  -- Optional one level of nesting (briefs → account-briefs | meeting-briefs).
  subfolder    text,
  name         text not null,
  content      text not null default '',
  -- Who wrote it. 'agent' rows land in inbox and wait for human approval.
  source       text not null default 'human' check (source in ('human','agent','git','local')),
  -- Sync lifecycle. local_only = exists in Nous, not yet pushed to a connected source.
  status       text not null default 'local_only' check (status in ('synced','inbox_pending','conflict','local_only')),
  git_sha      text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists personal_files_ws_user_folder_idx
  on public.personal_files (workspace_id, user_id, folder, subfolder);

comment on table public.personal_files is
  'Per-member private vault of markdown files (personal workspace). Closed set of foundation folders; the connected Git/local source is canonical once linked, these rows are the mirror. Never shared across members.';

-- Private per-member data. Only the API (service role, which bypasses RLS) reads/writes
-- it, scoped by (workspace_id, user_id); RLS-on with no policy blocks any anon/authenticated
-- PostgREST access, so a leaked anon key can't read another member's vault.
alter table public.personal_files enable row level security;

-- Source config for a member''s personal workspace (Phase 2/3: github | local | none).
create table if not exists public.personal_workspaces (
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  user_id        uuid not null,
  source_type    text not null default 'none' check (source_type in ('none','github','local')),
  github_repo    text,
  github_branch  text,
  base_path      text,
  local_label    text,
  last_synced_at timestamptz,
  sync_status    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.personal_workspaces is
  'Per-member personal-workspace source config: none (Nous-native), github (repo+branch+path), or local (paired via the CLI daemon). The connected source is canonical.';

alter table public.personal_workspaces enable row level security;
