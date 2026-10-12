-- Restore the workspace_role casts in add_user_to_team_workspaces() (GET-757).
--
-- 2026_06_04_maintenance_triggers.sql recreated this trigger function without the ::workspace_role
-- casts the earlier definition had. A CASE over bare string literals resolves to text, and text
-- does not assign to the workspace_role enum, so on a database built from the migrations EVERY
-- insert into team_members fails ("column role is of type workspace_role but expression is of
-- type text"), signup included. Found by loading the demo seed into a fresh baseline.
--
-- Same behaviour as both earlier versions, with the casts back. Idempotent.
CREATE OR REPLACE FUNCTION public.add_user_to_team_workspaces()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- When a user joins a team, add them to every existing workspace of that team.
  INSERT INTO workspace_members (workspace_id, user_id, role)
  SELECT w.id, NEW.user_id,
    CASE WHEN NEW.role IN ('founder', 'owner', 'admin') THEN 'admin'::workspace_role
         WHEN NEW.role = 'member' THEN 'member'::workspace_role
         ELSE 'viewer'::workspace_role END
  FROM workspaces w
  WHERE w.team_id = NEW.team_id
    AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                    WHERE wm.workspace_id = w.id AND wm.user_id = NEW.user_id);
  RETURN NEW;
END; $$;
