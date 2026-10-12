-- Follow-up write-back to HubSpot (workspace redesign Phase 4, Oct 2026).
--
-- With this on, the follow-up card's primary button reads "Sync to HubSpot": the approved tasks
-- become HubSpot tasks and the approved updates one note on the deal, and the email a draft in the
-- approver's own Gmail. Nothing is sent and no deal property is ever written. It is approval-driven
-- only; automatic mirroring (registerCrmPushHandler) stays off.
--
-- Per workspace, OFF by default, and switched on only after the customer has granted HubSpot write
-- access (tasks and notes). Until then the card's button stays "Approve".
--
-- Additive: two columns on an existing table, a constant default (no table rewrite). Safe to re-run.

set lock_timeout = '5s';

alter table public.follow_up_settings
  add column if not exists crm_writeback boolean not null default false;

alter table public.follow_up_settings
  add column if not exists crm_writeback_enabled_at timestamptz;

comment on column public.follow_up_settings.crm_writeback is
  'Approved follow-ups sync to HubSpot (tasks, one note on the deal) and the email becomes a Gmail draft. Off until the customer grants HubSpot write scopes.';
comment on column public.follow_up_settings.crm_writeback_enabled_at is
  'When write-back was switched on for this workspace.';
