-- Coaching v2 (GET-81 / GET-83): the scorecard — one per call, produced by the server-side scorer
-- grading the transcript against the workspace rubric. This is what makes coaching real: trends
-- over time, the skill radar, best calls, and the after-call review are all built from these rows.

create table if not exists public.call_scorecards (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  meeting_id        text not null,                 -- source meeting id (fireflies/granola/fathom)
  source            text,                          -- 'fireflies' | 'granola' | 'fathom'
  entity_id         uuid references public.entities(id) on delete set null,  -- primary account/contact on the call
  rep_user_id       uuid,                          -- the internal rep who ran it (meeting owner)
  rubric_role       text,                          -- the role rubric it was scored against
  rubric_version    int,
  overall           int,                           -- weighted 0–100
  scores            jsonb not null,                -- [{ key, label, weight, score, note, moment }]
  next_step_secured boolean,
  occurred_at       timestamptz not null,
  created_at        timestamptz not null default now(),
  unique (workspace_id, meeting_id)                -- idempotent per call; a re-score replaces
);

-- Per-rep timeline (the trend) and per-account (the deal's call history).
create index if not exists call_scorecards_rep
  on public.call_scorecards (workspace_id, rep_user_id, occurred_at desc);
create index if not exists call_scorecards_entity
  on public.call_scorecards (workspace_id, entity_id, occurred_at desc);

comment on table public.call_scorecards is
  'Coaching v2: one scored scorecard per call (server-side scorer vs the workspace rubric). Feeds the Coaching page trends/radar and the after-call review. scores[] carries per-dimension score + note + the exact moment quote.';

alter table public.call_scorecards enable row level security;
create policy call_scorecards_select on public.call_scorecards
  for select using (is_workspace_member(workspace_id));
