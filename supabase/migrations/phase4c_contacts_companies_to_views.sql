-- ============================================================
-- Phase 4c: drop contacts + companies tables, replace with VIEWs
-- over the v2 substrate + INSTEAD OF triggers for INSERT/UPDATE/DELETE.
--
-- Application code keeps doing `from('contacts').insert/update/delete`
-- exactly as before; the triggers translate every write into the right v2
-- ops (entities + entity_identifiers + observations + predictions +
-- relationships). The views reconstruct the v1 row shape from the v2
-- substrate so SELECTs return the same columns the app expects.
--
-- One-time. Irreversible (without restoring from backup). Run AFTER Phase 4b
-- backfill and AFTER the latest build is deployed.
-- ============================================================

BEGIN;

-- ── Step 1: defensive final backfill ──────────────────────────────────────
-- Catches any column values not yet captured as claims/identifiers/predictions/
-- relationships. ON CONFLICT DO NOTHING throughout — re-runnable.

-- 1a) Remaining contact identifiers
INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT c.workspace_id, c.id, k.kind, k.value
FROM contacts c
CROSS JOIN LATERAL (VALUES
  ('salesforce', NULLIF(trim(c.salesforce_id),'')),
  ('crm',        NULLIF(trim(c.crm_record_id),'')),
  ('stripe',     NULLIF(trim(c.stripe_customer_id),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
  AND c.id IN (SELECT id FROM entities)
ON CONFLICT DO NOTHING;

-- 1b) Remaining contact claim-worthy columns
INSERT INTO claims (workspace_id, entity_id, property, value,
                    confidence, epistemic_class, freshness, last_observed_at, computed_at)
SELECT c.workspace_id, c.id, k.property, k.value,
       0.6, 'observed', 'aging', COALESCE(c.updated_at, now()), now()
FROM contacts c
CROSS JOIN LATERAL (VALUES
  ('industry',                 to_jsonb(NULLIF(trim(c.industry),''))),
  ('company_size',             to_jsonb(NULLIF(trim(c.company_size),''))),
  ('connection_strength',      to_jsonb(NULLIF(trim(c.connection_strength),''))),
  ('lead_source',              to_jsonb(NULLIF(trim(c.lead_source),''))),
  ('source_tag',               to_jsonb(NULLIF(trim(c.source_tag),''))),
  ('status',                   to_jsonb(NULLIF(trim(c.status),''))),
  ('notes',                    to_jsonb(NULLIF(trim(c.notes),''))),
  ('keywords',                 to_jsonb(NULLIF(trim(c.keywords),''))),
  ('domain',                   to_jsonb(NULLIF(trim(c.domain),''))),
  ('enrichment_source',        to_jsonb(NULLIF(trim(c.enrichment_source),''))),
  ('pipeline_stage_source',    to_jsonb(NULLIF(trim(c.pipeline_stage_source),''))),
  ('pipeline_stage_updated_at',to_jsonb(c.pipeline_stage_updated_at)),
  ('last_interaction_at',      to_jsonb(c.last_interaction_at)),
  ('last_document_at',         to_jsonb(c.last_document_at)),
  ('deal_closed_at',           to_jsonb(c.deal_closed_at)),
  ('deal_sent_at',             to_jsonb(c.deal_sent_at)),
  ('deal_health_computed_at',  to_jsonb(c.deal_health_computed_at)),
  ('summary_generated_at',     to_jsonb(c.summary_generated_at)),
  ('icp_scored_at',            to_jsonb(c.icp_scored_at)),
  ('deal_health_active_max',   to_jsonb(c.deal_health_active_max)),
  ('interaction_count',        to_jsonb(c.interaction_count)),
  ('incoming_contacts_count',  to_jsonb(c.incoming_contacts_count)),
  ('total_documents_count',    to_jsonb(c.total_documents_count)),
  ('total_income',             to_jsonb(c.total_income)),
  ('total_income_source',      to_jsonb(NULLIF(trim(c.total_income_source),''))),
  ('tags',                     c.tags),
  ('apollo_raw',               c.apollo_raw)
) AS k(property, value)
WHERE k.value IS NOT NULL
  AND c.id IN (SELECT id FROM entities)
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- 1c) icp_score from contacts → predictions (for any contact whose score
-- isn't already represented by a prediction row).
INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value,
                         predicted_confidence, feature_snapshot, model_version, predicted_at)
SELECT c.workspace_id, c.id, 'icp_fit',
       jsonb_build_object('score', c.icp_score, 'fit', c.icp_fit, 'reason', c.icp_reasoning),
       (c.icp_score::numeric) / 100,
       '{}'::jsonb, 'v1_compat', COALESCE(c.icp_scored_at, c.updated_at, now())
FROM contacts c
WHERE c.icp_score IS NOT NULL
  AND c.id IN (SELECT id FROM entities)
  AND NOT EXISTS (
    SELECT 1 FROM predictions p
    WHERE p.entity_id = c.id AND p.kind = 'icp_fit'
  );

-- 1d) company_id → works_at relationships (for any contact missing the edge)
INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
SELECT c.workspace_id, c.id, c.company_id, 'works_at', 0.9
FROM contacts c
WHERE c.company_id IS NOT NULL
  AND c.id IN (SELECT id FROM entities)
  AND c.company_id IN (SELECT id FROM entities)
  AND NOT EXISTS (
    SELECT 1 FROM relationships r
    WHERE r.from_entity_id = c.id AND r.to_entity_id = c.company_id AND r.type = 'works_at'
  )
ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;

