-- Per-member privacy, stage 1: attribute each raw observation to the rep it came
-- through, so the read layer can later scope private content by owner.
-- See PRIVACY_MODEL.md. Additive + nullable: NULL = system/derived/shared (not a
-- private thread), so nothing that exists today changes visibility.
--
-- Idempotent.

ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Read-time scope filter is (owner_user_id = viewer OR owner_user_id IS NULL OR
-- viewer is admin), so the hot lookup is by (workspace, entity, owner).
CREATE INDEX IF NOT EXISTS idx_observations_owner
  ON observations (workspace_id, entity_id, owner_user_id);
