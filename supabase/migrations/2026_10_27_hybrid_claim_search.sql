-- Hybrid search over facts (GET-1056), part 2 of 2: the RPCs behind hybridSearchClaims
-- (packages/core/src/db/hybridSearch.ts). Part 1, 2026_10_27_claims_search_indexes.sql, builds
-- their indexes CONCURRENTLY and must run outside a transaction; this file is an ordinary
-- transaction. Apply part 1 first (these work without it, only slower).
--
-- search_claims_keyword(ws, q, lim, since, until): full-text search over a fact's content + label.
--   Terms are OR-joined (Hindsight's prepare_bm25_text, MIT: an AND query of a whole question
--   matches almost nothing), at most 16, ranked by ts_rank_cd, id as the tiebreak (ts_rank_cd has
--   few distinct values, so a LIMIT cut must be stable). since/until (dates, inclusive) keep the
--   facts SAID inside the window (valid_from) or that HAPPENED inside it (value.metadata.occurred_*,
--   GET-1051). With a window and no searchable term, the window's facts newest first.
-- search_names(ws, terms, lim): the facts on the records a question names. `terms` are the 1-3
--   word spans of the question (built in JS, nameTerms); each is trigram-matched (pg_trgm) to
--   account and person names (entity_list_rows) and to market entity names and aliases (GET-1049).
--   An account or person match returns the facts ON it; a market entity match returns the facts
--   that NAME it (value.metadata.market_entity_id, merged-away duplicates included).
--   Taking spans rather than the raw question is what lets the trigram index work: a short name
--   inside a long question is word_similarity(name, q), which no index serves.
--
-- Facts only: property note.*, live (invalid_at IS NULL), not a document. Both are SECURITY
-- INVOKER and service-role only, so RLS on claims is untouched; per-viewer privacy is applied by
-- the caller, as for search_claims. Idempotent.
BEGIN;

-- The OR query. Lexemes come from to_tsvector (stemmed, English stopwords off), in question order,
-- and each is turned back into a tsquery with plainto_tsquery('simple', ...), so no user text is
-- ever parsed as tsquery syntax. NULL when nothing is left to search.
CREATE OR REPLACE FUNCTION public.claims_fts_or_query(q text)
RETURNS tsquery
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  DECLARE
    tq tsquery;
    lex text;
  BEGIN
    IF q IS NULL OR btrim(q) = '' THEN RETURN NULL; END IF;
    FOR lex IN
      SELECT t.lexeme FROM unnest(to_tsvector('english'::regconfig, left(q, 2000))) t
      ORDER BY t.positions[1], t.lexeme
      LIMIT 16
    LOOP
      tq := CASE WHEN tq IS NULL THEN plainto_tsquery('simple'::regconfig, lex)
                 ELSE tq || plainto_tsquery('simple'::regconfig, lex) END;
    END LOOP;
    RETURN tq;
  END $function$;

