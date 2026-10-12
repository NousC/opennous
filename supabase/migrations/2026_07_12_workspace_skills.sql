-- Skills — the procedures the agent knows.
--
-- A skill is a named procedure written in prose: "this is how you brief someone
-- before a meeting." The agent reads its description on every turn (cheap, one
-- line) and pulls the full body only when it decides the skill applies. Same
-- progressive disclosure as a SKILL.md in Claude Code, and deliberately the same
-- shape, so a procedure written for one runs in the other.
--
-- Two kinds of row, one table:
--   workspace_id IS NULL     — a Nous built-in. Authored as a file in the repo
--                              (apps/api/src/skills/<name>/SKILL.md), seeded on
--                              boot, visible to every workspace. Git is the
--                              source of truth; this table is just the runtime.
--   workspace_id = <a ws>    — a skill that workspace wrote. Nobody else sees it.
--
-- Which means the day we ship the skill editor there is nothing new to build
-- behind it: same loader, same catalog, same execution path.

CREATE TABLE workspace_skills (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = a Nous built-in, shared by every workspace.
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,

  -- The handle the model calls, kebab-case: 'meeting-brief'.
  name         TEXT NOT NULL,
  -- The ONE line that sits in the system prompt on every single turn. This is
  -- what the model decides on, so it must say when to reach for the skill, not
  -- just what the skill is. Keep it tight — it is paid for on every message.
  description  TEXT NOT NULL,
  -- What a PERSON reads on the card. Kept separate from `description` on purpose:
  -- the model's trigger line needs the "use for X, not Y" detail to choose right,
  -- and trimming it to make a card look tidy would quietly make the agent worse.
  summary      TEXT,
  -- The procedure itself. Never in the prompt until the model asks for it.
  body         TEXT NOT NULL,
  -- The department it serves (AEs, GTM, RevOps, Outbound, Marketing) — the chip
  -- on the card. Presentation only; the model never sees it.
  category     TEXT,

  -- Integrations this skill needs to actually run ('apify', 'apollo', …). Checked
  -- against the workspace's verified workflow_provider_connections, so the agent
  -- can tell the user what to connect instead of failing halfway through.
  requires_providers TEXT[] NOT NULL DEFAULT '{}',
  -- Tools the body is allowed to reach for. Advisory today (the model has one
  -- tool set); the honest place to enforce it once skills can be user-written.
  allowed_tools      TEXT[] NOT NULL DEFAULT '{}',
  -- Rough cost of one run, in dollars. The agent quotes this and waits for a yes
  -- before it spends anything.
  est_cost_usd       NUMERIC(10,4),

  is_builtin   BOOLEAN NOT NULL DEFAULT false,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A name is unique among the built-ins, and unique within a workspace — but a
-- workspace may deliberately shadow a built-in with its own version of the same
-- name. Two partial indexes rather than one constraint, because NULL workspace_id
-- would otherwise be treated as distinct and let duplicate built-ins in.
CREATE UNIQUE INDEX ws_skills_builtin_name ON workspace_skills(name)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX ws_skills_own_name ON workspace_skills(workspace_id, name)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX ws_skills_workspace ON workspace_skills(workspace_id) WHERE enabled;

ALTER TABLE workspace_skills ENABLE ROW LEVEL SECURITY;

-- You can read the built-ins and your own. You can only write your own — a
-- built-in is changed by shipping the repo, not by a client.
CREATE POLICY ws_skills_select ON workspace_skills
  FOR SELECT USING (workspace_id IS NULL OR is_workspace_member(workspace_id));
CREATE POLICY ws_skills_write ON workspace_skills
  FOR ALL USING (workspace_id IS NOT NULL AND is_workspace_member(workspace_id))
  WITH CHECK (workspace_id IS NOT NULL AND is_workspace_member(workspace_id));

CREATE TRIGGER ws_skills_touch BEFORE UPDATE ON workspace_skills
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
