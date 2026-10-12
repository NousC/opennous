-- Trigger-level dedup for outbound_events.
--
-- interaction.linkedin_connection_accepted can now fire from two paths for the
-- same accept: the connector activity (logActivity → maybeEnqueueTrigger) and
-- the claim state-transition (recomputeClaim → fireClaimTransitionTriggers).
-- Both stamp a deterministic external_id (`li-accept:<entity_id>`); this unique
-- index collapses repeat fires — across the two paths, across re-syncs, and
-- across Unipile re-fires — into a single delivery per (workspace, subscription).
--
-- The index is intentionally NOT partial: Postgres treats NULLs as distinct, so
-- the many rows without an external_id (email_received, meetings, …) never
-- collide and remain insert-always. A partial `WHERE external_id IS NOT NULL`
-- index would dedup the same rows, but PostgREST's onConflict upsert can only
-- infer a plain index (it passes column names, not the index predicate).

ALTER TABLE outbound_events ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS outbound_events_dedup
  ON outbound_events (workspace_id, subscription_id, external_id);
