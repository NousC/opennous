-- Track each reference file's git blob sha so a GitHub-synced skill folder can
-- ingest a reference-only change (and skip unchanged references). Null for
-- references authored in-app / seeded from built-ins.
alter table workspace_skill_references add column if not exists git_sha text;
