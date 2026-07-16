-- Performance: index unindexed foreign keys on read-path tables, and drop two
-- duplicate indexes. From the Supabase performance advisor (2026-07-16).
-- Already applied to production; kept here so fresh self-host installs match.

-- Graph traversal (buying committee / org chart) joins relationships by both ends.
CREATE INDEX IF NOT EXISTS idx_relationships_from_entity ON public.relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to_entity   ON public.relationships(to_entity_id);
-- "which lists is this entity in" lookups.
CREATE INDEX IF NOT EXISTS idx_collection_entities_entity ON public.collection_entities(entity_id);
-- Identity resolution follows merged_into chains.
CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON public.entities(merged_into);
-- Per-member privacy scoping filters observations by owner on the largest table.
CREATE INDEX IF NOT EXISTS idx_observations_owner_user ON public.observations(owner_user_id);

-- Duplicate indexes (identical to a constraint-backed / default index). Safe to drop.
DROP INDEX IF EXISTS public.subscriptions_team_unique;  -- dup of subscriptions_team_id_key (unique constraint)
DROP INDEX IF EXISTS public.wlc_workspace;              -- dup of workspace_linkedin_connections_workspace_id_idx
