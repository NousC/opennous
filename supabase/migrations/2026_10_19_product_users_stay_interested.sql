-- Product users stay interested (GET-751).
--
-- A PostHog signup (interaction.signed_up) or a week of product use (interaction.product_used,
-- written by the daily usage pull) moves a person to 'interested', so they show on People and
-- their account on Accounts. Without this, the nightly decay would move them back to 'aware'
-- after 30 days, because it only counted replies, LinkedIn messages and the like as keeping
-- someone interested. Someone who keeps using the product stays; someone who stops decays as
-- before. Re-runnable: CREATE OR REPLACE of the same function with two more properties.

CREATE OR REPLACE FUNCTION public.decay_pipeline_stages() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- ── evaluating → interested ───────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"interested"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'evaluating'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.meeting_held',
          'interaction.pricing_page_visit',
          'interaction.proposal_sent',
          'interaction.proposal_viewed',
          'interaction.outbound_positive_reply',
          'interaction.deal_created',
          'interaction.trial_started'
        )
        AND o.observed_at >= now() - interval '60 days'
    );

  -- ── interested → aware ────────────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"aware"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'interested'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.email_reply',
          'interaction.linkedin_message',
          'interaction.linkedin_connected',
          'interaction.content_download',
          'interaction.community_joined',
          'interaction.event_attended',
          'interaction.website_revisit',
          'interaction.signed_up',
          'interaction.product_used'
        )
        AND o.observed_at >= now() - interval '30 days'
    );

  -- ── aware → identified ────────────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"identified"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'aware'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.website_visit',
          'interaction.email_opened',
          'interaction.linkedin_view',
          'interaction.social_engagement',
          'interaction.ad_impression',
          'interaction.newsletter_signup'
        )
        AND o.observed_at >= now() - interval '30 days'
    );
END;
$$;

