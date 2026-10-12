-- Pipeline-stage decay — v2-substrate rewrite.
--
-- The original `decay_pipeline_stages()` (in schema.sql §5) was written for v1
-- and reads `contact_activity_log` + UPDATEs `contacts` directly. Both of those
-- shapes are gone in v2:
--   - `contact_activity_log` was dropped (activities now live in `observations`
--     with property = 'interaction.*')
--   - `contacts` is now a view backed by `claims`, not a writable table
-- The nightly cron has been silently failing because of this.
--
-- This rewrite preserves the same decay rules but speaks v2:
--   - reads activity from `observations` (property LIKE 'interaction.*')
--   - decays by INSERTing a state observation with property = 'pipeline_stage'
--     and the new (lower) value. The claim engine (`claim_jobs` queue, drained
--     every minute by apps/worker/src/workers/claimEngine.mjs) recomputes the
--     `pipeline_stage` claim from observations — so the new stage shows up on
--     the contact within a minute. Idiomatic v2: observation in, claim out.
--
-- Manual overrides are protected: entities whose `pipeline_stage_source` claim
-- is 'manual' are excluded from decay, matching the v1 contract.
--
-- Decay thresholds (unchanged from v1):
--   evaluating → interested   no qualifying activity in 60d
--   interested → aware        no qualifying activity in 30d
--   aware      → identified   no qualifying activity in 30d
--   client                    never decays (excluded by the WHERE clause)
--
-- Safe to re-run. Idempotent — if it runs twice in the same second on the
-- same entity, the claim engine just recomputes the claim twice with the
-- same result.

CREATE OR REPLACE FUNCTION decay_pipeline_stages()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
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
          'interaction.website_revisit'
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
