-- One writer at a time (GET-412).
--
-- On 2026-09-21 22:12 UTC two backfills and a deploy ran against the production database at
-- once. The instance is IO-bound (13 GB of data on 256 MB of shared buffers); every concurrent
-- writer evicts the app's working set and the app goes empty for everyone. Nothing in the code
-- prevented it, because nothing in the code knew another run existed.
--
-- A lock row per (workspace, job). A script or a worker sweep takes it before it starts and
-- releases it when it ends; a second run of the same job on the same workspace refuses to start
-- and says who holds it. `expires_at` is the safety: a run that died without releasing is taken
-- over after its lease, with a warning, rather than blocking forever.
--
-- The job key '*' is the workspace-wide lock: a full-workspace settle or an extraction backfill
-- takes it, and every other job checks it too, so "one writer at a time" means one, not one per
-- job. Applied by hand (Management API), like the rest of supabase/migrations. Safe to re-run.

create table if not exists public.backfill_locks (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  job           text not null,
  holder        text not null,            -- "<hostname>:<pid> <script>" — who to ask
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null,
  note          text,
  primary key (workspace_id, job)
);

comment on table public.backfill_locks is
  'One long-running writer per workspace per job. Taken before a backfill or sweep starts, released when it ends; a stale lease is taken over with a warning.';
