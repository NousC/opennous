-- Per-member agent personalization.
--
-- The agent should answer differently for the founder than for an SDR: same
-- verified record underneath, different job on top. That personalization is
-- scoped to (workspace, member), not to the user globally — the same person can
-- be a founder in one workspace and a consultant in another.
--
-- Note this is NOT workspace_members.role, which is the permission level
-- (owner/admin/member/viewer). This is the job the person actually does.

ALTER TABLE workspace_members
  ADD COLUMN IF NOT EXISTS job_role TEXT,
  -- Free text the member writes for their agent: what they're working on, how
  -- they like to be written for, anything the graph can't know on its own.
  ADD COLUMN IF NOT EXISTS agent_instructions TEXT;

COMMENT ON COLUMN workspace_members.job_role IS
  'The job this member does (founder, ae, sdr, revops, …). Read by the agent to personalize its answers. Distinct from `role`, which is the permission level.';
COMMENT ON COLUMN workspace_members.agent_instructions IS
  'Free-text instructions this member gives their agent. Injected into the agent system prompt for this member only.';
