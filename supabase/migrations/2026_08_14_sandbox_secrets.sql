-- Sandbox secrets — credentials a sandbox skill can use, without them living in the
-- skill's files.
--
-- A skill's scripts are stored in the clear (workspace_skill_files) and can be shared
-- or synced to GitHub, so a key can't live there. Instead a workspace stores named
-- secrets encrypted at rest (same AES-GCM as provider credentials), a skill DECLARES
-- which names it needs (required_secrets), and the executor injects only those as env
-- vars into the run container — never to disk, never to the skill folder or output.

CREATE TABLE IF NOT EXISTS workspace_secrets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The env var name the skill reads, e.g. 'OPENAI_API_KEY'. Upper snake case.
  name            TEXT NOT NULL,
  -- AES-GCM ciphertext (providers/crypto.mjs encryptValue). Never returned to a client.
  encrypted_value TEXT NOT NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- The secret names a skill is allowed to receive at run time. Least privilege: a skill
-- gets only the ones it lists, not the whole workspace's secrets.
ALTER TABLE workspace_skills
  ADD COLUMN IF NOT EXISTS required_secrets TEXT[] NOT NULL DEFAULT '{}';
