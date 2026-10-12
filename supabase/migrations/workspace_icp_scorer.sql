-- Who scores a workspace's accounts, and where its tiers cut (GET-586).
--
-- icp_scorer: 'nous' is the learned scorecard. 'external' means the workspace runs its own ICP
-- scorer and posts results to POST /v2/scores; Nous then stops staking, re-scoring and learning for
-- it, and grades the external scores against won/lost like its own. NULL follows the plan: the API
-- plan is external, every other plan is nous. External rows are marked by a model_version of
-- 'ext:<scorer>', so nothing that recomputes a score ever overwrites one.
--
-- icp_tier_thresholds: { "tier_1": 85, "tier_2": 70, "tier_3": 50 } overrides the default bands for
-- this workspace. NULL means the defaults.
--
-- Idempotent.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS icp_scorer text;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS icp_tier_thresholds jsonb;

DO $$ BEGIN
  ALTER TABLE public.workspaces
    ADD CONSTRAINT workspaces_icp_scorer_check CHECK (icp_scorer IS NULL OR icp_scorer IN ('nous', 'external'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
