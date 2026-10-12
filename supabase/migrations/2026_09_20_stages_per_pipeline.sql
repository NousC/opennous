-- A stage vocabulary per pipeline, not per workspace.
--
-- `adoptCrmStages` stores exactly one ladder — the primary pipeline's — and every other pipeline's
-- stages are then unknown to every reader. That is not one customer's problem, it is true of any
-- customer with more than one pipeline, which is most of them: HubSpot ships one and teams add
-- their own. The board ranks an unknown stage at 1000, sorts it to the end of the strip and paints
-- it the same fallback blue as a stage the ladder does name, so a Renewals deal at `Renewal Call Set`
-- and a Sales deal at `Walkthrough Set` are indistinguishable.
--
-- In a workspace with several pipelines, only the primary pipeline's stages are adopted, and every
-- deal sitting in another pipeline's stages is in a stage the vocabulary has never held.
--
-- NULL `pipeline_ref` keeps meaning "this workspace's ladder", so every existing reader — the
-- agent's get_workspace_stages, /v2/workspace/stages, the accounts board, metrics — sees exactly
-- what it sees today and nothing has to be migrated. A per-pipeline row is additive: asked for a
-- pipeline we have adopted, a reader gets that pipeline's ladder; asked for one we have not, it
-- falls back to the workspace's.

-- NOT the existing `pipeline` column. That one arrived with 2026_09_10_workspace_pipelines.sql and
-- holds the LIFECYCLE PHASE a stage belongs to ('sales_pipeline', 'handoff', 'active_customer') —
-- every row in the database says `sales_pipeline`. This is the CRM's pipeline id,
-- the same value `crm_sync_configs.primary_pipeline_ref` and `entity_list_rows.pipeline_ref` hold,
-- and it is named to match them. Two unrelated things are already called "pipeline" here; a third
-- sharing a column would be unrecoverable.
alter table public.workspace_stages add column if not exists pipeline_ref text;

-- Reads are always "this workspace's stages, for this CRM pipeline, in order".
create index if not exists workspace_stages_pipeline_ref_idx
  on public.workspace_stages (workspace_id, pipeline_ref, sort_order);

-- A stage key is unique within its pipeline, not across the workspace: two pipelines legitimately
-- both have a `closed_won`, and stage LABELS commonly repeat across pipelines.
-- The old workspace-wide unique index would have made adopting the second pipeline fail with a
-- duplicate key — which is exactly what `workspace_stages_workspace_key_unique` did twice on
-- 2026-09-16, logged as `hubspot/stages_adopt_failed`.
-- It is a CONSTRAINT, not a bare index, so `drop index` is refused.
alter table public.workspace_stages drop constraint if exists workspace_stages_workspace_key_unique;
create unique index if not exists workspace_stages_pipeline_key_unique
  on public.workspace_stages (workspace_id, coalesce(pipeline_ref, ''), key);
