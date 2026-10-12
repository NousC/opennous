-- The embedding sweep asks "what still needs embedding?" and no index could answer it.
--
-- Symptom, 2026-09-21: the embedding worker failed roughly half its runs, each burning up to
-- 167 SECONDS before the statement timeout killed it, on a cron that fires every two minutes.
-- Runs overlapped three deep. The 02:00 UTC CRM auto-sync refilled the queue and the hour that
-- followed spent 3,498 of its 3,600 seconds inside this one worker, against a ~300s baseline.
-- Accounts pages queued behind it.
--
--   04:50   47,943ms  FAILED - canceling statement due to statement timeout
--   04:48  167,360ms  FAILED  <- still running when the 04:50 run started
--   04:46    8,236ms  FAILED
--   04:44  115,208ms  FAILED
--
-- TWO SEPARATE FAULTS, one index fixes both.
--
-- 1. OBSERVATIONS. The sweep already filters to searchable rows:
--       embedding IS NULL AND (property LIKE 'note.%' OR property LIKE 'interaction.%')
--    A top-level OR of two prefix LIKEs is not a btree qual, so this is a scan of the whole table.
--    Reproduced on a large workspace: 121,111 ms, then killed.
--
-- 2. CLAIMS. The sweep does NOT filter at all -- the code comment says "claims are left as-is
--    (the facts corpus filters to note.* at query time)". True, but it means we compute and
--    store an OpenAI vector for every CRM field value, then throw them all away at search time.
--    Of the unembedded claims, the number anything searches is ZERO; the bulk are CRM fields:
--
--      source | owner_email | owner_name | first_name
--      company | lifecycle_stage | last_name | job_title
--
--    We were asking OpenAI what "last_name: Miller" means, once per CRM field value, and
--    maintaining a large ivfflat index to hold the answers.
--
-- WHY A PARTIAL INDEX AND NOT A CODE FILTER. Adding `property LIKE 'note.%'` to the claims
-- sweep looks like the obvious one-line fix. It is a trap, and it was measured before being
-- discarded: because zero matching rows exist, the filter makes Postgres scan every
-- claim to prove nothing matches.
--
--      today, no filter                0.185 ms
--      with LIKE 'note.%'             22,715 ms
--      with a sargable range         113,738 ms
--
-- A partial index whose predicate IS the queue turns "scan the table to prove it is empty"
-- into "read an empty index". It also shrinks as rows get embedded -- a row leaves the index
-- the moment its embedding is written -- so the steady state is an index of near zero pages.
-- This is the standard queue-index shape and it is why the code filter is safe to add ONLY
-- after this migration is applied.
--
-- ORDER OF OPERATIONS (important):
--   1. Apply this migration.  CONCURRENTLY, no lock, safe on a live database.
--   2. Deploy the worker.     It ships with the embedding cron OFF by default.
--   3. Set EMBEDDINGS_ENABLED=true and restart the worker.
--   4. Watch worker_runs for `embeddings`: durations should be well under a second.
-- Turning the flag on before step 1 reintroduces the 22-113s scan above.

-- The claims queue. Currently ZERO rows match, so this index is born empty and the sweep's
-- "is there anything to do?" question becomes instant instead of a full-table scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS claims_embed_queue
  ON public.claims (id)
  WHERE embedding IS NULL AND property LIKE 'note.%';

-- The observations queue. Same shape, and it covers BOTH arms of the existing OR, so the
-- planner stops falling back to a sequential scan of 1.19M rows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS observations_embed_queue
  ON public.observations (id)
  WHERE embedding IS NULL AND (property LIKE 'note.%' OR property LIKE 'interaction.%');

-- ---------------------------------------------------------------------------
-- ROLLBACK. Both are additive and carry no data; dropping them restores exactly
-- today's behaviour (slow sweeps), and costs nothing else.
--
--   DROP INDEX CONCURRENTLY IF EXISTS public.claims_embed_queue;
--   DROP INDEX CONCURRENTLY IF EXISTS public.observations_embed_queue;
--
-- NOT DONE HERE, deliberately, because each needs its own blast-radius review:
--   * The claims_embedding ivfflat index holds vectors for many rows nothing
--     searches. It serves exactly one caller (apps/api/src/routes/v2/notes.mjs), which asks
--     for 40 hits and then discards everything that is not a note.*. Rebuilding it over the
--     note.* rows alone would reclaim most of that space and most of the write cost.
--   * The sweep writes one row per UPDATE, 96 round trips per batch, each one maintaining
--     that large index. Batching the write is a separate change.
-- ---------------------------------------------------------------------------
