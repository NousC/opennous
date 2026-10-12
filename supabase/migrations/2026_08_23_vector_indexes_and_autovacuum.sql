-- Vector-index + autovacuum audit/cleanup for the embedding tables.
--
-- CONTEXT: the 2026-08-18 IO outage was seq scans over vector(1536) columns on
-- never-ANALYZEd tables. A follow-up audit *suspected* `claims` had no ANN index
-- (schema.sql only shows observations_embedding), but LIVE VERIFICATION on 2026-08-23
-- found that stale — `claims` already has a valid ivfflat cosine index `claims_embedding`
-- (424 MB, lists=100) from the outage fix, and it IS used (EXPLAIN shows Index Scan on
-- the `embedding <=> $1` order-by, ~23ms, no seq scan). The three knowledge/asset
-- vector-store tables the audit flagged do NOT exist in prod (dead legacy match_* fns).
--
-- So there was no missing index to add. What this migration DOES, all idempotent:
--   1. Ensure the autovacuum ANALYZE/VACUUM policy is set on both embedding-heavy tables
--      (claims was already tuned; observations set here) so planner stats stay fresh —
--      the true root-cause fix, vs a one-off VACUUM ANALYZE.
--   2. Drop the orphaned invalid `claims_embedding_ccnew` (0 bytes) left over from an
--      interrupted REINDEX CONCURRENTLY — cruft that could collide with a future reindex.
--
-- Applied to prod via MCP 2026-08-23. Safe to re-run.

ALTER TABLE public.claims       SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.observations SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);

DROP INDEX IF EXISTS public.claims_embedding_ccnew;

ANALYZE public.claims;
ANALYZE public.observations;

-- NOTE: do NOT add a second ivfflat index on claims.embedding — `claims_embedding`
-- already covers the cosine `<=>` search path. A partial duplicate was created and
-- removed during the 2026-08-23 audit.
