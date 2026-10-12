-- Phase 4b: backfill the remaining v1 contact/company columns into claims.
--
-- After Phase 4a the read path overlays claim values onto the v1 row; after
-- this backfill, every claim-worthy column also lives in `claims`, so the
-- overlay sources real v2 data instead of falling through. Phase 4c then
-- drops the dual-write to contacts/companies and the tables.
--
-- Direct claim insert (not via observations) — fast and idempotent. Live
-- writes via mirrorStateToObservations will derive fresher claims later,
-- which is fine: this is a one-time floor.

BEGIN;

-- ── Contacts ──────────────────────────────────────────────────────────────
WITH person_facts AS (
  SELECT c.workspace_id, c.id AS entity_id, k.property, k.value, c.updated_at
  FROM contacts c
  CROSS JOIN LATERAL (VALUES
    ('photo_url',         to_jsonb(NULLIF(trim(c.photo_url), ''))),
    ('channels',          c.channels),
    ('source',            to_jsonb(NULLIF(trim(c.source), ''))),
    ('first_seen_at',     to_jsonb(c.first_seen_at)),
    ('stage_locked',      to_jsonb(c.stage_locked)),
    ('deal_health_score', to_jsonb(c.deal_health_score)),
    ('deal_health_breakdown', c.deal_health_breakdown),
    ('deal_stage',        to_jsonb(NULLIF(trim(c.deal_stage), ''))),
    ('deal_value',        to_jsonb(c.deal_value)),
    ('enrichment_status', to_jsonb(NULLIF(trim(c.enrichment_status), ''))),
    ('enriched_at',       to_jsonb(c.enriched_at)),
    ('memory_summary',    to_jsonb(NULLIF(trim(c.memory_summary), '')))
  ) AS k(property, value)
  WHERE k.value IS NOT NULL
    AND c.id IN (SELECT id FROM entities)
)
INSERT INTO claims (
  workspace_id, entity_id, property, value,
  confidence, epistemic_class, freshness,
  last_observed_at, computed_at
)
SELECT p.workspace_id, p.entity_id, p.property, p.value,
       0.7, 'observed', 'aging',
       COALESCE(p.updated_at, now()), now()
FROM person_facts p
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- ── Companies ─────────────────────────────────────────────────────────────
WITH company_facts AS (
  SELECT co.workspace_id, co.id AS entity_id, k.property, k.value, co.updated_at
  FROM companies co
  CROSS JOIN LATERAL (VALUES
    ('enrichment_status',  to_jsonb(NULLIF(trim(co.enrichment_status), ''))),
    ('enriched_at',        to_jsonb(co.enriched_at)),
    ('deal_health_score',  to_jsonb(co.deal_health_score)),
    ('hubspot_company_id', to_jsonb(NULLIF(trim(co.hubspot_company_id), ''))),
    ('apollo_account_id',  to_jsonb(NULLIF(trim(co.apollo_account_id), '')))
  ) AS k(property, value)
  WHERE k.value IS NOT NULL
    AND co.id IN (SELECT id FROM entities)
)
INSERT INTO claims (
  workspace_id, entity_id, property, value,
  confidence, epistemic_class, freshness,
  last_observed_at, computed_at
)
SELECT c.workspace_id, c.entity_id, c.property, c.value,
       0.7, 'observed', 'aging',
       COALESCE(c.updated_at, now()), now()
FROM company_facts c
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

COMMIT;

-- VERIFY — how many claims of each kind do we now carry?
-- SELECT property, count(*) FROM claims WHERE invalid_at IS NULL GROUP BY property ORDER BY 2 DESC;
