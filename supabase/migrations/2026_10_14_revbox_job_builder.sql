-- RevBox Job Builder (GET-868, docs/revboxes/JOB_BUILDER.md): a box's jobs are workflow-engine
-- routines (`agent_routines.revbox_id`), the same engine the Automations run on, and the builder
-- chat that proposes them is persisted per session. Runs after 2026_10_14_revboxes.sql (it needs
-- revboxes(id, workspace_id)). One transaction: it applies whole or not at all.
BEGIN;

-- A routine belongs to at most one box, in the box's own workspace (the composite key makes a
-- cross-tenant link impossible). Deleting the box deletes its jobs. Null = an ordinary automation.
ALTER TABLE public.agent_routines ADD COLUMN revbox_id uuid;
ALTER TABLE public.agent_routines
  ADD CONSTRAINT agent_routines_revbox_fkey FOREIGN KEY (revbox_id, workspace_id)
  REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE;
CREATE INDEX agent_routines_revbox ON public.agent_routines(workspace_id, revbox_id) WHERE revbox_id IS NOT NULL;

-- One builder chat. `messages` is the Anthropic-format transcript, `proposal` the latest proposed
-- job; `job_id` is the routine a "Make changes" session edits (null for a new job). Service role
-- only: access is the box's edit rights, checked by the server on every read and write.
CREATE TABLE public.revbox_builder_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  revbox_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.agent_routines(id) ON DELETE SET NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 4194304),
  proposal jsonb CHECK (proposal IS NULL OR (jsonb_typeof(proposal) = 'object' AND octet_length(proposal::text) <= 262144)),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'approved', 'abandoned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX revbox_builder_sessions_box ON public.revbox_builder_sessions(workspace_id, revbox_id, updated_at DESC);
ALTER TABLE public.revbox_builder_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_builder_sessions FROM anon, authenticated;
GRANT ALL ON public.revbox_builder_sessions TO service_role;

COMMIT;
