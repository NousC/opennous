-- workspace_skills.source: allow 'plugin'.
--
-- Skills now arrive from three places, and the column has to be able to say which:
--
--   'manual'  a member wrote it in the app
--   'git'     synced from the OPERATOR'S OWN repo (lib/personalGithub.mjs) — and note that
--             that sync DELETES any 'git' skill missing from their repo, which is exactly
--             why the plugin's library can't borrow this value
--   'plugin'  the revenue plugin's library (nous-plugin), seeded at boot as built-ins by
--             seedPluginSkills(). git_sha carries the plugin commit it came from.
--
-- Additive: no existing row changes, and re-running is harmless.

ALTER TABLE workspace_skills DROP CONSTRAINT IF EXISTS workspace_skills_source_check;

ALTER TABLE workspace_skills
  ADD CONSTRAINT workspace_skills_source_check
  CHECK (source = ANY (ARRAY['manual'::text, 'git'::text, 'plugin'::text]));
