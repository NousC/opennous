-- Per-pipeline stage medians: how long a deal typically sits in each stage of each CRM
-- pipeline. The denominator behind "94 days in Negotiation, typically 21".
--
-- Why a table: the number comes from every deal's stage history in the workspace (a
-- Kaplan-Meier median over completed AND still-running occupancies), which is a full scan no
-- page read can afford. The nightly worker (apps/worker/src/workers/pipelineStageStats.mjs)
-- computes it and replaces the workspace's rows; readers look up (pipeline, stage) through
-- getPipelineStageStats / typicalDaysFor in packages/core/src/db/pipelineStageStats.ts.
--
-- One row per (workspace, pipeline, stage). pipeline_ref is the CRM's own pipeline id (the
-- deal's `pipeline_id` observation), '' when the deal carries none. Nothing is pooled across
-- pipelines: an Expansion deal is measured against Expansion deals. stage_label is the deal's
-- `stage` label exactly as the observation spells it. A row exists only where sample_n
-- reached the honesty floor (8) and the median could be named; a missing row means "no
-- typical yet", never zero. workspace_stages is not involved.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public.pipeline_stage_stats (
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    pipeline_ref text NOT NULL,          -- the CRM's pipeline id; '' = unknown
    stage_label  text NOT NULL,
    median_days  double precision NOT NULL,
    sample_n     integer NOT NULL,
    computed_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, pipeline_ref, stage_label)
);

-- Service-role only (the post-audit-C1 convention: RLS on, no policy, and no grants to the
-- browser roles). The worker writes it and the API reads it, both through the service-role
-- client, which bypasses RLS.
ALTER TABLE public.pipeline_stage_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pipeline_stage_stats FROM anon, authenticated;
