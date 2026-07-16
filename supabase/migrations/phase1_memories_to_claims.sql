-- Phase 1: workspace_memories → asserted claims on entities
--
-- Each active workspace_memories row becomes one `asserted` claim with
-- property `note.<workspace_memories.id>` on the entity it scopes to:
--   - metadata->>contact_id  →  the person entity
--   - company_id             →  the company entity
--   - otherwise              →  the workspace entity
--
-- Asserted claims have no observation backing, so the claim engine will not
-- recompute (overwrite) them. Existing migrated `note.<category>` observations
-- stay as the append-only history.

BEGIN;

WITH targets AS (
  SELECT
    m.id, m.workspace_id, m.content, m.category, m.source, m.metadata,
    m.valid_from, m.created_at, m.updated_at,
    COALESCE(
      CASE
        WHEN m.metadata ? 'contact_id'
         AND (m.metadata->>'contact_id') ~* '^[0-9a-f-]{36}$'
        THEN (m.metadata->>'contact_id')::uuid
      END,
      m.company_id,
      (SELECT e.id FROM entities e
       WHERE e.workspace_id = m.workspace_id AND e.type = 'workspace'
       LIMIT 1)
    ) AS entity_id
  FROM workspace_memories m
  WHERE m.is_active = true
    AND m.content IS NOT NULL
)
INSERT INTO claims (
  workspace_id, entity_id, property, value,
  confidence, epistemic_class, freshness,
  valid_from, computed_at
)
SELECT
  t.workspace_id,
  t.entity_id,
  'note.' || t.id::text,
  jsonb_build_object(
    'category', COALESCE(t.category, 'General'),
    'content',  t.content,
    'source',   COALESCE(t.source, 'manual'),
    'metadata', COALESCE(t.metadata, '{}'::jsonb)
  ),
  1.0, 'asserted', 'fresh',
  COALESCE(t.valid_from, t.created_at),
  COALESCE(t.updated_at, t.created_at)
FROM targets t
WHERE t.entity_id IN (
  SELECT id FROM entities e WHERE e.workspace_id = t.workspace_id
)
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

COMMIT;

-- VERIFY: every active workspace_memories row has a corresponding claim
-- SELECT 'workspace_memories', count(*) FROM workspace_memories WHERE is_active = true
-- UNION ALL
-- SELECT 'note claims', count(*) FROM claims WHERE property LIKE 'note.%' AND invalid_at IS NULL;
