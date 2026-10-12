-- Webhook delivery log (GET-624): one row per HTTP attempt Nous makes against a customer's
-- outbound webhook, retries and manual resends included.
--
-- outbound_events (2026_05_27_triggers.sql) is the outbox: one row per (event, subscription)
-- whose delivery state is OVERWRITTEN on every retry, so it can say where an event is but not
-- what happened on the way. This is that history, for the Webhooks page: recent deliveries, a
-- 7-day success rate and a Resend button.
--
-- No payload column: outbound_events.payload is already the exact JSON body we sign, kept for
-- the life of the subscription. A row points at it (outbound_event_id) and Resend replays it from
-- there, so a body is never stored twice.
--
-- Written by the worker's drain loop and the API's Resend (service role). Members read their own
-- workspace's rows, the same rule as trigger_subscriptions and outbound_events. Pruned to 30
-- days by the worker (pruneWebhookDeliveries, daily). Additive only.

create table if not exists public.webhook_deliveries (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  subscription_id    uuid not null references public.trigger_subscriptions(id) on delete cascade,
  -- The outbox row this attempt sent: the payload reference Resend replays.
  outbound_event_id  uuid references public.outbound_events(id) on delete set null,
  event              text not null,             -- event type, e.g. deal.won
  event_id           text,                      -- the X-Nous-Event-Id we sent
  attempt            integer not null default 1,
  status_code        integer,                   -- null on a timeout / network error
  ok                 boolean not null,
  error              text,                      -- response text or reason, first 300 chars
  duration_ms        integer not null default 0,
  created_at         timestamptz not null default now(),
  resent_from        uuid references public.webhook_deliveries(id) on delete set null,
  constraint webhook_deliveries_error_len check (error is null or char_length(error) <= 300)
);

-- The log and the 7-day stats, per webhook.
create index if not exists webhook_deliveries_subscription
  on public.webhook_deliveries (subscription_id, created_at desc);
-- Workspace-wide views.
create index if not exists webhook_deliveries_workspace
  on public.webhook_deliveries (workspace_id, created_at desc);
-- The daily 30-day prune runs across all workspaces.
create index if not exists webhook_deliveries_created_at
  on public.webhook_deliveries (created_at);

alter table public.webhook_deliveries enable row level security;

drop policy if exists wd_select on public.webhook_deliveries;
create policy wd_select on public.webhook_deliveries
  for select using (public.is_workspace_member(workspace_id));