-- 1e) Remaining company identifiers + claim-worthy columns
INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT co.workspace_id, co.id, k.kind, k.value
FROM companies co
CROSS JOIN LATERAL (VALUES
  ('domain',          NULLIF(trim(co.domain),'')),
  ('hubspot_company', NULLIF(trim(co.hubspot_company_id),'')),
  ('apollo_account',  NULLIF(trim(co.apollo_account_id),'')),
  ('pipedrive_org',   NULLIF(trim(co.pipedrive_org_id),'')),
  ('attio_company',   NULLIF(trim(co.attio_company_id),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
  AND co.id IN (SELECT id FROM entities)
ON CONFLICT DO NOTHING;

INSERT INTO claims (workspace_id, entity_id, property, value,
                    confidence, epistemic_class, freshness, last_observed_at, computed_at)
SELECT co.workspace_id, co.id, k.property, k.value,
       0.6, 'observed', 'aging', COALESCE(co.updated_at, now()), now()
FROM companies co
CROSS JOIN LATERAL (VALUES
  ('icp_score',              to_jsonb(co.icp_score)),
  ('icp_fit',                to_jsonb(co.icp_fit)),
  ('icp_reasoning',          to_jsonb(NULLIF(trim(co.icp_reasoning),''))),
  ('icp_scored_at',          to_jsonb(co.icp_scored_at)),
  ('deal_health_computed_at',to_jsonb(co.deal_health_computed_at)),
  ('last_activity_at',       to_jsonb(co.last_activity_at)),
  ('apollo_raw',             co.apollo_raw)
) AS k(property, value)
WHERE k.value IS NOT NULL
  AND co.id IN (SELECT id FROM entities)
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- ── Step 2: drop the v1 tables ────────────────────────────────────────────
-- CASCADE drops dependent objects (FK constraints from leads, etc.). The
-- referencing columns stay; the constraints just go away.
DROP TABLE IF EXISTS contacts CASCADE;
DROP TABLE IF EXISTS companies CASCADE;

-- ── Step 3: create the contacts VIEW ──────────────────────────────────────
-- Projects the v2 substrate as the v1 contacts row shape. Subqueries are
-- correlated to each entity; postgres handles ~30 subqueries per row fine at
-- our scale (UNIQUE index on claims(workspace_id, entity_id, property)).
CREATE VIEW contacts AS
SELECT
  e.id,
  e.workspace_id,
  e.created_at,
  -- ── identifiers ──
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'email'              AND status = 'active' LIMIT 1) AS email,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_url'       AND status = 'active' LIMIT 1) AS linkedin_url,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_member_id' AND status = 'active' LIMIT 1) AS linkedin_member_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'hubspot'            AND status = 'active' LIMIT 1) AS hubspot_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'pipedrive'          AND status = 'active' LIMIT 1) AS pipedrive_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'apollo'             AND status = 'active' LIMIT 1) AS apollo_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'rb2b'               AND status = 'active' LIMIT 1) AS rb2b_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'attio'              AND status = 'active' LIMIT 1) AS attio_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'salesforce'         AND status = 'active' LIMIT 1) AS salesforce_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'crm'                AND status = 'active' LIMIT 1) AS crm_record_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'stripe'             AND status = 'active' LIMIT 1) AS stripe_customer_id,
  -- ── profile claims (text) ──
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'first_name'             AND invalid_at IS NULL LIMIT 1) AS first_name,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'last_name'              AND invalid_at IS NULL LIMIT 1) AS last_name,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'job_title'              AND invalid_at IS NULL LIMIT 1) AS job_title,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'seniority'              AND invalid_at IS NULL LIMIT 1) AS seniority,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'department'             AND invalid_at IS NULL LIMIT 1) AS department,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'city'                   AND invalid_at IS NULL LIMIT 1) AS city,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'country'                AND invalid_at IS NULL LIMIT 1) AS country,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'phone'                  AND invalid_at IS NULL LIMIT 1) AS phone,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'company'                AND invalid_at IS NULL LIMIT 1) AS company,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'photo_url'              AND invalid_at IS NULL LIMIT 1) AS photo_url,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'domain'                 AND invalid_at IS NULL LIMIT 1) AS domain,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'industry'               AND invalid_at IS NULL LIMIT 1) AS industry,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'company_size'           AND invalid_at IS NULL LIMIT 1) AS company_size,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'connection_strength'    AND invalid_at IS NULL LIMIT 1) AS connection_strength,
  -- ── pipeline / lifecycle ──
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage'         AND invalid_at IS NULL LIMIT 1) AS pipeline_stage,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage_source'  AND invalid_at IS NULL LIMIT 1) AS pipeline_stage_source,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage_updated_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS pipeline_stage_updated_at,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'source'                 AND invalid_at IS NULL LIMIT 1) AS source,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'source_tag'             AND invalid_at IS NULL LIMIT 1) AS source_tag,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'status'                 AND invalid_at IS NULL LIMIT 1) AS status,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'lead_source'            AND invalid_at IS NULL LIMIT 1) AS lead_source,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'first_seen_at'         AND invalid_at IS NULL LIMIT 1))::timestamptz AS first_seen_at,
  (SELECT max(observed_at) FROM observations WHERE entity_id = e.id) AS last_activity_at,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'last_interaction_at'   AND invalid_at IS NULL LIMIT 1))::timestamptz AS last_interaction_at,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'last_document_at'      AND invalid_at IS NULL LIMIT 1))::timestamptz AS last_document_at,
  -- ── deal state ──
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_health_score'     AND invalid_at IS NULL LIMIT 1))::integer AS deal_health_score,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_health_active_max' AND invalid_at IS NULL LIMIT 1))::integer AS deal_health_active_max,
  (SELECT value FROM claims WHERE entity_id = e.id AND property = 'deal_health_breakdown' AND invalid_at IS NULL LIMIT 1) AS deal_health_breakdown,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_health_computed_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_health_computed_at,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_stage'             AND invalid_at IS NULL LIMIT 1) AS deal_stage,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_value'            AND invalid_at IS NULL LIMIT 1))::numeric AS deal_value,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_closed_at'        AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_closed_at,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_sent_at'          AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_sent_at,
  -- ── enrichment ──
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'enrichment_status'      AND invalid_at IS NULL LIMIT 1) AS enrichment_status,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'enrichment_source'      AND invalid_at IS NULL LIMIT 1) AS enrichment_source,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'enriched_at'           AND invalid_at IS NULL LIMIT 1))::timestamptz AS enriched_at,
  -- ── ICP score from latest icp_fit prediction ──
  ((SELECT predicted_value->>'score' FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1))::integer AS icp_score,
  ((SELECT predicted_value->>'fit'   FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1))::boolean AS icp_fit,
  (SELECT predicted_value->>'reason' FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1) AS icp_reasoning,
  (SELECT predicted_at FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1) AS icp_scored_at,
  -- ── LLM/summary ──
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'memory_summary'         AND invalid_at IS NULL LIMIT 1) AS memory_summary,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'summary_generated_at'  AND invalid_at IS NULL LIMIT 1))::timestamptz AS summary_generated_at,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'notes'                  AND invalid_at IS NULL LIMIT 1) AS notes,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'keywords'               AND invalid_at IS NULL LIMIT 1) AS keywords,
  -- ── JSONB blobs ──
  (SELECT value FROM claims WHERE entity_id = e.id AND property = 'channels'   AND invalid_at IS NULL LIMIT 1) AS channels,
  (SELECT value FROM claims WHERE entity_id = e.id AND property = 'tags'       AND invalid_at IS NULL LIMIT 1) AS tags,
  (SELECT value FROM claims WHERE entity_id = e.id AND property = 'apollo_raw' AND invalid_at IS NULL LIMIT 1) AS apollo_raw,
  -- ── counts ──
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'interaction_count'       AND invalid_at IS NULL LIMIT 1))::integer AS interaction_count,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'incoming_contacts_count' AND invalid_at IS NULL LIMIT 1))::integer AS incoming_contacts_count,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'total_documents_count'   AND invalid_at IS NULL LIMIT 1))::integer AS total_documents_count,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'total_income'            AND invalid_at IS NULL LIMIT 1))::numeric AS total_income,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'total_income_source'      AND invalid_at IS NULL LIMIT 1) AS total_income_source,
  -- ── relations ──
  (SELECT to_entity_id FROM relationships WHERE from_entity_id = e.id AND type = 'works_at' AND valid_to IS NULL LIMIT 1) AS company_id,
  -- ── bookkeeping ──
  NULL::uuid AS created_by,
  COALESCE((SELECT max(computed_at) FROM claims WHERE entity_id = e.id), e.created_at) AS updated_at
