-- Per-member privacy, stage 2: give an API key a member identity, so the agent
-- reading through it has a viewer to scope raw content against.
-- See PRIVACY_MODEL.md §3. Idempotent.
--
-- owner_user_id: the member this key acts AS (distinct from created_by_user_id,
--   the issuer). NULL = a workspace/admin key (sees all raw).
-- scope: 'member' (raw scoped to owner_user_id) | 'admin' (sees all raw).
--   NULL is treated as 'admin' by the reader, so every existing key keeps its
--   current all-access behaviour and nothing breaks on deploy.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scope TEXT CHECK (scope IN ('member', 'admin'));
