-- "When a HubSpot field changes" automations can be saved (GET-781).
--
-- Same list as 2026_10_05_account_signal_trigger_kind.sql, plus hubspot_field_changed.
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
    -- deals and CRM
    'deal_stage_changed', 'deal_closed_won', 'deal_closed_lost', 'deal_stalled', 'deal_created',
    'hubspot_field_changed',
    -- other
    'clock', 'webhook_in', 'manual',
    -- legacy
    'call_scored', 'condition'
  ));
