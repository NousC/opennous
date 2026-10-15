-- The entity-scoped search fetches the entity's rows FIRST, then ranks them (GET-411).
--
-- 2026_09_18_search_claims_entity_scope added `p_entity_id` and measured 0.6–94 ms. Measured again
-- on prod today, on the same shape (Larkfield Systems, 'note.' prefix, entity given):
--
--   call 1  23,395 ms  statement timeout
--   call 2   5,373 ms
--   call 3  27,769 ms  statement timeout
--   call 4–8  1–8 s
--
-- The branch put the entity filter and `ORDER BY embedding <=> v LIMIT n` in ONE query, and the
-- planner does what that asks: walk the vector index across the whole workspace in distance order
-- and throw away every row that is not this entity's. For an entity holding a few hundred of a
-- workspace's hundreds of thousands of embedded claims that is a walk over nearly all of them. Under an extraction run it is what
-- produced seven statement timeouts in one three-meeting re-read — and every timed-out dedup check
-- ADDS the fact ("NOTE_DEDUP_BLIND"), which is how the duplicates got in.
--
-- So the entity path is two steps that the planner cannot fold together: the entity's candidate
-- rows through the btree (claims_entity_property, tiny), materialised; then the distance over that
-- set. No vector index involved, none needed — a few hundred rows compare in single-digit ms.
--
-- The workspace-wide path (the agent's own search) is unchanged.
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
    IF p_entity_id IS NOT NULL THEN
      -- ONE ENTITY: its rows first, by btree; then the distance over that handful.
      RETURN QUERY
      WITH cand AS MATERIALIZED (
        SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from, c.embedding
        FROM claims c
        WHERE c.workspace_id = p_workspace_id
          AND c.entity_id = p_entity_id
          AND c.invalid_at IS NULL
          AND c.embedding IS NOT NULL
          AND (p_property_prefix IS NULL OR c.property LIKE p_property_prefix || '%')
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
    ELSIF p_property_prefix IS NULL THEN
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
          AND c.property LIKE p_property_prefix || '%'
        ORDER BY c.embedding <=> v
        LIMIT p_limit
      )
      SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from, top.similarity
      FROM top JOIN claims c ON c.id = top.id
      WHERE top.similarity >= p_threshold
      ORDER BY top.similarity DESC;
    END IF;
  END $function$;
