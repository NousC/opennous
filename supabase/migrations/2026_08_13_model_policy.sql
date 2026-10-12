-- Model choice as org policy (the trust layer, from the QM study).
--
-- An admin decides which models may touch this workspace's data, and the default.
-- Shape: { "allowlist": ["claude-sonnet-5", ...], "default": "claude-sonnet-5" }
-- where each entry is a lib/model.mjs REGISTRY key.
--
-- NULL (the default) = NO policy = every model in the registry is allowed and the
-- global default applies — i.e. today's behaviour is preserved for every existing
-- workspace. A policy only ever NARROWS: allowlist → default → per-scope override.
-- Enforcement is server-side (routes/api/playground.mjs), so the picker UI is a
-- convenience, not the boundary — a user cannot run a model outside the allowlist
-- even by calling the API directly.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS model_policy JSONB;

COMMENT ON COLUMN workspaces.model_policy IS
  'Model org-policy: { allowlist: string[], default: string } of model.mjs keys. NULL = all models allowed (default).';
