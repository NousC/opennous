-- Lead-list loading speed pass.
--
-- The `leads` VIEW derives ~13 of its columns with correlated subqueries of the
-- shape `(SELECT … FROM claims WHERE entity_id = e.id AND property = '…' AND
-- invalid_at IS NULL LIMIT 1)`. The only entity index on claims was
-- `claims_entity (entity_id)` — so each subquery fetched ALL of an entity's
-- claims and filtered `property` in memory. On a 50-row page that's ~650
-- redundant claim scans. (The unique index leads with workspace_id, so it can't
-- serve an entity_id+property lookup.)
--
-- This composite, partial-on the same predicate the view uses, turns every one
-- of those subqueries into a direct index probe.
CREATE INDEX IF NOT EXISTS claims_entity_property
  ON claims(entity_id, property) WHERE invalid_at IS NULL;

-- The lead-list sidebar counted leads with one head+count query PER list
-- (Promise.all over N lists = N round-trips). This collapses it to a single
-- grouped count. COUNT references only lead_list_id, so PostgreSQL prunes the
-- view's unused scalar subqueries — it never evaluates the per-row derivations.
CREATE OR REPLACE FUNCTION lead_list_counts(p_ws UUID)
  RETURNS TABLE(lead_list_id UUID, lead_count BIGINT)
  LANGUAGE sql STABLE AS $$
  SELECT l.lead_list_id, count(*)::bigint
  FROM leads l
  WHERE l.workspace_id = p_ws
  GROUP BY l.lead_list_id
$$;
