-- Claims about us (GET-969): what a customer said about our product, pitch or market, one row per
-- point heard, with the fields the insight engine counts on (packages/core/src/db/aboutUsClaims.ts).
--
-- The claim read sorted these out (home = our_product | market) and threw them away; the insight
-- read re-derived them. Now the one read keeps them here, never on the account's own record.
-- `origin` says which read wrote the row: 'claim_read', or 'insight_read' for history copied from
-- insight_items (legacy_item_id).
--
-- Safe to run more than once. Nothing here rewrites or drops a row.

create table if not exists public.about_us_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  company_id uuid,
  contact_id uuid,
  home text not null default 'our_product' check (home in ('our_product', 'market')),
  kind text not null check (kind in ('bug', 'friction', 'feature', 'objection', 'pricing', 'pitch', 'setup', 'training', 'partners', 'buyers', 'praise')),
  content text not null,
  -- A claim read row always rests on a checked quote; history copied from insight_items may not.
  quote text,
  -- Said in a private message (email, LinkedIn, a Slack DM): the fact is the team's, the words
  -- stay with the conversation (GET-985), so the quote is never shown.
  quote_private boolean not null default false,
  speaker text,
  what text,
  use_case text,
  product_area text,
  asked_by text,
  job text,
  source_ref text,
  source_system text,
  occurred_at timestamptz,
  origin text not null default 'claim_read' check (origin in ('claim_read', 'insight_read')),
  legacy_item_id uuid unique,
  embedding public.vector(1536),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  constraint about_us_claims_quote_check check (origin = 'insight_read' or quote is not null)
);

create index if not exists about_us_claims_ws_kind_idx on public.about_us_claims (workspace_id, kind) where retired_at is null;
create index if not exists about_us_claims_ws_ref_idx on public.about_us_claims (workspace_id, source_ref);
create index if not exists about_us_claims_ws_company_idx on public.about_us_claims (workspace_id, company_id);

-- Served through the service-role client only, as insight_items.
alter table public.about_us_claims enable row level security;
