-- CRM create policy — gate WHEN a prospect earns a brand-new record in the CRM.
--
-- Until now any pushable activity auto-created the contact in the CRM (the
-- resolve step did find-or-create unconditionally). That pollutes the CRM with
-- every cold prospect who so much as replied "unsubscribe". These columns let
-- each workspace decide the trigger that promotes a prospect into the CRM and
-- an ICP-fit floor, so every created record is an earned, on-target hand-raise.
--
--   create_trigger:
--     any_reply_or_meeting      — any inbound reply or booked meeting
--     positive_reply_or_meeting — reply classified positive, or a booked meeting (default)
--     meeting_only              — only a booked meeting
--     interested_stage          — contact has reached the 'interested' pipeline stage

ALTER TABLE crm_sync_configs
  ADD COLUMN IF NOT EXISTS create_in_crm          BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS create_trigger         TEXT    NOT NULL DEFAULT 'positive_reply_or_meeting',
  ADD COLUMN IF NOT EXISTS create_require_icp_fit BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS create_icp_threshold   INTEGER NOT NULL DEFAULT 70;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_sync_configs_create_trigger_chk') THEN
    ALTER TABLE crm_sync_configs ADD CONSTRAINT crm_sync_configs_create_trigger_chk
      CHECK (create_trigger IN ('any_reply_or_meeting', 'positive_reply_or_meeting', 'meeting_only', 'interested_stage'));
  END IF;
END $$;
