-- Automation layer (GET-73 / GET-74): the server side of "the plugin works your
-- calls". When an automation-relevant interaction lands (v1: meeting_held), Nous
-- fans out a GitHub repository_dispatch to every automation-enabled seat repo, so
-- that seat's GitHub Action runs the plugin headlessly (the after-call / weekly
-- skills) on their OWN tokens. This mirrors the outbound_events trigger outbox,
-- but the sink is GitHub's dispatch API rather than an arbitrary URL.

-- 1. Per-seat automation switch. The repo + encrypted token already live on
--    personal_workspaces (the raw-push connection); automation reuses them.
alter table public.personal_workspaces
  add column if not exists automation_enabled boolean not null default false;
alter table public.personal_workspaces
  add column if not exists automation_events text[] not null
    default array['interaction.meeting_held']::text[];

comment on column public.personal_workspaces.automation_enabled is
  'When true (and source_type=github), interaction events fan out a GitHub repository_dispatch to this seat''s repo so the plugin runs headlessly. Set by the `automate` skill / app toggle.';
comment on column public.personal_workspaces.automation_events is
  'Which interaction event types dispatch for this seat. v1 default: meeting_held only.';

-- 2. The durable dispatch queue. Same delivery-state shape as outbound_events so
--    the worker can retry with backoff and dead-letter, but keyed to a seat repo.
create table if not exists public.github_dispatches (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  user_id           uuid not null,                 -- the seat whose repo we dispatch to
  repo              text not null,                 -- owner/name snapshot at enqueue
  event_type        text not null,                 -- e.g. interaction.meeting_held
  dedup_key         text not null,                 -- collapses re-fires (external id or entity:occurred_at)
  client_payload    jsonb not null,                -- small body sent as repository_dispatch client_payload
  entity_id         uuid references public.entities(id) on delete set null,
  occurred_at       timestamptz not null default now(),
  -- delivery state
  delivered_at      timestamptz,
  attempts          int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_status_code  int,
  last_error        text,
  dead_lettered_at  timestamptz,
  created_at        timestamptz not null default now()
);

-- One dispatch per (seat, event, dedup) — a re-fire of the same interaction is a
-- no-op instead of a duplicate GitHub Action run.
create unique index if not exists github_dispatches_dedup
  on public.github_dispatches (workspace_id, user_id, event_type, dedup_key);

-- The drain query: pending, ready-to-send rows, oldest first.
create index if not exists github_dispatches_pending
  on public.github_dispatches (next_attempt_at)
  where delivered_at is null and dead_lettered_at is null;

-- Workspace timeline / debug view.
create index if not exists github_dispatches_workspace
  on public.github_dispatches (workspace_id, occurred_at desc);

alter table public.github_dispatches enable row level security;
-- Members can see their workspace's dispatch history (debug/status); the worker
-- uses the service role and bypasses RLS to drain + update.
create policy gd_select on public.github_dispatches
  for select using (is_workspace_member(workspace_id));