FROM entities e
WHERE e.type = 'person' AND e.status = 'active';

-- ── Step 4: create the companies VIEW ─────────────────────────────────────
CREATE VIEW companies AS
SELECT
  e.id,
  e.workspace_id,
  e.created_at,
  -- identifiers
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'domain'          AND status = 'active' LIMIT 1) AS domain,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'hubspot_company' AND status = 'active' LIMIT 1) AS hubspot_company_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'apollo_account'  AND status = 'active' LIMIT 1) AS apollo_account_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'pipedrive_org'   AND status = 'active' LIMIT 1) AS pipedrive_org_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'attio_company'   AND status = 'active' LIMIT 1) AS attio_company_id,
  -- firmographics
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'name'           AND invalid_at IS NULL LIMIT 1) AS name,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'industry'       AND invalid_at IS NULL LIMIT 1) AS industry,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'employee_count' AND invalid_at IS NULL LIMIT 1))::integer AS employee_count,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'location'       AND invalid_at IS NULL LIMIT 1) AS location,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'revenue_range'  AND invalid_at IS NULL LIMIT 1) AS revenue_range,
  (
    SELECT CASE WHEN jsonb_typeof(value) = 'array'
                THEN ARRAY(SELECT jsonb_array_elements_text(value))
                ELSE NULL END
    FROM claims WHERE entity_id = e.id AND property = 'tech_stack' AND invalid_at IS NULL LIMIT 1
  ) AS tech_stack,
  -- enrichment
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'enrichment_status' AND invalid_at IS NULL LIMIT 1) AS enrichment_status,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'enriched_at'      AND invalid_at IS NULL LIMIT 1))::timestamptz AS enriched_at,
  -- ICP (currently stored as claim on the company entity)
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'icp_score'        AND invalid_at IS NULL LIMIT 1))::integer AS icp_score,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'icp_fit'          AND invalid_at IS NULL LIMIT 1))::boolean AS icp_fit,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'icp_reasoning'     AND invalid_at IS NULL LIMIT 1) AS icp_reasoning,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'icp_scored_at'    AND invalid_at IS NULL LIMIT 1))::timestamptz AS icp_scored_at,
  -- deal health
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_health_score' AND invalid_at IS NULL LIMIT 1))::integer AS deal_health_score,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'deal_health_computed_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_health_computed_at,
  -- last activity (derived)
  (SELECT max(observed_at) FROM observations WHERE entity_id = e.id) AS last_activity_at,
  -- jsonb blobs
  (SELECT value FROM claims WHERE entity_id = e.id AND property = 'apollo_raw' AND invalid_at IS NULL LIMIT 1) AS apollo_raw,
  -- bookkeeping
  COALESCE((SELECT max(computed_at) FROM claims WHERE entity_id = e.id), e.created_at) AS updated_at
