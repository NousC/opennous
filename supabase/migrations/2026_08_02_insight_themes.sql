-- The synthesis layer. Hundreds of raw insights are noise; the ~10 recurring THEMES across
-- them are the signal. An LLM clusters insight_items into themes — each a pattern
-- stated as a claim, a takeaway (what it means + what to do), the member insight ids,
-- and a status you drive on the THEME (not on a hundred individual quotes).
create table if not exists public.insight_themes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  source text not null check (source in ('external','team')),
  category text,
  title text not null,
  takeaway text,
  item_ids uuid[] not null default '{}',
  item_count integer not null default 0,
  rank integer not null default 0,
  build_key text,
  status text not null default 'new'
    check (status in ('new','tracked','roadmap','shipped','dismissed','acknowledged','addressed')),
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists insight_themes_ws_source_idx on public.insight_themes (workspace_id, source, rank);
alter table public.insight_themes enable row level security;
