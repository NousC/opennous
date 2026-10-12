-- Automation flows (GET-523): a trigger, then a list of steps.
--
-- Until now an automation was a trigger, ONE thing it made (artifact or prompt) and ONE place
-- it went. A flow is a trigger and an ordered list of steps — agent, HubSpot, Gmail, Slack,
-- email, webhook, only-if, wait, approval — each reading the variables the trigger and the
-- steps before it produced.
--
-- The old columns stay and stay filled: a flow writes its first agent step into
-- artifact/prompt and its first delivery into destination, so the runners that read them keep
-- working on the simple flows while the step runner takes over. Additive only — nothing here
-- rewrites or drops a row.

-- ── The flow ────────────────────────────────────────────────────────────────
alter table public.agent_routines add column if not exists steps jsonb;
alter table public.agent_routines add column if not exists trigger_config jsonb not null default '{}'::jsonb;

-- Every trigger the builder offers, grouped as it shows them. The old ones stay valid.
alter table public.agent_routines drop constraint if exists agent_routines_trigger_kind_check;
alter table public.agent_routines add constraint agent_routines_trigger_kind_check
  check (trigger_kind in (
    -- conversations
    'call_ended', 'before_meeting', 'email_received', 'reply_owed', 'thread_quiet',
    -- account signals
    'health_changed', 'champion_quiet', 'committee_joined', 'icp_tier_changed',
    'expansion_signal', 'promise_overdue', 'posthog_event',
    -- deals
    'deal_stage_changed', 'deal_closed_won', 'deal_closed_lost', 'deal_stalled', 'deal_created',
    -- other
    'clock', 'webhook_in', 'manual',
    -- legacy
    'call_scored', 'condition'
  ));

-- A flow may have no agent step at all (reply owed → Slack DM), so "makes something" is now
-- satisfied by having steps.
alter table public.agent_routines drop constraint if exists agent_routines_makes_something;
alter table public.agent_routines add constraint agent_routines_makes_something
  check (
    artifact is not null
    or (prompt is not null and length(btrim(prompt)) > 0)
    or (steps is not null and jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) > 0)
  );

-- ── Runs that can pause ─────────────────────────────────────────────────────
-- A Wait step parks the run until resume_at; an Approval step parks it until someone presses
-- approve. `state` carries the variables so far, `step_index` where to pick up, and
-- `step_log` what each step did — History shows which step failed, not just that one did.
alter table public.agent_routine_runs add column if not exists step_index integer;
alter table public.agent_routine_runs add column if not exists state jsonb;
alter table public.agent_routine_runs add column if not exists step_log jsonb not null default '[]'::jsonb;
alter table public.agent_routine_runs add column if not exists resume_at timestamptz;

alter table public.agent_routine_runs drop constraint if exists agent_routine_runs_status_check;
alter table public.agent_routine_runs add constraint agent_routine_runs_status_check
  check (status in ('running', 'ok', 'error', 'waiting', 'awaiting_approval', 'skipped', 'rejected'));

create index if not exists agent_routine_runs_resume
  on public.agent_routine_runs (resume_at) where status = 'waiting';
create index if not exists agent_routine_runs_approval
  on public.agent_routine_runs (workspace_id) where status = 'awaiting_approval';
