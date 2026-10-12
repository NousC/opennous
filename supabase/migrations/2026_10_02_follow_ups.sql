-- The follow-up engine (workspace redesign Phase 3, Oct 2026).
--
-- One card per meeting that needs a follow-up: what happened, the tasks it created, the updates
-- worth logging in the CRM, a drafted email, and the "which deal?" question when the account has
-- several open deals. Built by the worker (apps/worker/src/workers/followUpBuilder.mjs) from
-- meetings already ingested; reviewed on Home and the account page; nothing reaches the CRM or the
-- task list until a person approves it (decision D1, 2026-10-02).
--
-- A later meeting with the same account while its card is still open MERGES into that card (the
-- founder's rule): meeting_keys grows, content is rewritten for both meetings, and the previous
-- content is kept in `history`. Nothing is deleted.
--
-- Additive: two new tables, nothing existing is altered. Off by default per workspace
-- (follow_up_settings.enabled). Safe to re-run.

create table if not exists public.follow_up_settings (
  workspace_id  uuid primary key references public.workspaces(id) on delete cascade,
  enabled       boolean not null default false,
  -- Meetings older than this are never turned into cards (the launch backfill window).
  backfill_from timestamptz,
  enabled_at    timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table public.follow_up_settings is
  'Per-workspace switch for the follow-up engine. Absent or enabled=false means the worker builds no cards.';

create table if not exists public.follow_ups (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  account_entity_id  uuid not null references public.entities(id) on delete cascade,
  deal_entity_id     uuid references public.entities(id) on delete set null,
  status             text not null default 'ready'
                     check (status in ('ready', 'approved', 'synced', 'skipped', 'merged')),
  -- "<source>:<id>" per meeting folded into this card: the dedupe key (a meeting never makes two cards).
  meeting_keys       text[] not null default '{}',
  -- [{ key, source, kind, title, at, observation_id }] in time order.
  meetings           jsonb not null default '[]'::jsonb,
  -- { summary, tasks[], updates[], email, attribution, deal_change, insights[] } — see followUps.ts.
  content            jsonb not null default '{}'::jsonb,
  -- Earlier versions of `content`, newest last, kept when a later meeting rewrote the card.
  history            jsonb not null default '[]'::jsonb,
  -- Who should review it: the account's owner (the CS owner for a customer), as the CRM names them.
  reviewer_name      text,
  reviewer_email     text,
  -- The decision: who, when, and what they did (which tasks, which updates, edits) — the learning label.
  decided_by         uuid,
  decided_at         timestamptz,
  verdict            jsonb,
  model              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.follow_ups is
  'Follow-up cards built from ingested meetings; proposals only until a person approves (then tasks are written as action_item observations).';

create index if not exists follow_ups_ws_status on public.follow_ups (workspace_id, status, updated_at desc);
create index if not exists follow_ups_account on public.follow_ups (workspace_id, account_entity_id, status);
create index if not exists follow_ups_meeting_keys on public.follow_ups using gin (meeting_keys);

alter table public.follow_up_settings enable row level security;
alter table public.follow_ups enable row level security;
