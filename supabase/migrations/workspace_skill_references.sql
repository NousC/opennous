-- Level-3 progressive disclosure for skills: reference files bundled with a skill.
-- A skill keeps deep detail (patterns, examples, edge cases) out of its always-loaded
-- SKILL.md body; the agent pulls one reference on demand via read_skill_reference.
-- Built-ins seed from apps/api/src/skills/<name>/references/*.md on API boot.
create table if not exists workspace_skill_references (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references workspace_skills(id) on delete cascade,
  name text not null,
  content text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (skill_id, name)
);
create index if not exists idx_skill_refs_skill on workspace_skill_references(skill_id);
