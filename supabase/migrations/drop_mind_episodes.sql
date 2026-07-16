-- Drop mind_episodes — the v1 prediction ledger.
--
-- Superseded by the v2 `predictions` table. The v1_to_v2 migration already
-- backfilled every mind_episodes row into `predictions`; the prediction-write
-- worker (scoreEntities) stakes predictions there, the outcome job resolves
-- them there, and the Scorecard learning loop trains on them there.
-- enrichment.mjs no longer writes mind_episodes, and nothing reads it.
--
-- Run after deploying the commit that removes the scoreICP write.

DROP TABLE IF EXISTS mind_episodes;
