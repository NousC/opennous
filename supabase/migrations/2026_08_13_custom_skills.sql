-- Layer D — member-authored custom skills.
--
-- workspace_skills already held two kinds of row: built-ins (workspace_id NULL) and
-- workspace-authored skills. This adds the member layer so a person can write their
-- OWN skill that only they see, then explicitly PUBLISH it to the whole workspace —
-- the same private-then-publish model the personal vault uses.
--
--   built-in            workspace_id NULL                      → every workspace
--   private (a member)  workspace_id set, visibility 'private' → only the author (created_by)
--   workspace           workspace_id set, visibility 'workspace'→ every member of the workspace
--
-- `source` distinguishes a skill typed in the editor ('manual') from one synced out
-- of the member's connected repo ('git', a skills/<name>/SKILL.md — Layer D part 2).

alter table public.workspace_skills
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'workspace')),
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'git')),
  add column if not exists git_sha text;

-- Existing workspace-authored rows were shared with the whole workspace under the old
-- model — keep them that way. Built-ins (workspace_id NULL) are unaffected.
update public.workspace_skills set visibility = 'workspace' where workspace_id is not null;

-- The old constraint made a name unique per workspace, which blocks two members from
-- each having a private skill of the same name (or a private one shadowing a published
-- one). Replace it with one uniqueness rule per layer: one PUBLISHED name per workspace,
-- and one PRIVATE name per member. A member may still shadow a published/built-in name
-- with their own private version — the loader resolves the precedence.
drop index if exists ws_skills_own_name;
create unique index if not exists ws_skills_published_name
  on public.workspace_skills (workspace_id, name)
  where workspace_id is not null and visibility = 'workspace';
create unique index if not exists ws_skills_private_name
  on public.workspace_skills (workspace_id, created_by, name)
  where workspace_id is not null and visibility = 'private';
