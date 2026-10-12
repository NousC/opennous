-- Lead-list page load: the `leads` view orders by ce.added_at and the list
-- query filters collection_entities by collection_id. With no index on
-- collection_id the planner seq-scanned the whole join table and top-N sorted
-- all members every page. This composite serves both the filter and the
-- ORDER BY added_at DESC LIMIT, so a page walks the index instead.
CREATE INDEX IF NOT EXISTS collection_entities_collection_added
  ON collection_entities(collection_id, added_at DESC);
