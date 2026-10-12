-- Structured, per-insight store. Until now insights lived as markdown bullets inside
-- 4 fixed-category docs (public.insights), so an insight had no identity and nothing
-- could be attached to it. This table gives each insight a row: an id (→ status), a
-- source (external customer calls vs internal team calls), and a status lifecycle you
-- can drive. The markdown docs remain the Vault-editable mirror for external insights.
create table if not exists public.insight_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  -- 'external' = learned from a customer/prospect call; 'team' = an internal/co-founder call.
  source text not null default 'external' check (source in ('external','team')),
  -- external: product|positioning|market|buyer.  team: decisions|blockers|learnings.
  category text not null,
  statement text not null,
  quote text,
  speaker text,
  speaker_id uuid,
  occurred_at timestamptz,
  status text not null default 'new'
    check (status in ('new','tracked','roadmap','shipped','dismissed','acknowledged','addressed')),
  status_changed_at timestamptz,
  status_changed_by uuid,
  -- sha1(source|category|statement-stem) — one row per distinct insight per workspace.
  dedup_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, dedup_key)
);

create index if not exists insight_items_ws_source_cat_idx on public.insight_items (workspace_id, source, category);
create index if not exists insight_items_ws_status_idx on public.insight_items (workspace_id, status);

-- Served exclusively through the API's service-role client (same as public.insights).
alter table public.insight_items enable row level security;
