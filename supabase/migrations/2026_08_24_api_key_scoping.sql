-- API-key scoping + expiry + rotatable names.
--
-- Adds:
--   capability  — 'read_write' (default; unchanged behavior) or 'read_only' (can read/
--                 compute context but cannot record/modify/connect/send). Enforced in
--                 apps/api/src/middleware/apiKey.mjs (fail-closed allowlist).
--   expires_at  — optional key expiry; the auth middleware rejects an expired key (401
--                 api_key_expired).
-- And makes the (workspace_id, name) uniqueness apply to ACTIVE keys only, so a rotated
-- or recreated key can reuse the same name once the old one is revoked (the old full
-- unique blocked real rotation).
--
-- Applied to prod via MCP 2026-08-24. Idempotent.

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS capability text NOT NULL DEFAULT 'read_write';
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_capability_chk') THEN
    ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_capability_chk CHECK (capability IN ('read_write', 'read_only'));
  END IF;
END $$;

-- Name unique among ACTIVE keys only (was: all rows, which kept a revoked key's name taken).
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_workspace_id_name_key;
DROP INDEX IF EXISTS public.api_keys_workspace_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_workspace_name_active
  ON public.api_keys (workspace_id, name) WHERE revoked_at IS NULL;
