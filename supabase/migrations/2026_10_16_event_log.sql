-- Event log (GET-939): every event that happened in a workspace, whether or not anything listens.
--
-- outbound_events (2026_05_27_triggers.sql) is the outbox: one row per (event, subscription), so an
-- event nobody subscribed to left no trace and an engineer could only see an event after it was
-- sent somewhere. This is the event itself, once, the way Stripe keeps its Events: the Events page
-- and GET /v2/events read it, and a webhook that subscribes later is sent the same body (same id).
--
-- `id` is the envelope id (the payload's `id`, X-Nous-Event-Id). `external_id` is the event's
-- identity (`<type>:<dedupeKey>`, as on outbound_events), so a re-sync or a second detector never
-- logs it twice. The payload is the body a webhook would receive, read as the whole team (see
-- services/events.mjs), so every member may read every row.
--
-- Written by emitEvent (service role). Pruned to 30 days by the worker (pruneEventLog, daily).
-- Additive only.

create table if not exists public.event_log (
  id           uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type         text not null,                      -- e.g. signal.stakeholder_left, deal.won
  external_id  text not null,                      -- '<type>:<dedupeKey>'
  entity_id    uuid references public.entities(id) on delete set null,  -- the account (or person)
  occurred_at  timestamptz not null,               -- when it happened
  created_at   timestamptz not null default now(), -- when we logged it: the feed's order and cursor
  payload      jsonb not null,                     -- the envelope a webhook receives
  unique (workspace_id, external_id)
);

-- The feed, newest first, with the cursor's tiebreak.
create index if not exists event_log_feed on public.event_log (workspace_id, created_at desc, id desc);
-- Filtered by type, and by account.
create index if not exists event_log_type on public.event_log (workspace_id, type, created_at desc);
create index if not exists event_log_entity on public.event_log (workspace_id, entity_id, created_at desc);

alter table public.event_log enable row level security;
drop policy if exists event_log_select on public.event_log;
create policy event_log_select on public.event_log for select using (public.is_workspace_member(workspace_id));

notify pgrst, 'reload schema';
