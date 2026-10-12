-- Per-workspace extraction config: watch-topics that steer insight extraction, by
-- (source, category). Defaults seeded lazily + locked; workspace adds its own keywords.
create table if not exists public.insight_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source text not null check (source in ('external','team')),
  category text not null,
  keyword text not null,
  description text,
  enabled boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, source, category, keyword)
);
create index if not exists insight_topics_ws_idx on public.insight_topics (workspace_id, source, category);
alter table public.insight_topics enable row level security;