FROM entities e
WHERE e.type = 'company' AND e.status = 'active';

-- ── Step 5: INSTEAD OF triggers — translate v1 writes into v2 ops ─────────

-- ── contacts INSERT ──
CREATE OR REPLACE FUNCTION contacts_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  src TEXT := COALESCE(NEW.source, 'v1_compat');
BEGIN
  -- entity
  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  -- identifiers
  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('email',              lower(NULLIF(trim(NEW.email),''))),
    ('linkedin_url',       NULLIF(trim(NEW.linkedin_url),'')),
    ('linkedin_member_id', NULLIF(trim(NEW.linkedin_member_id),'')),
    ('hubspot',            NULLIF(trim(NEW.hubspot_id),'')),
    ('pipedrive',          NULLIF(trim(NEW.pipedrive_id),'')),
    ('apollo',             NULLIF(trim(NEW.apollo_id),'')),
    ('rb2b',               NULLIF(trim(NEW.rb2b_id),'')),
    ('attio',              NULLIF(trim(NEW.attio_id),'')),
    ('salesforce',         NULLIF(trim(NEW.salesforce_id),'')),
    ('crm',                NULLIF(trim(NEW.crm_record_id),'')),
    ('stripe',             NULLIF(trim(NEW.stripe_customer_id),''))
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- state observations for every claim-worthy field that's non-null
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, new_id, 'state', k.property, k.value, src, 'trigger', now() FROM (VALUES
    ('first_name',                to_jsonb(NULLIF(trim(NEW.first_name),''))),
    ('last_name',                 to_jsonb(NULLIF(trim(NEW.last_name),''))),
    ('job_title',                 to_jsonb(NULLIF(trim(NEW.job_title),''))),
    ('seniority',                 to_jsonb(NULLIF(trim(NEW.seniority),''))),
    ('department',                to_jsonb(NULLIF(trim(NEW.department),''))),
    ('city',                      to_jsonb(NULLIF(trim(NEW.city),''))),
    ('country',                   to_jsonb(NULLIF(trim(NEW.country),''))),
    ('phone',                     to_jsonb(NULLIF(trim(NEW.phone),''))),
    ('company',                   to_jsonb(NULLIF(trim(NEW.company),''))),
    ('photo_url',                 to_jsonb(NULLIF(trim(NEW.photo_url),''))),
    ('domain',                    to_jsonb(NULLIF(trim(NEW.domain),''))),
    ('industry',                  to_jsonb(NULLIF(trim(NEW.industry),''))),
    ('company_size',              to_jsonb(NULLIF(trim(NEW.company_size),''))),
    ('connection_strength',       to_jsonb(NULLIF(trim(NEW.connection_strength),''))),
    ('pipeline_stage',            to_jsonb(NULLIF(trim(NEW.pipeline_stage),''))),
    ('pipeline_stage_source',     to_jsonb(NULLIF(trim(NEW.pipeline_stage_source),''))),
    ('source',                    to_jsonb(NULLIF(trim(NEW.source),''))),
    ('source_tag',                to_jsonb(NULLIF(trim(NEW.source_tag),''))),
    ('status',                    to_jsonb(NULLIF(trim(NEW.status),''))),
    ('lead_source',               to_jsonb(NULLIF(trim(NEW.lead_source),''))),
    ('deal_stage',                to_jsonb(NULLIF(trim(NEW.deal_stage),''))),
    ('enrichment_status',         to_jsonb(NULLIF(trim(NEW.enrichment_status),''))),
    ('enrichment_source',         to_jsonb(NULLIF(trim(NEW.enrichment_source),''))),
    ('memory_summary',            to_jsonb(NULLIF(trim(NEW.memory_summary),''))),
    ('notes',                     to_jsonb(NULLIF(trim(NEW.notes),''))),
    ('keywords',                  to_jsonb(NULLIF(trim(NEW.keywords),''))),
    ('total_income_source',       to_jsonb(NULLIF(trim(NEW.total_income_source),''))),
    ('first_seen_at',             to_jsonb(NEW.first_seen_at)),
    ('pipeline_stage_updated_at', to_jsonb(NEW.pipeline_stage_updated_at)),
    ('last_interaction_at',       to_jsonb(NEW.last_interaction_at)),
    ('last_document_at',          to_jsonb(NEW.last_document_at)),
    ('deal_closed_at',            to_jsonb(NEW.deal_closed_at)),
    ('deal_sent_at',              to_jsonb(NEW.deal_sent_at)),
    ('deal_health_computed_at',   to_jsonb(NEW.deal_health_computed_at)),
    ('summary_generated_at',      to_jsonb(NEW.summary_generated_at)),
    ('enriched_at',               to_jsonb(NEW.enriched_at)),
    ('deal_health_score',         to_jsonb(NEW.deal_health_score)),
    ('deal_health_active_max',    to_jsonb(NEW.deal_health_active_max)),
    ('deal_value',                to_jsonb(NEW.deal_value)),
    ('interaction_count',         to_jsonb(NEW.interaction_count)),
    ('incoming_contacts_count',   to_jsonb(NEW.incoming_contacts_count)),
    ('total_documents_count',     to_jsonb(NEW.total_documents_count)),
    ('total_income',              to_jsonb(NEW.total_income)),
    ('channels',                  NEW.channels),
    ('tags',                      NEW.tags),
    ('apollo_raw',                NEW.apollo_raw),
    ('deal_health_breakdown',     NEW.deal_health_breakdown)
  ) AS k(property, value)
  WHERE k.value IS NOT NULL;

  -- icp_score → prediction
  IF NEW.icp_score IS NOT NULL THEN
    INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value,
                             predicted_confidence, feature_snapshot, model_version, predicted_at)
    VALUES (ws, new_id, 'icp_fit',
            jsonb_build_object('score', NEW.icp_score, 'fit', NEW.icp_fit, 'reason', NEW.icp_reasoning),
            (NEW.icp_score::numeric) / 100,
            '{}'::jsonb, 'v1_compat', COALESCE(NEW.icp_scored_at, now()));
  END IF;

  -- company_id → works_at relationship
  IF NEW.company_id IS NOT NULL THEN
    INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
    VALUES (ws, new_id, NEW.company_id, 'works_at', 0.9)
    ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;
  END IF;

  NEW.id := new_id;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contacts_insert_trigger INSTEAD OF INSERT ON contacts
