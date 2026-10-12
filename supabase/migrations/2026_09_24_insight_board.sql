-- The Insights board: every insight under exactly one team button, tagged, and tied to its account.
--
-- WHY. The Insights tab grouped insights into abstract themes ("Rollout stalls without a named owner
-- and a weekly check-in") under four categories (Product / Positioning / Market /
-- Buyer) that the extractor chose. On a large workspace, insights about one concrete subject were
-- spread over many buckets in all four categories, many insights sat in no theme at all, and
-- no insight could be traced to an account, so "how much pipeline is behind this" had no answer.
-- The ask was the opposite: group by the concrete thing (e-signature, bulk SMS), say who
-- has to act, and let the reader check the evidence.
--
-- WHAT. Three additions, nothing removed:
--   1. insight_items gains the board's placement: `subtype` (one of ten, see
--      packages/core/src/db/insightBoard.ts) and its `lane` (the team that acts), the concrete
--      `tag_ids` (main tag first), and the account the insight came from (`contact_id`,
--      `company_id`). `category` stays: other readers (the agent's market-read, /v2/insights) use it.
--   2. insight_tags — the workspace's own tag list (e-signature, CRM integration…). Proposed by the
--      model on the first run, meant to be edited by a person.
--   3. insight_rows — the nightly summary per (subtype, tag): a headline, the concrete problems
--      inside it, and the three clearest quotes. Written by the worker, read by the page.
--
-- Applied by hand (Management API), like the rest of supabase/migrations. Safe to re-run.

create table if not exists public.insight_tags (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null,
  definition   text,
  aliases      text[] not null default '{}',
  -- 'model' = proposed by the tagging pass; 'human' = created or edited by a person.
  origin       text not null default 'model' check (origin in ('model', 'human')),
  retired_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists insight_tags_ws_name_uq on public.insight_tags (workspace_id, lower(name));
alter table public.insight_tags enable row level security;

alter table public.insight_items
  add column if not exists lane       text,
  add column if not exists subtype    text,
  add column if not exists tag_ids    uuid[] not null default '{}',
  add column if not exists contact_id uuid,
  add column if not exists company_id uuid,
  -- When the board pass placed it. NULL = not placed yet; the nightly job picks these up.
  add column if not exists sorted_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'insight_items_lane_check') then
    alter table public.insight_items add constraint insight_items_lane_check
      check (lane is null or lane in ('product', 'sales', 'success', 'market'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'insight_items_subtype_check') then
    alter table public.insight_items add constraint insight_items_subtype_check
      check (subtype is null or subtype in ('bug', 'friction', 'feature', 'objection', 'pricing', 'pitch', 'setup', 'training', 'partners', 'buyers'));
  end if;
end $$;

create index if not exists insight_items_ws_subtype_idx on public.insight_items (workspace_id, subtype);
create index if not exists insight_items_ws_unsorted_idx on public.insight_items (workspace_id) where sorted_at is null;

create table if not exists public.insight_rows (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  subtype       text not null,
  tag_id        uuid not null references public.insight_tags(id) on delete cascade,
  headline      text,
  -- [{ "title": "...", "detail": "...", "item_ids": ["<insight_items.id>", ...] }]
  problems      jsonb not null default '[]',
  receipt_ids   uuid[] not null default '{}',
  -- The membership the summary was written from. The worker rewrites a row when its insight
  -- count has grown past this by enough to change the story, not on every new insight.
  item_count    integer not null default 0,
  account_count integer not null default 0,
  summarized_at timestamptz,
  updated_at    timestamptz not null default now(),
  unique (workspace_id, subtype, tag_id)
);
alter table public.insight_rows enable row level security;

comment on table public.insight_tags is 'The workspace''s concrete insight tags (QR code, CRM integration). Proposed by the model, edited by people.';
comment on table public.insight_rows is 'Nightly summary per (subtype, tag) for the Insights board: headline, concrete problems, three quotes.';
comment on column public.insight_items.subtype is 'The one board button this insight sits under: bug, friction, feature, objection, pricing, pitch, setup, training, partners, buyers.';
