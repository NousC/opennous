-- The revenue-motion engine — durable, multi-step plays that run ON the context graph.
--
-- Architecture (deliberate, and the same shape YC's QM harness uses): durability lives
-- IN Postgres, not a separate engine like Temporal. A play is a small DAG defined in
-- CODE (a thin, replaceable driver); the DURABLE part is these two tables — the run and
-- its per-node journal. "Resume after a crash" is just a query: which nodes are ready?
-- A node is safe to re-run because it is keyed by an input_hash. Workflow state and the
-- graph write it causes commit to the SAME database, which is the property a graph-native
-- engine needs and Temporal (state in its own store) structurally cannot give us.
--
-- 3-year design note: the DAG is scaffolding for today's models. The lasting primitive is
-- this durable, resumable, graph-native JOURNAL of an agent's trajectory + the closed loop
-- (decision -> action -> outcome). The conductor that drives it is meant to be swapped
-- (for a Postgres-native durable-execution lib like DBOS/Restate) without touching this
-- data model or the nodes.

create table if not exists public.workflow_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- The play this run executes (defined in code, keyed by a stable string).
  play_key     text not null,
  -- The account this play runs on (a play is scoped to one account, like a watch).
  entity_id    uuid,
  status       text not null default 'running' check (status in ('running','succeeded','failed','cancelled')),
  -- What kicked it off (a watch firing, a signal, a manual start) + any play inputs.
  trigger      jsonb not null default '{}'::jsonb,
  -- Shared, growing context the nodes read/write across the run (the trajectory state).
  context      jsonb not null default '{}'::jsonb,
  created_by   uuid,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  updated_at   timestamptz not null default now()
);

create index if not exists workflow_runs_active_idx
  on public.workflow_runs (status, updated_at) where status = 'running';
create index if not exists workflow_runs_ws_entity_idx
  on public.workflow_runs (workspace_id, entity_id);

-- The per-node journal: one row per (run, node). The checkpoint after every node is just
-- this row's terminal status + output. 'waiting' is the durable pause (a node that keeps
-- the run alive across days until its condition resolves, e.g. wait-for-reply).
create table if not exists public.workflow_node_runs (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references public.workflow_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  node_key     text not null,
  status       text not null default 'pending' check (status in ('pending','running','waiting','succeeded','failed','skipped','cached')),
  input        jsonb,
  input_hash   text,
  output       jsonb,
  attempts     integer not null default 0,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (run_id, node_key)
);

create index if not exists workflow_node_runs_run_idx
  on public.workflow_node_runs (run_id, status);

comment on table public.workflow_runs is
  'A durable run of a revenue-motion play, scoped to one account. State lives here in Postgres (not a separate engine) so a run survives restarts and its graph writes commit in the same DB.';
comment on table public.workflow_node_runs is
  'Per-node journal of a motion run. The row is the checkpoint; status=waiting is the durable pause (e.g. wait-for-reply) that keeps a run alive across days.';

-- Service-role only (the API), same posture as personal_files / account_memory.
alter table public.workflow_runs enable row level security;
alter table public.workflow_node_runs enable row level security;
