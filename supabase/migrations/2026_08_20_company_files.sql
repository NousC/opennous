-- The company vault — the workspace's shared, declared knowledge, the company-scoped
-- counterpart to per-member personal_files. Where personal_files is private to
-- (workspace_id, user_id), this is one shared vault per workspace: the declared
-- knowledge base, policies, playbooks, and decisions. (ICP / positioning / pricing
-- keep their own home in `foundations` and their own surfaces — deliberately not
-- mirrored here.)
--
-- A closed set of folders (the `company/` namespace from the vault redesign) — a
-- member cannot add or delete folders. Reads are open to the workspace; writes are
-- admin-only (enforced in the route). Declared knowledge is CANONICAL, so a file is
-- governed and versioned (version + content_hash), mirroring the `foundations`
-- pattern — not a fuzzy RAG chunk. Retrieval/embedding (v2) layers on top.
create table if not exists public.company_files (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The company/ declared-knowledge folders. Closed set, enforced here.
  folder       text not null check (folder in ('knowledge','policies','playbooks','decisions')),
  -- Optional one level of nesting (e.g. playbooks → outbound | onboarding).
  subfolder    text,
  name         text not null,
  content      text not null default '',
  -- Evidence-level permission — the AUDIENCE axis. company = the whole workspace;
  -- admins = owners/admins only. NULL means "inherit the folder policy" (below);
  -- a non-null value is a per-file override. (Department + named-user ACL is v2.)
  visibility   text check (visibility in ('company','admins')),
  -- The AGENTS axis, separate from the human audience: may the workspace's agents
  -- read this file. NULL = inherit the folder policy; a non-null value overrides.
  -- v2 wires this into rawVisible so agent retrieval is physically gated by it.
  agents_can_read boolean,
  -- Governed + versioned, like foundations. content_hash = drift/verify; version bumps on edit.
  version      integer not null default 1,
  content_hash text,
  -- Who wrote it. 'agent' rows are proposals awaiting approval (parity with the
  -- personal-vault inbox); 'human' = authored by an admin; 'git' = synced from a repo.
  source       text not null default 'human' check (source in ('human','agent','git')),
  status       text not null default 'live' check (status in ('live','inbox_pending')),
  git_sha      text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists company_files_ws_folder_idx
  on public.company_files (workspace_id, folder, subfolder);

comment on table public.company_files is
  'Per-workspace shared company vault (knowledge / policies / playbooks / decisions). Closed folder set; reads open to the workspace, writes admin-only. Governed + versioned (like foundations). visibility (audience) + agents_can_read are per-file ACL OVERRIDES — NULL means inherit company_folder_policy. rawVisible reads them in v2.';

-- The folder-level ACL DEFAULT that files inherit when their own visibility /
-- agents_can_read is null. The redesign's "folder inherits down; file can override"
-- and the company-brain references' source-derived ACL: set the policy once on the
-- folder, let files ride it, override only the exceptions. This row is exactly what
-- the step-#1 governance "Agents can read" folder toggle writes.
create table if not exists public.company_folder_policy (
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  folder          text not null check (folder in ('knowledge','policies','playbooks','decisions')),
  visibility      text not null default 'company' check (visibility in ('company','admins')),
  agents_can_read boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  primary key (workspace_id, folder)
);

comment on table public.company_folder_policy is
  'Per-(workspace, folder) ACL default for the company vault. Files inherit it unless they override (company_files.visibility / agents_can_read non-null). The "Agents can read" folder toggle writes here.';

-- Shared per-workspace data, but only the API (service role, which bypasses RLS)
-- reads/writes it, scoped by workspace_id. RLS-on with no policy blocks any
-- anon/authenticated PostgREST access, so a leaked anon key cannot read the vault.
alter table public.company_files enable row level security;
alter table public.company_folder_policy enable row level security;
