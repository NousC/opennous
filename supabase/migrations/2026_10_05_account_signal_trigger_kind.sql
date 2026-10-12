-- Account signal automations can be saved (GET-708).
--
-- GET-686 added the "When an account signal lands" trigger and its runner, but the table's
-- trigger_kind check (2026_09_29_automation_flows.sql) never learned the new kind, so every save
-- of one was refused by the database. Same list, plus account_signal.
--
-- Safe to run more than once. Nothing here rewrites or drops a row.

alter table public.agent_routines drop constraint if exists agent_routines_trigger_kind_check;
alter table public.agent_routines add constraint agent_routines_trigger_kind_check
  check (trigger_kind in (
    -- conversations
    'call_ended', 'before_meeting', 'email_received', 'reply_owed', 'thread_quiet',
    -- account signals
    'account_signal',
    'health_changed', 'champion_quiet', 'committee_joined', 'icp_tier_changed',
    'expansion_signal', 'promise_overdue', 'posthog_event',
    -- deals
    'deal_stage_changed', 'deal_closed_won', 'deal_closed_lost', 'deal_stalled', 'deal_created',
    -- other
    'clock', 'webhook_in', 'manual',
    -- legacy
    'call_scored', 'condition'
  ));
