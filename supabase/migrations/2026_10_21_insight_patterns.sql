-- The insight engine (GET-971): one row per insight, with one status, and the claims it rests on.
--
-- An insight is a group of claims (claims about us, and objections and competitors on the
-- accounts) of one type, built and counted by code (packages/core/src/db/insightEngine.ts) and
-- rebuilt hourly. `topic_key` is the group's identity across rebuilds; the model writes only
-- `title`. insight_items, insight_themes and the board are left as they are.
--
-- Safe to run more than once. Nothing here rewrites or drops a row.

create table if not exists public.insight_patterns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  topic_key text not null,
  type text not null,
  -- The fixed field it groups on, as most often said ("Date filter", a competitor's name).
  label text,
  title text,
  title_account_count integer,
  account_count integer not null default 0,
  people_count integer not null default 0,
  mention_count integer not null default 0,
  first_heard_at date,
  last_heard_at date,
  -- Accounts per week, the last 12 weeks, oldest first.
  weeks integer[] not null default '{}',
  recent_accounts integer not null default 0,
  prior_accounts integer not null default 0,
  rising boolean not null default false,
  at_bar boolean not null default false,
  emerged_at timestamptz,
  rising_at timestamptz,
  status text not null default 'new' check (status in ('new', 'seen', 'acting', 'done')),
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, topic_key)
);

create index if not exists insight_patterns_ws_bar_idx on public.insight_patterns (workspace_id, at_bar, account_count desc);

create table if not exists public.insight_pattern_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pattern_id uuid not null references public.insight_patterns(id) on delete cascade,
  source_table text not null check (source_table in ('about_us_claims', 'claims')),
  source_id uuid not null,
  company_id uuid,
  contact_id uuid,
  occurred_at timestamptz,
  primary key (pattern_id, source_table, source_id)
);

create index if not exists insight_pattern_members_ws_idx on public.insight_pattern_members (workspace_id);

-- Served through the service-role client only, as insight_items.
alter table public.insight_patterns enable row level security;
alter table public.insight_pattern_members enable row level security;
