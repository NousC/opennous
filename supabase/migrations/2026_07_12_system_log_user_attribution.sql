-- Who did this?
--
-- workspace_system_log records every op an agent runs, but only ever knew WHICH
-- WORKSPACE it belonged to. So we could say "this workspace made 34,000 calls"
-- and nothing about who — which makes the one question a buyer actually has
-- ("is my team adopting this, and who isn't?") unanswerable.
--
-- The identity was already on the request the whole time: an API key carries
-- owner_user_id, and a session carries the logged-in user. Both land on
-- req.memberUserId. This column just writes it down.
--
-- Nullable on purpose: legacy workspace-scoped keys have no owner, and the 34k
-- existing rows cannot be back-attributed. Attribution starts now, going forward.

ALTER TABLE workspace_system_log
  ADD COLUMN IF NOT EXISTS user_id UUID;

COMMENT ON COLUMN workspace_system_log.user_id IS
  'The team member whose agent ran this op — from the API key''s owner (MCP/SDK) or the session (web). Null for workspace-scoped keys and for rows written before attribution existed.';

-- The usage page asks "per member, over time", so index for exactly that.
CREATE INDEX IF NOT EXISTS wsl_user_time
  ON workspace_system_log (workspace_id, user_id, occurred_at DESC);
