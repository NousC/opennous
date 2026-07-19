-- Queue + progress for the post-import contact-history backfill.
--
-- The API enqueues a job on CSV import ({ workspace_id, contact_ids }, status
-- 'pending') and returns immediately. The worker (apps/worker/src/workers/
-- contactEnrichmentJobs.mjs) claims it, runs the bulk/rate-lane'd backfill off the
-- API request path, and keeps `state` updated so the import modal shows live progress
-- that survives a restart. `status` + `locked_at` give claim/retry/stale-reclaim.
--
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS public.contact_enrichment_jobs (
    job_id       uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    contact_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    status       text NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
    attempts     integer NOT NULL DEFAULT 0,
    locked_at    timestamptz,
    error        text,
    state        jsonb NOT NULL DEFAULT '{}'::jsonb, -- live progress snapshot for the UI
    done         boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Additive guards so a re-run against an earlier (state/done-only) version of the
-- table fills in the queue columns instead of erroring.
ALTER TABLE public.contact_enrichment_jobs ADD COLUMN IF NOT EXISTS contact_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.contact_enrichment_jobs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.contact_enrichment_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.contact_enrichment_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE public.contact_enrichment_jobs ADD COLUMN IF NOT EXISTS error text;

-- The drainer picks the oldest actionable job: pending, or running with a stale lock.
CREATE INDEX IF NOT EXISTS contact_enrichment_jobs_status
    ON public.contact_enrichment_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS contact_enrichment_jobs_workspace_id
    ON public.contact_enrichment_jobs (workspace_id);
