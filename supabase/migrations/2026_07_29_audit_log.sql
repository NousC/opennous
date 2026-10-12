-- Append-only audit log for privileged + security-sensitive actions.
--
-- SOC 2 (CC6.1/CC7.2) wants a tamper-evident record of who did what: admin
-- impersonation (previously had NO trail), account deletions, and credential
-- touches. Everything is written by the service-role client, so RLS/grants are
-- no protection — instead a BEFORE UPDATE trigger makes existing rows immutable
-- (tamper-evident). DELETE is left allowed so a future retention job can prune
-- old entries; nothing in the app ever deletes from here.

CREATE TABLE IF NOT EXISTS public.audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id       uuid,          -- internal public.users.id of who acted (null = system)
  actor_email         text,
  action              text NOT NULL, -- e.g. admin.impersonate, user.self_delete, integration.connect
  target_type         text,          -- user | workspace | connection | ...
  target_id           text,
  target_workspace_id uuid,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip                  text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON public.audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON public.audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON public.audit_log (action);

-- Immutability: existing rows can never be modified (tamper-evidence), even by
-- the service role, because a trigger blocks UPDATE.
CREATE OR REPLACE FUNCTION public.audit_log_block_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log rows are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON public.audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_block_update();