FOR EACH ROW EXECUTE FUNCTION contacts_insert_handler();

-- ── contacts UPDATE ──
CREATE OR REPLACE FUNCTION contacts_update_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  ws UUID := COALESCE(NEW.workspace_id, OLD.workspace_id);
  src TEXT := COALESCE(NEW.source, OLD.source, 'v1_compat');
BEGIN
  -- New identifiers (additive — we never remove)
  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, OLD.id, k.kind, k.value FROM (VALUES
    ('email',              lower(NULLIF(trim(NEW.email),''))),
    ('linkedin_url',       NULLIF(trim(NEW.linkedin_url),'')),
    ('linkedin_member_id', NULLIF(trim(NEW.linkedin_member_id),'')),
    ('hubspot',            NULLIF(trim(NEW.hubspot_id),'')),
    ('pipedrive',          NULLIF(trim(NEW.pipedrive_id),'')),
    ('apollo',             NULLIF(trim(NEW.apollo_id),'')),
    ('rb2b',               NULLIF(trim(NEW.rb2b_id),'')),
    ('attio',              NULLIF(trim(NEW.attio_id),'')),
    ('salesforce',         NULLIF(trim(NEW.salesforce_id),'')),
    ('crm',                NULLIF(trim(NEW.crm_record_id),'')),
    ('stripe',             NULLIF(trim(NEW.stripe_customer_id),''))
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- State observations for every field that materially changed
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, OLD.id, 'state', k.property, k.new_v, src, 'trigger', now() FROM (VALUES
    ('first_name',                to_jsonb(NULLIF(trim(NEW.first_name),'')),     to_jsonb(NULLIF(trim(OLD.first_name),''))),
    ('last_name',                 to_jsonb(NULLIF(trim(NEW.last_name),'')),      to_jsonb(NULLIF(trim(OLD.last_name),''))),
    ('job_title',                 to_jsonb(NULLIF(trim(NEW.job_title),'')),      to_jsonb(NULLIF(trim(OLD.job_title),''))),
    ('seniority',                 to_jsonb(NULLIF(trim(NEW.seniority),'')),      to_jsonb(NULLIF(trim(OLD.seniority),''))),
    ('department',                to_jsonb(NULLIF(trim(NEW.department),'')),     to_jsonb(NULLIF(trim(OLD.department),''))),
    ('city',                      to_jsonb(NULLIF(trim(NEW.city),'')),           to_jsonb(NULLIF(trim(OLD.city),''))),
    ('country',                   to_jsonb(NULLIF(trim(NEW.country),'')),        to_jsonb(NULLIF(trim(OLD.country),''))),
    ('phone',                     to_jsonb(NULLIF(trim(NEW.phone),'')),          to_jsonb(NULLIF(trim(OLD.phone),''))),
    ('company',                   to_jsonb(NULLIF(trim(NEW.company),'')),        to_jsonb(NULLIF(trim(OLD.company),''))),
    ('photo_url',                 to_jsonb(NULLIF(trim(NEW.photo_url),'')),      to_jsonb(NULLIF(trim(OLD.photo_url),''))),
    ('domain',                    to_jsonb(NULLIF(trim(NEW.domain),'')),         to_jsonb(NULLIF(trim(OLD.domain),''))),
    ('industry',                  to_jsonb(NULLIF(trim(NEW.industry),'')),       to_jsonb(NULLIF(trim(OLD.industry),''))),
    ('company_size',              to_jsonb(NULLIF(trim(NEW.company_size),'')),   to_jsonb(NULLIF(trim(OLD.company_size),''))),
    ('connection_strength',       to_jsonb(NULLIF(trim(NEW.connection_strength),'')), to_jsonb(NULLIF(trim(OLD.connection_strength),''))),
    ('pipeline_stage',            to_jsonb(NULLIF(trim(NEW.pipeline_stage),'')), to_jsonb(NULLIF(trim(OLD.pipeline_stage),''))),
    ('pipeline_stage_source',     to_jsonb(NULLIF(trim(NEW.pipeline_stage_source),'')), to_jsonb(NULLIF(trim(OLD.pipeline_stage_source),''))),
    ('source',                    to_jsonb(NULLIF(trim(NEW.source),'')),         to_jsonb(NULLIF(trim(OLD.source),''))),
    ('source_tag',                to_jsonb(NULLIF(trim(NEW.source_tag),'')),     to_jsonb(NULLIF(trim(OLD.source_tag),''))),
    ('status',                    to_jsonb(NULLIF(trim(NEW.status),'')),         to_jsonb(NULLIF(trim(OLD.status),''))),
    ('lead_source',               to_jsonb(NULLIF(trim(NEW.lead_source),'')),    to_jsonb(NULLIF(trim(OLD.lead_source),''))),
    ('deal_stage',                to_jsonb(NULLIF(trim(NEW.deal_stage),'')),     to_jsonb(NULLIF(trim(OLD.deal_stage),''))),
    ('enrichment_status',         to_jsonb(NULLIF(trim(NEW.enrichment_status),'')), to_jsonb(NULLIF(trim(OLD.enrichment_status),''))),
    ('enrichment_source',         to_jsonb(NULLIF(trim(NEW.enrichment_source),'')), to_jsonb(NULLIF(trim(OLD.enrichment_source),''))),
    ('memory_summary',            to_jsonb(NULLIF(trim(NEW.memory_summary),'')), to_jsonb(NULLIF(trim(OLD.memory_summary),''))),
    ('notes',                     to_jsonb(NULLIF(trim(NEW.notes),'')),          to_jsonb(NULLIF(trim(OLD.notes),''))),
    ('keywords',                  to_jsonb(NULLIF(trim(NEW.keywords),'')),       to_jsonb(NULLIF(trim(OLD.keywords),''))),
    ('total_income_source',       to_jsonb(NULLIF(trim(NEW.total_income_source),'')), to_jsonb(NULLIF(trim(OLD.total_income_source),''))),
    ('first_seen_at',             to_jsonb(NEW.first_seen_at),             to_jsonb(OLD.first_seen_at)),
    ('pipeline_stage_updated_at', to_jsonb(NEW.pipeline_stage_updated_at), to_jsonb(OLD.pipeline_stage_updated_at)),
    ('last_interaction_at',       to_jsonb(NEW.last_interaction_at),       to_jsonb(OLD.last_interaction_at)),
    ('last_document_at',          to_jsonb(NEW.last_document_at),          to_jsonb(OLD.last_document_at)),
    ('deal_closed_at',            to_jsonb(NEW.deal_closed_at),            to_jsonb(OLD.deal_closed_at)),
    ('deal_sent_at',              to_jsonb(NEW.deal_sent_at),              to_jsonb(OLD.deal_sent_at)),
    ('deal_health_computed_at',   to_jsonb(NEW.deal_health_computed_at),   to_jsonb(OLD.deal_health_computed_at)),
    ('summary_generated_at',      to_jsonb(NEW.summary_generated_at),      to_jsonb(OLD.summary_generated_at)),
    ('enriched_at',               to_jsonb(NEW.enriched_at),               to_jsonb(OLD.enriched_at)),
    ('deal_health_score',         to_jsonb(NEW.deal_health_score),         to_jsonb(OLD.deal_health_score)),
    ('deal_health_active_max',    to_jsonb(NEW.deal_health_active_max),    to_jsonb(OLD.deal_health_active_max)),
    ('deal_value',                to_jsonb(NEW.deal_value),                to_jsonb(OLD.deal_value)),
    ('interaction_count',         to_jsonb(NEW.interaction_count),         to_jsonb(OLD.interaction_count)),
    ('incoming_contacts_count',   to_jsonb(NEW.incoming_contacts_count),   to_jsonb(OLD.incoming_contacts_count)),
    ('total_documents_count',     to_jsonb(NEW.total_documents_count),     to_jsonb(OLD.total_documents_count)),
    ('total_income',              to_jsonb(NEW.total_income),              to_jsonb(OLD.total_income)),
    ('channels',                  NEW.channels,                            OLD.channels),
    ('tags',                      NEW.tags,                                OLD.tags),
    ('apollo_raw',                NEW.apollo_raw,                          OLD.apollo_raw),
    ('deal_health_breakdown',     NEW.deal_health_breakdown,               OLD.deal_health_breakdown)
  ) AS k(property, new_v, old_v)
  WHERE k.new_v IS NOT NULL AND k.new_v IS DISTINCT FROM k.old_v;

  -- icp_score change → new prediction
  IF NEW.icp_score IS NOT NULL AND NEW.icp_score IS DISTINCT FROM OLD.icp_score THEN
    INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value,
                             predicted_confidence, feature_snapshot, model_version, predicted_at)
    VALUES (ws, OLD.id, 'icp_fit',
            jsonb_build_object('score', NEW.icp_score, 'fit', NEW.icp_fit, 'reason', NEW.icp_reasoning),
            (NEW.icp_score::numeric) / 100,
            '{}'::jsonb, 'v1_compat', COALESCE(NEW.icp_scored_at, now()));
  END IF;

  -- company_id change → close old works_at, open new
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    UPDATE relationships SET valid_to = now()
      WHERE from_entity_id = OLD.id AND type = 'works_at' AND valid_to IS NULL;
    IF NEW.company_id IS NOT NULL THEN
      INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
      VALUES (ws, OLD.id, NEW.company_id, 'works_at', 0.9)
      ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;
