-- Pipeline identity: a workspace has more than one CRM pipeline, and "the pipeline" needs
-- a stable key.
--
-- One additive, nullable column:
--
--   crm_sync_configs.primary_pipeline_ref   The CRM's own id for the pipeline the workspace
--       means when it says "the pipeline" (HubSpot: the literal `default`). Written on every
--       sync from the provider's marker, never from a display name (reps rename those, and
--       they arrive with stray whitespace). NULL = not synced since this shipped; every reader
--       treats NULL as "no filter", which is exactly the behaviour before this migration.
--
-- Deals additionally carry a `pipeline_id` state observation, written by the sync next to the
-- existing `pipeline` name. Observations are open, so that needs no schema change. Existing
-- deals get theirs from scripts/backfill-pipeline-id.mjs (one-off, per workspace).
--
-- Safe to run more than once.

ALTER TABLE public.crm_sync_configs ADD COLUMN IF NOT EXISTS primary_pipeline_ref text;

COMMENT ON COLUMN public.crm_sync_configs.primary_pipeline_ref IS
  'The CRM''s id for the workspace''s primary pipeline (HubSpot: ''default''). NULL = unknown, readers apply no pipeline filter.';
