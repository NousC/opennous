-- GET-1122: what operators give people and their agents, and the log of every change to it.
create table if not exists public.workspace_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('skill', 'pin')),
  title text not null,
  body text not null,
  target_user_id uuid,           -- one person
  target_role text,              -- or a GTM role; neither means everyone
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workspace_assignments_ws_idx on public.workspace_assignments (workspace_id, status);

create table if not exists public.workspace_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  action text not null,
  subject text not null,
  audience text,
  assignment_id uuid,
  before jsonb,
  after jsonb,
  actor_user_id uuid,
  rolled_back_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists workspace_changes_ws_idx on public.workspace_changes (workspace_id, created_at desc);

create table if not exists public.workspace_desk_seen (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

alter table public.workspace_assignments enable row level security;
alter table public.workspace_changes enable row level security;
alter table public.workspace_desk_seen enable row level security;