CREATE TRIGGER contacts_update_trigger INSTEAD OF UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION contacts_update_handler();

-- ── contacts DELETE ──
CREATE OR REPLACE FUNCTION contacts_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  -- Soft-merge the entity (claims/observations preserved as audit trail).
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'person';
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER contacts_delete_trigger INSTEAD OF DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION contacts_delete_handler();

-- ── companies INSERT ──
CREATE OR REPLACE FUNCTION companies_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
BEGIN
  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'company', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('domain',          lower(NULLIF(trim(NEW.domain),''))),
    ('hubspot_company', NULLIF(trim(NEW.hubspot_company_id),'')),
    ('apollo_account',  NULLIF(trim(NEW.apollo_account_id),'')),
    ('pipedrive_org',   NULLIF(trim(NEW.pipedrive_org_id),'')),
    ('attio_company',   NULLIF(trim(NEW.attio_company_id),''))
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, new_id, 'state', k.property, k.value, 'v1_compat', 'trigger', now() FROM (VALUES
    ('name',                    to_jsonb(NULLIF(trim(NEW.name),''))),
    ('industry',                to_jsonb(NULLIF(trim(NEW.industry),''))),
    ('employee_count',          to_jsonb(NEW.employee_count)),
    ('location',                to_jsonb(NULLIF(trim(NEW.location),''))),
    ('revenue_range',           to_jsonb(NULLIF(trim(NEW.revenue_range),''))),
    ('tech_stack',              CASE WHEN NEW.tech_stack IS NOT NULL AND array_length(NEW.tech_stack,1) > 0
                                     THEN to_jsonb(NEW.tech_stack) END),
    ('enrichment_status',       to_jsonb(NULLIF(trim(NEW.enrichment_status),''))),
    ('enriched_at',             to_jsonb(NEW.enriched_at)),
    ('icp_score',               to_jsonb(NEW.icp_score)),
    ('icp_fit',                 to_jsonb(NEW.icp_fit)),
    ('icp_reasoning',           to_jsonb(NULLIF(trim(NEW.icp_reasoning),''))),
    ('icp_scored_at',           to_jsonb(NEW.icp_scored_at)),
    ('deal_health_score',       to_jsonb(NEW.deal_health_score)),
    ('deal_health_computed_at', to_jsonb(NEW.deal_health_computed_at)),
    ('apollo_raw',              NEW.apollo_raw)
  ) AS k(property, value)
  WHERE k.value IS NOT NULL;

  NEW.id := new_id;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER companies_insert_trigger INSTEAD OF INSERT ON companies
