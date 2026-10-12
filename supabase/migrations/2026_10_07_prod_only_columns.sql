-- Columns that exist on prod but no migration in the repo adds (they were made by hand), read
-- from prod's catalog on 2026-10-07 (read-only). Without them a fresh install breaks wherever the
-- code writes them, e.g. workspace_members.job_roles on the founder's seat. Everything is
-- IF NOT EXISTS or matches prod already, so on prod this file changes nothing.
ALTER TABLE public.collections        ADD COLUMN IF NOT EXISTS in_outreach boolean DEFAULT false NOT NULL;
ALTER TABLE public.collections        ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE public.deal_outcomes      ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.entity_identifiers ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.entity_merge_log   ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE public.entity_merge_log   ADD COLUMN IF NOT EXISTS confidence numeric;
ALTER TABLE public.entity_merge_log   ADD COLUMN IF NOT EXISTS matched_kind text;
ALTER TABLE public.entity_merge_log   ADD COLUMN IF NOT EXISTS matched_value text;
ALTER TABLE public.entity_merge_log   ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.insight_items      ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE public.insight_items      ADD COLUMN IF NOT EXISTS source_system text;
ALTER TABLE public.pending_actions    ADD COLUMN IF NOT EXISTS message_id uuid;
ALTER TABLE public.pending_actions    ADD COLUMN IF NOT EXISTS rec_id uuid;
ALTER TABLE public.scorecard_signals  ADD COLUMN IF NOT EXISTS manual boolean DEFAULT false NOT NULL;
ALTER TABLE public.workspace_members  ADD COLUMN IF NOT EXISTS agent_name text;
ALTER TABLE public.workspace_members  ADD COLUMN IF NOT EXISTS agent_prefs jsonb;
ALTER TABLE public.workspace_members  ADD COLUMN IF NOT EXISTS agent_rules jsonb;
ALTER TABLE public.workspace_members  ADD COLUMN IF NOT EXISTS job_roles text[];
ALTER TABLE public.workspaces         ADD COLUMN IF NOT EXISTS handoff_dismissed_at timestamp with time zone;

-- Three columns whose nullability or default differs from prod. These match prod's state.
ALTER TABLE public.invariant_checks   ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE public.ri_decision_traces ALTER COLUMN action_property DROP NOT NULL;
UPDATE public.workspace_skills SET egress_hosts = '{}'::text[] WHERE egress_hosts IS NULL;
ALTER TABLE public.workspace_skills   ALTER COLUMN egress_hosts SET DEFAULT '{}'::text[];
ALTER TABLE public.workspace_skills   ALTER COLUMN egress_hosts SET NOT NULL;
