-- The idempotency check that was silently dropping writes (GET-386).
--
-- `recordObservations` looks up an intel claim by `external_id` before inserting, so a re-run is a
-- no-op instead of a duplicate (GET-365). That lookup is a JSONB path filter, and nothing indexed
-- it — every check was a sequential scan of `claims`.
--
-- It worked until the corpus grew and several extraction agents wrote at once. Then the scan
-- exceeded the statement timeout, and the code did the only safe thing it could: skipped the write
-- rather than risk a permanent duplicate with no delete tool to undo it. Correct behaviour,
-- invisible outcome — the caller saw a smaller number and no reason.
--
-- Measured 2026-09-20 during the July backfill: a few claims lost out of ~500 across ~30 meetings,
-- each confirmed by a gap in the `:intel:<n>` sequence, with the cause only visible in the API log
-- ("intel dedupe check failed, skipping: canceling statement due to statement timeout"). The
-- failure rate rises with the size of the table, which means it bites hardest exactly when a
-- backfill is running.
--
-- After this index the same lookup is an index scan: 3 buffer hits, 0.094 ms.
--
-- PARTIAL and EXPRESSION, matching the query's own shape:
--   * the expression mirrors `value->'metadata'->>'external_id'` exactly, or the planner ignores it
--   * `property like 'note.%'` and `invalid_at is null` are in every call site, so the index only
--     covers rows that are actually looked up — 112 kB instead of an index over every claim.
--
-- Applied to production with CREATE INDEX CONCURRENTLY on 2026-09-20 (no table lock); this file
-- records it so a fresh environment gets the same index rather than inheriting the outage.
-- CONCURRENTLY is omitted here because migrations run inside a transaction.

create index if not exists claims_note_external_id_idx
  on claims ((value->'metadata'->>'external_id'))
  where property like 'note.%' and invalid_at is null;
