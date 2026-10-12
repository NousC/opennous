-- Coaching v2 (GET-81 / GET-82): the rubric — "what good looks like" for this team, the thing
-- the server-side scorer (GET-83) grades every call against. Role-aware: an AE rubric differs
-- from an SDR rubric, so one row per (workspace, role). A workspace with no custom rubric falls
-- back to the shipped defaults in code (packages/core/src/db/coachingRubric.ts).

create table if not exists public.coaching_rubrics (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  role          text not null default 'default',      -- GTM role this rubric applies to (account_executive, sdr, …)
  methodology   text not null default 'meddicc',       -- meddicc | bant | custom — what 'methodology adherence' grades against
  dimensions    jsonb not null,                        -- [{ key, label, weight, good }] — weights sum to 100
  version       int  not null default 1,
  updated_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, role)
);

comment on table public.coaching_rubrics is
  'Per-workspace, per-role coaching rubric (Coaching v2). The scorer grades each call against the matching role rubric; absent a row, code defaults apply. Weights in dimensions[] sum to 100.';

alter table public.coaching_rubrics enable row level security;
-- Members can read their workspace's rubric (the scorer + Coaching page + plugin read it); writes
-- go through the API with the service role (admin-gated in the route).
create policy coaching_rubrics_select on public.coaching_rubrics
  for select using (is_workspace_member(workspace_id));
