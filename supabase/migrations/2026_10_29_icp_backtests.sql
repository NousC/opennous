-- ICP backtests (GET-1074): how well today's ICP score separates the deals a workspace won from the
-- ones it lost, re-scored on its closed deals, with contact coverage controlled for. One row per
-- run, newest read by the ICP page and the ICP file's learned block. Runs are kept, not replaced,
-- so accuracy can be compared over time.
--
-- `result` holds the summary only (tiers, strata, criteria impact, disqualifiers, data coverage,
-- recommendations, accuracy) plus the 50 most recent closes for the page's table, never every row.
-- Written by the worker (service role); read by the API (service role). No client access.

create table if not exists public.icp_backtests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  model_version text not null,
  ran_at        timestamptz not null default now(),
  result        jsonb not null
);

create index if not exists icp_backtests_ws_ran_idx on public.icp_backtests (workspace_id, ran_at desc);

alter table public.icp_backtests enable row level security;