CREATE OR REPLACE FUNCTION public.search_claims_keyword(
  ws uuid,
  q text,
  lim integer DEFAULT 50,
  since date DEFAULT NULL,
  until date DEFAULT NULL
)
RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, valid_from timestamp with time zone,
              confidence real, freshness text, supporting_observation_ids uuid[], rank real)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
  DECLARE
    tq tsquery := public.claims_fts_or_query(q);
    n integer := least(greatest(coalesce(lim, 50), 1), 200);
    s text := to_char(since, 'YYYY-MM-DD');
    u text := to_char(until, 'YYYY-MM-DD');
  BEGIN
    IF tq IS NULL AND since IS NULL AND until IS NULL THEN RETURN; END IF;

    IF tq IS NULL THEN
      -- A window and nothing to rank by: the window's facts, newest first.
      RETURN QUERY
      SELECT c.id, c.entity_id, c.property, c.value, c.valid_from, c.confidence, c.freshness,
             c.supporting_observation_ids, 0::real
      FROM claims c
      WHERE c.workspace_id = ws
        AND c.property LIKE 'note.%' AND c.invalid_at IS NULL AND (c.value->'metadata'->>'doc_type') IS NULL
        AND (
          ((s IS NULL OR to_char(c.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= s)
            AND (u IS NULL OR to_char(c.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= u))
          OR ((c.value->'metadata'->>'occurred_start') IS NOT NULL
            AND (u IS NULL OR (c.value->'metadata'->>'occurred_start') <= u)
            AND (s IS NULL OR coalesce(c.value->'metadata'->>'occurred_end', c.value->'metadata'->>'occurred_start') >= s))
        )
      ORDER BY c.valid_from DESC NULLS LAST, c.id
      LIMIT n;
      RETURN;
    END IF;

    -- The to_tsvector(...) expression and the three predicates below are the claims_note_fts
    -- index's, verbatim; change one and the index is no longer used.
    RETURN QUERY
    SELECT c.id, c.entity_id, c.property, c.value, c.valid_from, c.confidence, c.freshness,
           c.supporting_observation_ids,
           ts_rank_cd(to_tsvector('english'::regconfig, left(coalesce(c.value->>'content', '') || ' ' || coalesce(c.value->>'label', ''), 20000)), tq) AS rank
    FROM claims c
    WHERE c.workspace_id = ws
      AND c.property LIKE 'note.%' AND c.invalid_at IS NULL AND (c.value->'metadata'->>'doc_type') IS NULL
      AND to_tsvector('english'::regconfig, left(coalesce(c.value->>'content', '') || ' ' || coalesce(c.value->>'label', ''), 20000)) @@ tq
      AND (
        (since IS NULL AND until IS NULL)
        OR ((s IS NULL OR to_char(c.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') >= s)
          AND (u IS NULL OR to_char(c.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') <= u))
        OR ((c.value->'metadata'->>'occurred_start') IS NOT NULL
          AND (u IS NULL OR (c.value->'metadata'->>'occurred_start') <= u)
          AND (s IS NULL OR coalesce(c.value->'metadata'->>'occurred_end', c.value->'metadata'->>'occurred_start') >= s))
      )
    ORDER BY rank DESC, c.id
    LIMIT n;
  END $function$;

CREATE OR REPLACE FUNCTION public.search_names(
  ws uuid,
  terms text[],
  lim integer DEFAULT 50
)
RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, valid_from timestamp with time zone,
              confidence real, freshness text, supporting_observation_ids uuid[], rank real,
              matched_name text, matched_kind text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH t AS (
    SELECT DISTINCT lower(btrim(x)) AS term
    FROM unnest(terms[1:24]) x
    WHERE length(btrim(x)) >= 3
  ),
  -- Two ways a span names a record, both served by the trigram index: the whole name is close to
  -- it (`%`, then similarity >= 0.45: "harborline" ~ "Harborline", "fernpoint lab" ~ "Fernpoint
  -- Labs"), or it is one whole word of the name (`<<%`, then strict_word_similarity >= 0.8: "mara"
  -- in "Mara Okafor", which similarity alone puts at 0.45 and a longer surname below it). The
  -- word match scores 0.9 of its strength, so the full name outranks a first name.
  records AS (
    SELECT r.entity_id AS target, r.kind, r.name,
           max(greatest(similarity(r.name, t.term), 0.9 * strict_word_similarity(t.term, r.name))) AS sim
    FROM entity_list_rows r JOIN t ON (r.name % t.term OR t.term <<% r.name)
    WHERE r.workspace_id = ws AND r.kind IN ('account', 'person')
      AND (similarity(r.name, t.term) >= 0.45 OR strict_word_similarity(t.term, r.name) >= 0.8)
    GROUP BY r.entity_id, r.kind, r.name
    ORDER BY sim DESC, r.entity_id
    LIMIT 10
  ),
  market_hits AS (
    SELECT coalesce(m.merged_into_id, m.id) AS me, m.canonical_name AS name,
           greatest(similarity(m.canonical_name, t.term), 0.9 * strict_word_similarity(t.term, m.canonical_name)) AS sim
    FROM market_entities m JOIN t ON (m.canonical_name % t.term OR t.term <<% m.canonical_name)
    WHERE m.workspace_id = ws
      AND (similarity(m.canonical_name, t.term) >= 0.45 OR strict_word_similarity(t.term, m.canonical_name) >= 0.8)
    UNION ALL
    SELECT a.entity_id, a.alias, greatest(similarity(a.alias, t.term), 0.9 * strict_word_similarity(t.term, a.alias))
    FROM market_entity_aliases a JOIN t ON (a.alias % t.term OR t.term <<% a.alias)
    WHERE a.workspace_id = ws
      AND (similarity(a.alias, t.term) >= 0.45 OR strict_word_similarity(t.term, a.alias) >= 0.8)
  ),
  market AS (
    SELECT me, (array_agg(name ORDER BY sim DESC))[1] AS name, max(sim) AS sim
    FROM market_hits GROUP BY me ORDER BY max(sim) DESC, me LIMIT 10
  ),
  -- A merged-away duplicate's facts still carry its own id; they are the survivor's facts too.
  market_ids AS (
    SELECT m.me AS target, m.me AS id, m.name, m.sim FROM market m
    UNION
    SELECT m.me, d.id, m.name, m.sim FROM market m JOIN market_entities d ON d.workspace_id = ws AND d.merged_into_id = m.me
  ),
  hits AS (
    SELECT c.id, c.entity_id, c.property, c.value, c.valid_from, c.confidence, c.freshness,
           c.supporting_observation_ids, r.sim AS rank, r.name AS matched_name, r.kind AS matched_kind,
           row_number() OVER (PARTITION BY r.target ORDER BY c.valid_from DESC NULLS LAST, c.id) AS rn
    FROM records r
    JOIN claims c ON c.workspace_id = ws AND c.entity_id = r.target
    WHERE c.property LIKE 'note.%' AND c.invalid_at IS NULL AND (c.value->'metadata'->>'doc_type') IS NULL
    UNION ALL
    SELECT c.id, c.entity_id, c.property, c.value, c.valid_from, c.confidence, c.freshness,
           c.supporting_observation_ids, m.sim, m.name, 'market_entity',
           row_number() OVER (PARTITION BY m.target ORDER BY c.valid_from DESC NULLS LAST, c.id)
    FROM market_ids m
    JOIN claims c ON c.workspace_id = ws AND (c.value->'metadata'->>'market_entity_id') = m.id::text
    WHERE c.property LIKE 'note.%' AND c.invalid_at IS NULL AND (c.value->'metadata'->>'market_entity_id') IS NOT NULL
      AND (c.value->'metadata'->>'doc_type') IS NULL
  ),
  best AS (
    -- A fact found through two names counts once, at its better match.
    SELECT DISTINCT ON (h.id) h.* FROM hits h WHERE h.rn <= 20
    ORDER BY h.id, h.rank DESC
  )
  SELECT b.id, b.entity_id, b.property, b.value, b.valid_from, b.confidence, b.freshness,
         b.supporting_observation_ids, b.rank::real, b.matched_name, b.matched_kind
  FROM best b
  ORDER BY b.rank DESC, b.valid_from DESC NULLS LAST, b.id
  LIMIT least(greatest(coalesce(lim, 50), 1), 200);
$function$;

REVOKE EXECUTE ON FUNCTION public.claims_fts_or_query(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.search_claims_keyword(uuid, text, integer, date, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.search_names(uuid, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claims_fts_or_query(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_claims_keyword(uuid, text, integer, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_names(uuid, text[], integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
