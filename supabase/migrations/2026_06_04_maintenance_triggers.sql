-- ============================================================
-- Remaining maintenance triggers (touch updated_at, playground thread
-- bump, subscription plan-name sync, auto-join team workspaces) + widen
-- the workspace_members role CHECK to allow 'viewer'.
-- Fresh installs get these from schema.sql. Idempotent.
-- ============================================================

ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner','admin','member','viewer'));

-- ── playground: bump the thread's updated_at as messages arrive ──
CREATE OR REPLACE FUNCTION bump_playground_thread_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE playground_threads SET updated_at = now() WHERE id = NEW.thread_id;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_playground_messages_bump_thread ON playground_messages;
CREATE TRIGGER trg_playground_messages_bump_thread
  AFTER INSERT ON playground_messages
  FOR EACH ROW EXECUTE FUNCTION bump_playground_thread_updated();

-- ── subscriptions: keep plan_name mirrored to plan_id ──
CREATE OR REPLACE FUNCTION sync_subscription_plan_name()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.plan_name := NEW.plan_id; NEW.updated_at := now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS subscriptions_sync_name ON subscriptions;
CREATE TRIGGER subscriptions_sync_name
  BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_subscription_plan_name();

-- ── when a user joins a team, add them to every workspace in that team ──
CREATE OR REPLACE FUNCTION add_user_to_team_workspaces()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_members (workspace_id, user_id, role)
  SELECT w.id, NEW.user_id,
    CASE WHEN NEW.role IN ('founder','owner','admin') THEN 'admin'
         WHEN NEW.role = 'member' THEN 'member'
         ELSE 'viewer' END
  FROM workspaces w
  WHERE w.team_id = NEW.team_id
    AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                    WHERE wm.workspace_id = w.id AND wm.user_id = NEW.user_id);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trigger_add_user_to_team_workspaces ON team_members;
CREATE TRIGGER trigger_add_user_to_team_workspaces
  AFTER INSERT ON team_members
  FOR EACH ROW EXECUTE FUNCTION add_user_to_team_workspaces();

-- ── updated_at touches (reuse the shared touch_updated_at helper) ──
DROP TRIGGER IF EXISTS campaign_messages_updated_at ON campaign_messages;
CREATE TRIGGER campaign_messages_updated_at BEFORE UPDATE ON campaign_messages
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trigger_workflow_providers_updated_at ON workflow_providers;
CREATE TRIGGER trigger_workflow_providers_updated_at BEFORE UPDATE ON workflow_providers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
