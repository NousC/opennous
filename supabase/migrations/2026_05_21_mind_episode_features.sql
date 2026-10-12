-- The Mind — episode feature snapshot (Adaptive Lead Scoring, Phase 4c).
--
-- The learning loop tests a candidate Scorecard by re-scoring past predictions
-- and checking whether the new scores separate converters from non-converters
-- better. That requires every episode to carry the feature vector it was
-- scored on. scoreICP() snapshots the contact's attributes here, at prediction
-- time — point-in-time, never recomputed.
--
-- See docs/adaptive-lead-scoring.md. Safe to re-run.

ALTER TABLE mind_episodes ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}';
