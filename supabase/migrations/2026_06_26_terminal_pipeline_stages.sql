-- Terminal pipeline stages — lost / disqualified / churned.
--
-- The pipeline funnel gains three terminal exits beyond the active ladder
-- (identified → aware → connected → interested → evaluating → client):
--
--   lost          a real deal we were working that died        (interaction.deal_lost)
--   disqualified  a bad fit we ruled out, never a real deal     (interaction.deal_disqualified)
--   churned       a former client who left                      (interaction.subscription_canceled / deal_churned, only from 'client')
--
-- There is NO CHECK constraint on pipeline_stage in v2 — the stage is just a
-- jsonb claim value resolved from observations — so no column change is needed.
-- The vocabulary lives in TypeScript (packages/core/src/types.ts PipelineStage,
-- utils/identity.ts VALID_PIPELINE_STAGES) and the transition logic in
-- packages/core/src/db/activities.ts (entry + reactivation) and the stage
-- derivation / decay workers. Terminal stages are naturally decay-exempt: the
-- nightly decay_pipeline_stages() only demotes 'aware' / 'interested' /
-- 'evaluating', so it never touches a terminal stage.
--
-- This migration's only DDL-free job is a data fix: the dogfood Stripe webhook
-- used to write CAPITALIZED pipeline_stage values ('Customer' on subscribe,
-- 'Churned' on cancel) that never matched the lowercase funnel vocabulary — so
-- those records fell out of every stage filter and dropdown. The webhook now
-- writes 'client' / 'churned'; this back-fills the records written before the fix.
--
-- Idiomatic v2: append a corrective state observation and let the claim engine
-- (claim_jobs queue, drained by apps/worker/src/workers/claimEngine.mjs)
-- recompute the pipeline_stage claim. Idempotent — once the claims recompute to
-- the lowercase value the WHERE clause matches nothing on a re-run.

INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage',
       CASE
         WHEN (c.value #>> '{}') = 'Customer' THEN '"client"'::jsonb
         WHEN (c.value #>> '{}') = 'Churned'  THEN '"churned"'::jsonb
       END,
       'system', 'inference', now()
FROM claims c
WHERE c.property   = 'pipeline_stage'
  AND c.invalid_at IS NULL
  AND (c.value #>> '{}') IN ('Customer', 'Churned');
