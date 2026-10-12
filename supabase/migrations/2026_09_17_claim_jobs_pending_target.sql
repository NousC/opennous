-- The index behind draining the claim queue by TARGET rather than by arrival.
--
-- claim_jobs holds one row per observation, so the same (entity_id, property) is enqueued again
-- every time that fact is observed again: a deal's stage history, a re-import, an account that
-- keeps receiving mail. All of those copies are answered by ONE recompute, because recomputeClaim
-- reads the entity's whole observation history and derives the current value from it.
--
-- The engine has always collapsed duplicates inside a sweep, but it drained in enqueued_at order,
-- which scatters the copies: a fact observed again hours later lands in a different sweep and buys
-- a second identical recompute.
--
-- MEASURED on a large workspace's queue (2026-09-17): about two copies per target on average,
-- worst around ten, so roughly half of that drain was redundant.
--
-- Sorting the sweep by target puts the copies next to each other, so they collapse to one
-- recompute and are deleted together. claim_jobs_pending (enqueued_at) cannot serve that order,
-- hence this one. Both are partial on the same predicate, so each stays small: rows leave the
-- table as soon as their work is done.
--
-- Not unique, deliberately. A unique index here would need the trigger to upsert and the worker
-- to genuinely claim rows (picked_at) with a reclaim path for a worker that dies mid-sweep;
-- without all three, an observation arriving while its target is in flight would be swallowed and
-- never derived. That is a bigger change than this problem needs.
--
-- Idempotent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS claim_jobs_pending_target
    ON public.claim_jobs (entity_id, property)
    WHERE picked_at IS NULL;
