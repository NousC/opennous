-- Filter before the vector math when the caller says which slice it wants (GET-329).
--
-- The dedup pass searches note.* claims only, and it timed out four times in a 25-thread sample.
-- Each timeout degraded silently to "no similar notes found", which the caller reads as ADD — so
-- duplicate claims were written with nothing saying why.
--
-- EXPLAIN says the cause is not the filter being slow. It is WHERE the filter runs:
--
--   Index Scan using claims_embedding  (cost=2101.51..503835.42)
--     Order By: (embedding <=> $1)
--     Filter: (property ~~ 'note.%' AND workspace_id = ... AND invalid_at IS NULL)
--
-- The ivfflat index supplies rows in distance order and the property filter is applied to each one
-- afterwards, so the scan walks the vector index discarding non-notes until it has collected
-- p_limit of them. Notes are well under 1% of the claims on a large workspace, so how far it walks
-- depends on where the query vector happens to land. Measured at 417ms on one vector and past the
-- statement timeout on others. It is a lottery, not a constant, which is exactly why it failed
-- intermittently and looked like nothing was wrong.
--
-- With a prefix, the candidate set is small and known, so building it FIRST and sorting that by
-- distance is both faster and — more importantly — bounded. MATERIALIZED is load-bearing: without
-- it the planner inlines the CTE and chooses the same ivfflat plan again.
--
-- The NO-PREFIX path is untouched. There the candidate set is the whole workspace and the ivfflat
-- index is the right tool; materialising that would scan everything and make the agent's own
-- searches worse. One function, two regimes, because the two questions are genuinely different.
CREATE OR REPLACE FUNCTION public.search_claims(
  p_workspace_id uuid,
  p_embedding vector,
  p_threshold double precision,
  p_limit integer,
  p_property_prefix text DEFAULT NULL::text
)
RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, confidence real,
              freshness text, valid_from timestamp with time zone, similarity double precision)
LANGUAGE plpgsql
STABLE
AS $function$
  DECLARE v vector(1536) := p_embedding;
  BEGIN
    IF p_property_prefix IS NULL THEN
      RETURN QUERY
      SELECT t.id, t.entity_id, t.property, t.value, t.confidence, t.freshness, t.valid_from, t.similarity
      FROM (
        SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from,
               (1 - (c.embedding <=> v))::FLOAT AS similarity
        FROM claims c
        WHERE c.workspace_id = p_workspace_id
          AND c.embedding IS NOT NULL
          AND c.invalid_at IS NULL
        ORDER BY c.embedding <=> v
        LIMIT p_limit
      ) t
      WHERE t.similarity >= p_threshold
      ORDER BY t.similarity DESC;
    ELSE
      RETURN QUERY
      WITH cand AS MATERIALIZED (
        SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from, c.embedding
        FROM claims c
        WHERE c.workspace_id = p_workspace_id
          AND c.embedding IS NOT NULL
          AND c.invalid_at IS NULL
          AND c.property LIKE p_property_prefix || '%'
      )
      SELECT t.id, t.entity_id, t.property, t.value, t.confidence, t.freshness, t.valid_from, t.similarity
      FROM (
        SELECT cand.id, cand.entity_id, cand.property, cand.value, cand.confidence, cand.freshness,
               cand.valid_from, (1 - (cand.embedding <=> v))::FLOAT AS similarity
        FROM cand
        ORDER BY cand.embedding <=> v
        LIMIT p_limit
      ) t
      WHERE t.similarity >= p_threshold
      ORDER BY t.similarity DESC;
    END IF;
  END $function$;

-- Also applied to prod, kept here so the repo and the database agree.
--
-- HONEST NOTE ON WHAT THIS INDEX DOES: it does NOT help the dedup search. A plain btree cannot
-- serve `property LIKE 'note.%'` under the default collation — that would need text_pattern_ops —
-- and measuring showed the prefix filter was never the bottleneck anyway. It does serve the
-- EQUALITY lookups on (workspace_id, property) that run constantly, notably getInternalEntityIds
-- (property = 'is_internal'), which the Gmail backfill calls once per person.
CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_ws_property_live
  ON public.claims (workspace_id, property) WHERE invalid_at IS NULL;
