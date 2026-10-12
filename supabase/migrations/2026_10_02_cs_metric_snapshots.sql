-- Customer Success Phase 5: a daily memory of two CS fields, and handoffs that know who.
--
-- 1. cs_metric_snapshots. The CRM keeps ONE number for active users (a portal's custom property,
--    projected onto entity_list_rows.cs.active_users_30d) and overwrites it. "Fewer people log in
--    than last month" is the sentence a CS rep needs and no single value can say it. So once a day
--    the worker (apps/worker/src/workers/csSnapshots.mjs) writes today's value per customer, and the
--    Customers page reads the trend as today minus the snapshot ~30 days earlier: null until a month
--    of history exists, never a guess. The same job keeps the CS owner per customer (metric
--    'cs_owner'), which is how a change of CS owner is noticed: the sync does not keep property
--    history for companies, so yesterday's snapshot is the only "before" there is.
--
--    `value` for numbers, `value_text` for an identity (the CRM owner id), `meta` for what a human
--    reads (the owner's name). One row per (workspace, account, metric, day); a second run the same
--    day overwrites. Written only by the worker with the service role; RLS on with no policy, like
--    the other worker-only tables.
--
-- 2. lifecycle_events gains from_owner / to_owner / dedupe_key. A handoff used to be only
--    "closed won → Customer Success". A change of CS owner is a handoff too, and its card has to name
--    both people. dedupe_key makes it idempotent per account and new owner: the unique index lets the
--    worker insert with ON CONFLICT DO NOTHING, and every existing row has a NULL key, which never
--    conflicts (NULLs are distinct in a unique index), so closed-won and rule events are untouched.
--
-- Additive and re-runnable. New table, three nullable columns with no default (a catalog change, not
-- a rewrite), two indexes. lock_timeout: the ALTER and the unique index take brief locks on a table
-- Home reads; better to fail fast and re-run than to queue reads behind them.

set lock_timeout = '5s';

create table if not exists public.cs_metric_snapshots (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  entity_id     uuid not null,
  metric        text not null,          -- 'active_users_30d' | 'cs_owner'
  captured_on   date not null,
  value         numeric,                -- numeric metrics
  value_text    text,                   -- identity metrics (the CS owner's CRM id, or email/name when there is no id)
  meta          jsonb,                  -- display only: { name, email } for cs_owner
  created_at    timestamptz not null default now(),
  primary key (workspace_id, entity_id, metric, captured_on)
);
comment on table public.cs_metric_snapshots is
  'Daily per-customer snapshot of CS fields the CRM overwrites (active users, CS owner). Written by the csSnapshots worker; read for the active-users trend and to detect CS owner handoffs.';

-- The trend read: one metric, a window of days, the whole workspace.
create index if not exists cs_metric_snapshots_ws_metric_day
  on public.cs_metric_snapshots (workspace_id, metric, captured_on);

alter table public.cs_metric_snapshots enable row level security;

-- Guarded (GET-757): lifecycle_events has no CREATE TABLE in this repo (created out-of-band on
-- production), so on a database built from the repo the cs_metric_snapshots half above must still
-- land. On production the table exists and this runs as before.
do $$
begin
  if to_regclass('public.lifecycle_events') is not null then
    alter table public.lifecycle_events add column if not exists from_owner text;
    alter table public.lifecycle_events add column if not exists to_owner text;
    alter table public.lifecycle_events add column if not exists dedupe_key text;
    create unique index if not exists lifecycle_events_dedupe
      on public.lifecycle_events (workspace_id, company_id, dedupe_key);
  end if;
end $$;
