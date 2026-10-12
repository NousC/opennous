-- Credit-aware, resumable backfill. The enrichment job now knows its phase (cheap
-- incremental vs opt-in deep historical), its target window, and can be paused when the
-- workspace runs out of credits and resumed when they top up. Idempotent.
alter table public.contact_enrichment_jobs
  add column if not exists phase text not null default 'incremental',  -- 'incremental' | 'historical'
  add column if not exists window_days integer,                        -- target backfill window for this job
  add column if not exists credits_spent numeric not null default 0,   -- best-effort tally, for the status UI
  add column if not exists processed_phase text,                       -- last source phase completed (resume hint)
  add column if not exists paused_reason text,                         -- e.g. 'no_credits'
  add column if not exists paused_at timestamptz;

-- Find paused jobs fast when credits are topped up (the resume sweep).
create index if not exists contact_enrichment_jobs_paused_idx
  on public.contact_enrichment_jobs(workspace_id) where status = 'paused_no_credits';
