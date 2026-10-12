-- "When did this source last bring something in?" (GET-335)
--
-- The Sources page asks that once per connected source, in parallel. There was no index that
-- could answer it, so each question became a parallel sequential scan of `observations`:
-- 26 seconds and a million rows read to return one timestamp, or — more often in production —
-- death at the 8 second statement timeout.
--
-- Measured before: Parallel Seq Scan, rows=516235 loops=2, Execution Time 26193 ms.
-- With this index the same question is an index scan that stops at the first row.
--
-- `ingested_at DESC` matches the ORDER BY, so the newest row for a (workspace, source) pair is
-- the first entry read rather than the result of sorting half a million of them.
--
-- CONCURRENTLY so it does not lock a table the importer is writing to. Note that this cannot run
-- inside a transaction block — apply it on its own.
create index concurrently if not exists observations_ws_source_ingested
  on public.observations (workspace_id, source, ingested_at desc);
