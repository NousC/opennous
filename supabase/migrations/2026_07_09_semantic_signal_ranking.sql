-- Semantic query was ranking on pure cosine over a corpus that was ~91% noise.
--
-- The embedding worker vectorized EVERY observation — identity fields, derived
-- pipeline stage, photo URLs, lead-list field imports — so a "who should I focus
-- on" embedding landed nearest the tens of thousands of dense cold-lead field
-- rows, not the few hundred real engagement signals. search_observations then
-- ordered by `embedding <=> v` alone, with no signal weight, recency, or property
-- filter. Result: cold inbound / enrichment noise outranked high-intent accounts.
--
-- Two parts:
--   1. BACKFILL — drop the embeddings on non-signal observations so they leave the
--      search pool. The worker (see workers/embeddings.mjs) no longer re-embeds
--      them: it now only embeds note.* + interaction.* rows.
--   2. RE-RANK — search_observations now restricts candidates to note.* / interaction.*
--      and ranks by cosine × signal_weight × recency, not cosine alone. It pulls a
--      candidate pool by the fast vector index, then re-ranks that pool — so the
--      index still does the heavy lifting.
--
-- Idempotent: the backfill only nulls rows that should never have been embedded;
-- the function is CREATE OR REPLACE with an unchanged signature.

-- ── 1. Backfill: evict non-signal rows from the vector index ──────────────────
UPDATE observations
SET embedding = NULL
WHERE embedding IS NOT NULL
  AND property NOT LIKE 'note.%'
  AND property NOT LIKE 'interaction.%';

-- ── 2. Signal-weighted semantic search ───────────────────────────────────────
CREATE OR REPLACE FUNCTION search_observations(
  p_workspace_id    UUID,
  p_embedding       VECTOR(1536),
  p_kind            TEXT        DEFAULT NULL,
  p_property_prefix TEXT        DEFAULT NULL,
  p_source          TEXT        DEFAULT NULL,
  p_since           TIMESTAMPTZ DEFAULT NULL,
  p_limit           INT         DEFAULT 50
)
RETURNS TABLE (
  id UUID, entity_id UUID, property TEXT, value JSONB,
  source TEXT, observed_at TIMESTAMPTZ, similarity FLOAT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE v vector(1536) := p_embedding;
BEGIN
  RETURN QUERY
  -- Re-rank a candidate pool (pulled fast by the vector index) so relevance is
  -- cosine × signal quality × recency, not cosine alone.
  SELECT c.id, c.entity_id, c.property, c.value, c.source, c.observed_at, c.similarity
  FROM (
    SELECT o.id, o.entity_id, o.property, o.value, o.source, o.observed_at,
           (1 - (o.embedding <=> v))::FLOAT AS similarity
    FROM observations o
    WHERE o.workspace_id = p_workspace_id
      AND o.embedding IS NOT NULL
      -- Only searchable meaning. Identity/stage/field rows never rank.
      AND (o.property LIKE 'note.%' OR o.property LIKE 'interaction.%')
      AND (p_kind            IS NULL OR o.kind = p_kind)
      AND (p_property_prefix IS NULL OR o.property ILIKE p_property_prefix || '%')
      AND (p_source          IS NULL OR o.source = p_source)
      AND (p_since           IS NULL OR o.observed_at >= p_since)
    ORDER BY o.embedding <=> v          -- vector index does the narrowing
    LIMIT GREATEST(p_limit * 5, 200)
  ) c
  ORDER BY
    c.similarity
    -- Signal weight, three tiers. Distilled facts and genuine two-way engagement
    -- carry full weight; one-way outbound touches half; operational/system events
    -- (added_to_campaign, enrichment_run, icp_scored, opens, signups) are near-zero
    -- so they never answer "who should I focus on".
    * CASE
        WHEN c.property LIKE 'note.%' THEN 1.0
        WHEN c.property IN (
          'interaction.email_replied', 'interaction.email_reply', 'interaction.positive_reply',
          'interaction.linkedin_reply', 'interaction.reply', 'interaction.email_received',
          'interaction.meeting_scheduled', 'interaction.meeting_held',
          'interaction.linkedin_connected', 'interaction.call_held', 'interaction.deal_won'
        ) THEN 1.0
        WHEN c.property IN (
          'interaction.linkedin_message', 'interaction.linkedin_post_engagement',
          'interaction.linkedin_engagement_comment', 'interaction.email_sent', 'interaction.proposal_sent'
        ) THEN 0.5
        ELSE 0.15
      END
    -- Recency: 90-day half-life, but never fully discounts an old-but-relevant hit.
    * (0.5 + 0.5 * exp(-EXTRACT(EPOCH FROM (now() - c.observed_at)) / (90 * 86400)))
    DESC
  LIMIT p_limit;
END $$;
