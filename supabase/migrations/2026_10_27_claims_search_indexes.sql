-- Hybrid search over facts (GET-1056), part 1 of 2: the indexes. Part 2 is
-- 2026_10_27_hybrid_claim_search.sql (the RPCs), which works without these, only slower.
--
-- RUN OUTSIDE A TRANSACTION. Every statement is CREATE INDEX CONCURRENTLY, which Postgres refuses
-- inside a transaction block. With psql: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>`
-- (NO -1 / --single-transaction). In the Supabase SQL editor, run ONE statement at a time (the
-- editor wraps a multi-statement run in a transaction). Apply this file BEFORE part 2.
--
-- Why an expression index and not a stored tsvector column: `ADD COLUMN ... GENERATED ALWAYS AS
-- (...) STORED` rewrites every row of claims under an ACCESS EXCLUSIVE lock, i.e. the whole table
-- is unreadable and unwritable for the length of the rewrite. CREATE INDEX CONCURRENTLY builds
-- beside the live table (SHARE UPDATE EXCLUSIVE: reads and writes go on) and costs only the index.
-- The price is that the query must repeat the indexed expression exactly; search_claims_keyword
-- does (part 2), and EXPLAIN on a throwaway Postgres shows the index used (GET-1056 PR).
--
-- Partial on live facts (note.* claims, not invalidated, not documents): the facts corpus is a
-- small share of claims, so the index is a fraction of the table and builds in a fraction of the
-- time. Documents are left out on purpose: they are long (a transcript can exceed what to_tsvector
-- accepts, 1MB of tsvector, which would FAIL the build), and the facts search never returns them.
-- left(..., 20000) is the belt to that: no fact is near it, and no row can break the build.
--
-- If a CONCURRENTLY build is interrupted it leaves an INVALID index behind, and IF NOT EXISTS then
-- skips it on a re-run. After applying, check:
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('claims_note_fts', 'claims_note_market_entity',
--                        'market_entities_name_trgm', 'market_entity_aliases_alias_trgm');
-- and for any indisvalid = false: DROP INDEX CONCURRENTLY <name>; then run its CREATE again.
--
-- Public: the search is open-source code. Idempotent.

SET statement_timeout = 0;

-- pg_trgm is already in the baseline (and on Supabase); a fresh self-host may not have it yet.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- The keyword arm. The expression is repeated verbatim in search_claims_keyword.
CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_note_fts ON public.claims USING gin (
  to_tsvector('english'::regconfig, left(coalesce(value->>'content', '') || ' ' || coalesce(value->>'label', ''), 20000))
) WHERE property LIKE 'note.%' AND invalid_at IS NULL AND (value->'metadata'->>'doc_type') IS NULL;

-- The names arm, market side: the facts that name a market entity (GET-1049 writes the id).
CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_note_market_entity
  ON public.claims (workspace_id, ((value->'metadata'->>'market_entity_id')))
  WHERE property LIKE 'note.%' AND invalid_at IS NULL AND (value->'metadata'->>'market_entity_id') IS NOT NULL;

-- The names arm, name side. entity_list_rows.name already has entity_list_name_trgm; the market
-- entity tables are small, but a trigram match on them should not be a scan as they grow.
CREATE INDEX CONCURRENTLY IF NOT EXISTS market_entities_name_trgm
  ON public.market_entities USING gin (canonical_name public.gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS market_entity_aliases_alias_trgm
  ON public.market_entity_aliases USING gin (alias public.gin_trgm_ops);

RESET statement_timeout;
