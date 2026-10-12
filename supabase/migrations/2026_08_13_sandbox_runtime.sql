-- Sandbox runtime — the second lane for skills.
--
-- Until now every skill ran in the TOOL runtime: the agent reads the prose body
-- and acts through its fixed tool set (no shell, no filesystem). That is right for
-- governed revenue work, but a whole class of skills — the producers (render an
-- infographic in headless Chrome, a trailer in Remotion, a doc from a template) —
-- are code: they need a shell, files on disk, and to run scripts. Those cannot run
-- in the tool runtime and never will.
--
-- So a skill now declares which runtime it belongs to. `runtime = 'tool'` is the
-- existing path, unchanged and the default. `runtime = 'sandbox'` means the skill
-- is executed inside an ephemeral, isolated container with its whole folder mounted
-- — the SKILL.md, its references, AND its scripts/ and assets/. The linter stops
-- treating shell/scripts as an error for those skills and instead ROUTES them here.

ALTER TABLE workspace_skills
  ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'tool'
    CHECK (runtime IN ('tool', 'sandbox'));

COMMENT ON COLUMN workspace_skills.runtime IS
  'Which runtime executes this skill: tool (prose + fixed tools, the default) or sandbox (ephemeral container with the skill folder mounted — shell, files, scripts).';

-- The command the sandbox runs inside the skill folder, from the SKILL.md front
-- matter (`entrypoint: node scripts/render.mjs`). NULL falls back to a filename
-- convention (scripts/run.sh, then scripts/run.mjs). Only meaningful for sandbox skills.
ALTER TABLE workspace_skills
  ADD COLUMN IF NOT EXISTS entrypoint TEXT;

-- The rest of a skill folder that the tool runtime never needed: the scripts it
-- runs and the assets they read (fonts, templates, seed data). Same shape as
-- workspace_skill_references (git_sha tracks the source blob so ingest can skip
-- unchanged files and drop removed ones), but this holds any file by its path
-- within the skill folder, not just markdown reference docs.
CREATE TABLE IF NOT EXISTS workspace_skill_files (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    UUID NOT NULL REFERENCES workspace_skills(id) ON DELETE CASCADE,
  -- Path relative to the skill folder root, e.g. 'scripts/render.mjs', 'assets/base.html'.
  path        TEXT NOT NULL,
  -- File contents. Text today; a producer skill's binary assets (fonts, images)
  -- are base64 in `content` with is_binary = true until a blob store is wired.
  content     TEXT NOT NULL,
  is_binary   BOOLEAN NOT NULL DEFAULT false,
  -- Mode bit the executor restores when it materializes the folder — scripts need +x.
  executable  BOOLEAN NOT NULL DEFAULT false,
  -- The git blob sha this file was ingested from, so a re-sync can skip unchanged
  -- files and drop ones removed upstream. NULL when authored in-app (never clobbered).
  git_sha     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, path)
);

CREATE INDEX IF NOT EXISTS workspace_skill_files_skill_idx ON workspace_skill_files (skill_id);
