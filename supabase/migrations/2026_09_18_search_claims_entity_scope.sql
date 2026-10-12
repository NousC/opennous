-- Dedup asks about ONE record, so search one record (GET-329).
--
-- "Have we already said this?" is always about a subject. A note about Larkfield Toyota was never going to
-- be a duplicate of a note about a different dealership — but the search read every note in the
-- workspace to establish that: thousands of them on the largest, each carrying a 1536-dimension
-- embedding. That is what put it over PostgREST's 8s statement_timeout often enough to lose ~11% of
-- duplicate checks, silently, because a failed search and an empty one both return no rows.
--
-- Measured on the same eight vectors:
--
--   workspace-wide   340 - 6,656 ms   (max within a whisker of the 8s ceiling)
--   entity-scoped      0.6 -    94 ms
--
-- The scope is the entity the fact will LAND on, not the contact it was voiced by — a company fact
-- from two different people targets the same company entity, so it still dedups against itself.
-- That derivation now lives in one place (claimTargetEntity) because the write and the dedup both
-- need it, and deriving it twice is the failure this codebase keeps paying for.
--
-- Both parameters stay optional and the unfiltered path is untouched, so the agent's own searches
-- are unaffected.
CREATE OR REPLACE FUNCTION public.search_claims(
  p_workspace_id uuid,
  p_embedding vector,
  p_threshold double precision,
  p_limit integer,
  p_property_prefix text DEFAULT NULL::text,
  p_entity_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, confidence real,
              freshness text, valid_from timestamp with time zone, similarity double precision)
LANGUAGE plpgsql
STABLE
AS $function$
  DECLARE v vector(1536) := p_embedding;
  BEGIN
    IF p_property_prefix IS NULL AND p_entity_id IS NULL THEN
      RETURN QUERY
      SELECT t.id, t.entity_id, t.property, t.value, t.confidence, t.freshness, t.valid_from, t.similarity
      FROM (
        SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from,
               (1 - (c.embedding <=> v))::FLOAT AS similarity
        FROM claims c
        WHERE c.workspace_id = p_workspace_id AND c.embedding IS NOT NULL AND c.invalid_at IS NULL
        ORDER BY c.embedding <=> v
        LIMIT p_limit
      ) t
      WHERE t.similarity >= p_threshold
      ORDER BY t.similarity DESC;
    ELSE
      RETURN QUERY
      WITH top AS MATERIALIZED (
        SELECT c.id, (1 - (c.embedding <=> v))::FLOAT AS similarity
        FROM claims c
        WHERE c.workspace_id = p_workspace_id
          AND c.embedding IS NOT NULL
          AND c.invalid_at IS NULL
          AND (p_entity_id IS NULL OR c.entity_id = p_entity_id)
          AND (p_property_prefix IS NULL OR c.property LIKE p_property_prefix || '%')
        ORDER BY c.embedding <=> v
        LIMIT p_limit
      )
      SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from, top.similarity
      FROM top JOIN claims c ON c.id = top.id
      WHERE top.similarity >= p_threshold
      ORDER BY top.similarity DESC;
    END IF;
  END $function$;
