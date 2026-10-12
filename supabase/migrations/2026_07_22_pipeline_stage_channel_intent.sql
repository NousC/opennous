-- Channel- and intent-aware pipeline stage.
--
-- The problem: a contact is not automatically a lead. compute_contact_pipeline_stage
-- promoted anyone who sent a LinkedIn message, accepted a connection, or sent ANY email
-- reply straight to "interested" — so a friend you connect with on LinkedIn (or anyone
-- who fires a neutral reply) reads as an interested deal. Interaction was being treated
-- as intent.
--
-- The fix re-buckets three EXISTING activity types (nothing new is invented):
--   * linkedin_connected  interested -> aware   (a connection is "we're linked", not a deal)
--   * linkedin_message    interested -> aware   (chat is not intent)
--   * email_reply         interested -> aware   (a raw/neutral reply is not interest)
--
-- What still promotes, unchanged:
--   * A POSITIVE email reply already lands as `outbound_positive_reply` (classified at
--     ingest by the reply-sentiment pass) and sits in EVALUATING — so extracted positive
--     intent, not the raw reply, is what advances an email relationship.
--   * A held meeting (`meeting_held`) is in EVALUATING — so a LinkedIn relationship only
--     climbs past "aware" once a real meeting happens, which is the intended bar.
--   * content_download / community_joined / event_attended / website_revisit stay in
--     INTERESTED: those are genuine medium-intent actions, not passive touches.
--
-- Net: LinkedIn-only and raw-reply relationships top out at "aware" until a meeting or a
-- classified-positive signal appears. This is what makes the Accounts page show the right
-- stage, everywhere, not just in the revenue report.

CREATE OR REPLACE FUNCTION public.compute_contact_pipeline_stage(p_contact_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_stage TEXT := 'identified';
BEGIN
  -- CLIENT: permanent — any closed signal ever recorded
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN ('proposal_signed','deal_won','payment_received')
  ) THEN
    RETURN 'client';
  END IF;

  -- EVALUATING: high-intent signal within last 60 days. A held meeting and a
  -- classified-positive reply (outbound_positive_reply) live here — real intent, on any
  -- channel, is what promotes a relationship this far.
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'meeting_held',
        'pricing_page_visit',
        'proposal_sent',
        'proposal_viewed',
        'outbound_positive_reply',
        'deal_created',
        'trial_started'
      )
      AND occurred_at >= now() - interval '60 days'
  ) THEN
    RETURN 'evaluating';
  END IF;

  -- INTERESTED: medium-intent ACTIONS within last 30 days. A raw email reply and bare
  -- LinkedIn connect/message were removed from here (they are touches, not intent, and
  -- now count as `aware`); only deliberate actions remain.
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'content_download',
        'community_joined',
        'event_attended',
        'website_revisit'
      )
      AND occurred_at >= now() - interval '30 days'
  ) THEN
    RETURN 'interested';
  END IF;

  -- AWARE: low-intent touches within last 30 days. A LinkedIn connection or message and
  -- a raw email reply are touches — real, but not a buying motion — so they land here.
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'email_reply',
        'linkedin_message',
        'linkedin_connected',
        'website_visit',
        'email_opened',
        'linkedin_view',
        'social_engagement',
        'ad_impression',
        'newsletter_signup'
      )
      AND occurred_at >= now() - interval '30 days'
  ) THEN
    RETURN 'aware';
  END IF;

  RETURN 'identified';
END;
$$;

-- Existing contacts keep their current stage until their next activity triggers a
-- recompute (trigger_recompute_pipeline_stage). A one-time backfill that re-derives every
-- AUTO-sourced contact's stage is intentionally NOT bundled here: the only recompute
-- helper (set_contact_pipeline_stage) also flips pipeline_stage_source to 'manual', which
-- would permanently freeze those contacts from auto-recompute. A safe backfill (updating
-- the pipeline_stage claim in place while preserving source='auto') should be run and
-- verified separately.