FOR EACH ROW EXECUTE FUNCTION companies_insert_handler();

-- ── companies UPDATE ──
CREATE OR REPLACE FUNCTION companies_update_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  ws UUID := COALESCE(NEW.workspace_id, OLD.workspace_id);
BEGIN
  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, OLD.id, k.kind, k.value FROM (VALUES
    ('domain',          lower(NULLIF(trim(NEW.domain),''))),
    ('hubspot_company', NULLIF(trim(NEW.hubspot_company_id),'')),
    ('apollo_account',  NULLIF(trim(NEW.apollo_account_id),'')),
    ('pipedrive_org',   NULLIF(trim(NEW.pipedrive_org_id),'')),
    ('attio_company',   NULLIF(trim(NEW.attio_company_id),''))
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, OLD.id, 'state', k.property, k.new_v, 'v1_compat', 'trigger', now() FROM (VALUES
    ('name',                    to_jsonb(NULLIF(trim(NEW.name),'')),          to_jsonb(NULLIF(trim(OLD.name),''))),
    ('industry',                to_jsonb(NULLIF(trim(NEW.industry),'')),      to_jsonb(NULLIF(trim(OLD.industry),''))),
    ('employee_count',          to_jsonb(NEW.employee_count),                 to_jsonb(OLD.employee_count)),
    ('location',                to_jsonb(NULLIF(trim(NEW.location),'')),      to_jsonb(NULLIF(trim(OLD.location),''))),
    ('revenue_range',           to_jsonb(NULLIF(trim(NEW.revenue_range),'')), to_jsonb(NULLIF(trim(OLD.revenue_range),''))),
    ('tech_stack',
      CASE WHEN NEW.tech_stack IS NOT NULL AND array_length(NEW.tech_stack,1) > 0 THEN to_jsonb(NEW.tech_stack) END,
      CASE WHEN OLD.tech_stack IS NOT NULL AND array_length(OLD.tech_stack,1) > 0 THEN to_jsonb(OLD.tech_stack) END),
    ('enrichment_status',       to_jsonb(NULLIF(trim(NEW.enrichment_status),'')), to_jsonb(NULLIF(trim(OLD.enrichment_status),''))),
    ('enriched_at',             to_jsonb(NEW.enriched_at),                    to_jsonb(OLD.enriched_at)),
    ('icp_score',               to_jsonb(NEW.icp_score),                      to_jsonb(OLD.icp_score)),
    ('icp_fit',                 to_jsonb(NEW.icp_fit),                        to_jsonb(OLD.icp_fit)),
    ('icp_reasoning',           to_jsonb(NULLIF(trim(NEW.icp_reasoning),'')), to_jsonb(NULLIF(trim(OLD.icp_reasoning),''))),
    ('icp_scored_at',           to_jsonb(NEW.icp_scored_at),                  to_jsonb(OLD.icp_scored_at)),
    ('deal_health_score',       to_jsonb(NEW.deal_health_score),              to_jsonb(OLD.deal_health_score)),
    ('deal_health_computed_at', to_jsonb(NEW.deal_health_computed_at),        to_jsonb(OLD.deal_health_computed_at)),
    ('apollo_raw',              NEW.apollo_raw,                               OLD.apollo_raw)
  ) AS k(property, new_v, old_v)
  WHERE k.new_v IS NOT NULL AND k.new_v IS DISTINCT FROM k.old_v;

  RETURN NEW;
END;
$fn$;
CREATE TRIGGER companies_update_trigger INSTEAD OF UPDATE ON companies
FOR EACH ROW EXECUTE FUNCTION companies_update_handler();

-- ── companies DELETE ──
CREATE OR REPLACE FUNCTION companies_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'company';
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER companies_delete_trigger INSTEAD OF DELETE ON companies
FOR EACH ROW EXECUTE FUNCTION companies_delete_handler();

COMMIT;

-- ============================================================
-- VERIFY: smoke-test the views look right
-- ============================================================
-- SELECT count(*) AS contact_rows FROM contacts;
-- SELECT count(*) AS company_rows FROM companies;
-- SELECT id, email, first_name, last_name, company, pipeline_stage, icp_score
-- FROM contacts ORDER BY last_activity_at DESC NULLS LAST LIMIT 5;
