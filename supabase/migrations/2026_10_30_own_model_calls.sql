-- A person's own-plan backfill (GET-1085): the model calls waiting for their CLI. The worker writes
-- a call, the CLI answers it, the worker takes the answer and deletes the row, so conversation text
-- sits here only while a call is open. Service role only, like every worker queue.
CREATE TABLE IF NOT EXISTS public.own_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.contact_enrichment_jobs(job_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  feature text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  answer text,
  model text,
  usage jsonb,
  error text,
  leased_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS own_model_calls_job_status ON public.own_model_calls (job_id, status, created_at);
ALTER TABLE public.own_model_calls ENABLE ROW LEVEL SECURITY;
