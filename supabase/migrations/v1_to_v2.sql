-- ============================================================
-- NOUS  —  v1 → v2 MIGRATION  (one-shot)
--
-- Moves an existing v1 (value-centric CRM) instance onto the v2
-- evidence substrate. NON-DESTRUCTIVE: it only reads v1 tables
-- and writes v2 tables. Your v1 tables (contacts, companies, …)
-- are left fully intact — they are your rollback.
--
-- HOW TO RUN
--   1. Take a Supabase backup first.
--   2. Paste this whole file into the Supabase SQL editor, Run.
--   3. Verify with the queries at the bottom.
--   4. Only AFTER v2 is proven running — drop the v1 tables.
--
-- Run ONCE. The DDL (Part 1) is idempotent; the backfill
-- (Part 2) is not — re-running would duplicate observations.
-- ============================================================

BEGIN;

-- ============================================================
-- PART 1 — create the v2 evidence tables
-- (only the NEW tables; v1 tenancy/integration tables untouched)
-- ============================================================

-- ── helpers ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- NOTE: parameter is named `workspace_uuid` to match any pre-existing
-- v1 definition — CREATE OR REPLACE cannot rename an input parameter.
CREATE OR REPLACE FUNCTION is_workspace_member(workspace_uuid UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members
                 WHERE workspace_id = workspace_uuid AND user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION reject_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only — % is not permitted', TG_TABLE_NAME, TG_OP;
END; $$;

-- ── entities ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('person','company','deal','workspace')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged')),
  merged_into  UUID REFERENCES entities(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_workspace ON entities(workspace_id, type) WHERE status='active';
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ent_select ON entities;
CREATE POLICY ent_select ON entities FOR SELECT USING (is_workspace_member(workspace_id));
DROP TRIGGER IF EXISTS entities_touch ON entities;
CREATE TRIGGER entities_touch BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── entity_identifiers ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_identifiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  value         TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 1.0,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS entity_identifiers_active
  ON entity_identifiers(workspace_id, kind, value) WHERE status='active';
CREATE INDEX IF NOT EXISTS entity_identifiers_entity ON entity_identifiers(entity_id);
ALTER TABLE entity_identifiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS eid_select ON entity_identifiers;
CREATE POLICY eid_select ON entity_identifiers FOR SELECT USING (is_workspace_member(workspace_id));

-- ── observations (immutable spine) ────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id         UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('state','event')),
  property          TEXT NOT NULL,
  value             JSONB NOT NULL,
  source            TEXT NOT NULL,
  method            TEXT NOT NULL,
  source_confidence REAL,
  observed_at       TIMESTAMPTZ NOT NULL,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_id       TEXT,
  raw               JSONB,
  content_hash      TEXT,
  embedding         VECTOR(1536),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS observations_dedup
  ON observations(workspace_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_claim_input
  ON observations(entity_id, property, observed_at DESC);
CREATE INDEX IF NOT EXISTS observations_timeline
  ON observations(entity_id, observed_at DESC);
DROP TRIGGER IF EXISTS observations_immutable ON observations;
CREATE TRIGGER observations_immutable BEFORE UPDATE OR DELETE ON observations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS obs_select ON observations;
CREATE POLICY obs_select ON observations FOR SELECT USING (is_workspace_member(workspace_id));

-- ── claims (derived layer) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS claims (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id                  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  property                   TEXT NOT NULL,
  value                      JSONB NOT NULL,
  distribution               JSONB,
  confidence                 REAL NOT NULL,
  epistemic_class            TEXT NOT NULL CHECK (epistemic_class IN ('observed','inferred','predicted','asserted')),
  freshness                  TEXT NOT NULL DEFAULT 'fresh' CHECK (freshness IN ('fresh','aging','suspect','expired')),
  decays_at                  TIMESTAMPTZ,
  supporting_observation_ids UUID[] NOT NULL DEFAULT '{}',
  observation_count          INT NOT NULL DEFAULT 0,
  last_observed_at           TIMESTAMPTZ,
  embedding                  VECTOR(1536),
  computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, entity_id, property)
);
CREATE INDEX IF NOT EXISTS claims_entity ON claims(entity_id);
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clm_select ON claims;
CREATE POLICY clm_select ON claims FOR SELECT USING (is_workspace_member(workspace_id));

-- ── relationships ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS relationships (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_entity_id             UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id               UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type                       TEXT NOT NULL,
  confidence                 REAL NOT NULL DEFAULT 1.0,
  valid_from                 TIMESTAMPTZ,
  valid_to                   TIMESTAMPTZ,
  supporting_observation_ids UUID[] NOT NULL DEFAULT '{}',
  computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_entity_id, to_entity_id, type)
);
ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rel_select ON relationships;
CREATE POLICY rel_select ON relationships FOR SELECT USING (is_workspace_member(workspace_id));

-- ── predictions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id              UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL,
  predicted_value        JSONB NOT NULL,
  predicted_confidence   REAL  NOT NULL,
  feature_snapshot       JSONB NOT NULL DEFAULT '{}',
  model_version          TEXT,
  predicted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_value          JSONB,
  outcome_observation_id UUID REFERENCES observations(id),
  resolved_at            TIMESTAMPTZ,
  resolution_window_days INT NOT NULL DEFAULT 30,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS predictions_entity ON predictions(entity_id);
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prd_select ON predictions;
CREATE POLICY prd_select ON predictions FOR SELECT USING (is_workspace_member(workspace_id));

-- ── collections ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'list',
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS col_select ON collections;
CREATE POLICY col_select ON collections FOR SELECT USING (is_workspace_member(workspace_id));

CREATE TABLE IF NOT EXISTS collection_entities (
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, entity_id)
);

-- ── claim_jobs (recompute queue) ──────────────────────────────
CREATE TABLE IF NOT EXISTS claim_jobs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  property     TEXT NOT NULL,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS claim_jobs_pending ON claim_jobs(enqueued_at) WHERE picked_at IS NULL;

CREATE OR REPLACE FUNCTION enqueue_claim_recompute()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO claim_jobs (workspace_id, entity_id, property)
  VALUES (NEW.workspace_id, NEW.entity_id, NEW.property);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS observations_enqueue_recompute ON observations;
CREATE TRIGGER observations_enqueue_recompute AFTER INSERT ON observations
  FOR EACH ROW EXECUTE FUNCTION enqueue_claim_recompute();


-- ============================================================
-- PART 2 — backfill v1 data into the v2 model
--
-- Trick: every v2 entity REUSES its v1 row id (entity.id =
-- contacts.id / companies.id). That makes all foreign references
-- translate for free — no mapping table needed.
-- ============================================================

-- Don't flood claim_jobs while backfilling — we insert claims
-- directly below. Re-enabled at the end.
ALTER TABLE observations DISABLE TRIGGER observations_enqueue_recompute;

-- ── entities ──────────────────────────────────────────────────
-- one workspace-entity per workspace (holds ICP / product as claims)
INSERT INTO entities (id, workspace_id, type, status)
SELECT gen_random_uuid(), w.id, 'workspace', 'active' FROM workspaces w
ON CONFLICT DO NOTHING;

INSERT INTO entities (id, workspace_id, type, status, created_at)
SELECT id, workspace_id, 'company', 'active', created_at FROM companies
ON CONFLICT (id) DO NOTHING;

INSERT INTO entities (id, workspace_id, type, status, created_at)
SELECT id, workspace_id, 'person', 'active', created_at FROM contacts
ON CONFLICT (id) DO NOTHING;

-- leads with no graduated contact become their own person-entities
INSERT INTO entities (id, workspace_id, type, status, created_at)
SELECT id, workspace_id, 'person', 'active', created_at FROM leads
WHERE contact_id IS NULL
ON CONFLICT (id) DO NOTHING;

-- ── entity_identifiers ────────────────────────────────────────
INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT c.workspace_id, c.id, k.kind, k.value
FROM contacts c
CROSS JOIN LATERAL (VALUES
  ('email',              lower(NULLIF(trim(c.email),''))),
  ('linkedin_url',       NULLIF(trim(c.linkedin_url),'')),
  ('linkedin_member_id', NULLIF(trim(c.linkedin_member_id),'')),
  ('phone',              NULLIF(trim(c.phone),'')),
  ('hubspot',            NULLIF(trim(c.hubspot_id),'')),
  ('salesforce',         NULLIF(trim(c.salesforce_id),'')),
  ('pipedrive',          NULLIF(trim(c.pipedrive_id),'')),
  ('attio',              NULLIF(trim(c.attio_id),'')),
  ('apollo',             NULLIF(trim(c.apollo_id),'')),
  ('crm',                NULLIF(trim(c.crm_record_id),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
ON CONFLICT (workspace_id, kind, value) WHERE status='active' DO NOTHING;

INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT co.workspace_id, co.id, k.kind, k.value
FROM companies co
CROSS JOIN LATERAL (VALUES
  ('domain',     lower(NULLIF(trim(co.domain),''))),
  ('hubspot',    NULLIF(trim(co.hubspot_company_id),'')),
  ('apollo',     NULLIF(trim(co.apollo_account_id),'')),
  ('attio',      NULLIF(trim(co.attio_company_id),'')),
  ('pipedrive',  NULLIF(trim(co.pipedrive_org_id),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
ON CONFLICT (workspace_id, kind, value) WHERE status='active' DO NOTHING;

-- lead emails → identifiers, so lead-only entities are resolvable
INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), 'email', lower(trim(l.email))
FROM leads l
WHERE NULLIF(trim(l.email),'') IS NOT NULL
ON CONFLICT (workspace_id, kind, value) WHERE status='active' DO NOTHING;

-- ── state observations: contact firmographics ─────────────────
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at, ingested_at)
SELECT c.workspace_id, c.id, 'state', f.property, f.value, 'v1_backfill', 'migration',
       COALESCE(c.enriched_at, c.updated_at, c.created_at),
       COALESCE(c.enriched_at, c.updated_at, c.created_at)
FROM contacts c
CROSS JOIN LATERAL (VALUES
  ('first_name', to_jsonb(NULLIF(trim(c.first_name),''))),
  ('last_name',  to_jsonb(NULLIF(trim(c.last_name),''))),
  ('job_title',  to_jsonb(NULLIF(trim(c.job_title),''))),
  ('seniority',  to_jsonb(NULLIF(trim(c.seniority),''))),
  ('department', to_jsonb(NULLIF(trim(c.department),''))),
  ('city',       to_jsonb(NULLIF(trim(c.city),''))),
  ('country',    to_jsonb(NULLIF(trim(c.country),''))),
  ('photo_url',  to_jsonb(NULLIF(trim(c.photo_url),''))),
  ('pipeline_stage', to_jsonb(NULLIF(trim(c.pipeline_stage),'')))
) AS f(property, value)
WHERE f.value IS NOT NULL;

-- ── state observations: company firmographics ─────────────────
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at, ingested_at)
SELECT co.workspace_id, co.id, 'state', f.property, f.value, 'v1_backfill', 'migration',
       COALESCE(co.enriched_at, co.updated_at, co.created_at),
       COALESCE(co.enriched_at, co.updated_at, co.created_at)
FROM companies co
CROSS JOIN LATERAL (VALUES
  ('name',           to_jsonb(NULLIF(trim(co.name),''))),
  ('industry',       to_jsonb(NULLIF(trim(co.industry),''))),
  ('employee_count', to_jsonb(co.employee_count)),
  ('revenue_range',  to_jsonb(NULLIF(trim(co.revenue_range),''))),
  ('location',       to_jsonb(NULLIF(trim(co.location),''))),
  ('tech_stack',     CASE WHEN co.tech_stack IS NOT NULL AND array_length(co.tech_stack,1) > 0
                          THEN to_jsonb(co.tech_stack) END)
) AS f(property, value)
WHERE f.value IS NOT NULL;

-- ── event observations: the activity log ─────────────────────
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method,
                          observed_at, ingested_at, external_id, raw)
SELECT a.workspace_id, a.contact_id, 'event',
       'interaction.' || a.activity_type,
       jsonb_build_object('description', a.description, 'summary', a.summary),
       COALESCE(a.source,'v1_backfill'), 'migration',
       a.occurred_at, a.received_at, a.external_id, a.raw_data
FROM contact_activity_log a
WHERE a.contact_id IS NOT NULL;

-- ── observations: workspace-level memories ───────────────────
-- v1 workspace_memories has only company_id (no contact_id) — note-level
-- facts attach to the company entity, else the workspace entity.
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at, embedding)
SELECT m.workspace_id,
       COALESCE(m.company_id,
                (SELECT id FROM entities e WHERE e.workspace_id=m.workspace_id AND e.type='workspace' LIMIT 1)),
       'state', 'note.' || lower(coalesce(m.category,'general')),
       to_jsonb(m.content), COALESCE(m.source,'v1_backfill'), 'migration',
       m.valid_from, m.embedding
FROM workspace_memories m
WHERE m.is_active = true AND m.content IS NOT NULL;

-- ── claims: derived from the backfilled state observations ────
-- At migration time there is exactly one observation per
-- (entity, property), so the claim IS that observation.
INSERT INTO claims (workspace_id, entity_id, property, value, confidence, epistemic_class,
                    freshness, supporting_observation_ids, observation_count, last_observed_at, computed_at)
SELECT o.workspace_id, o.entity_id, o.property, o.value,
       0.6, 'observed', 'aging', ARRAY[o.id], 1, o.observed_at, now()
FROM observations o
WHERE o.source = 'v1_backfill' AND o.kind = 'state' AND o.property NOT LIKE 'note.%'
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- workspace-level ICP / industry → claims on the workspace-entity
INSERT INTO claims (workspace_id, entity_id, property, value, confidence, epistemic_class, freshness, computed_at)
SELECT w.id, e.id, f.property, f.value, 0.9, 'asserted', 'fresh', now()
FROM workspaces w
JOIN entities e ON e.workspace_id = w.id AND e.type = 'workspace'
CROSS JOIN LATERAL (VALUES
  ('icp',      to_jsonb(NULLIF(trim(w.icp_text),''))),
  ('industry', to_jsonb(NULLIF(trim(w.industry),'')))
) AS f(property, value)
WHERE f.value IS NOT NULL
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- ── relationships: contact → company (works_at) ──────────────
INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
SELECT c.workspace_id, c.id, c.company_id, 'works_at', 0.9
FROM contacts c
WHERE c.company_id IS NOT NULL
ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;

-- relationships: from the v1 knowledge graph (resolved edges only)
INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
SELECT g.workspace_id, g.subject_id, g.object_id, lower(g.relationship), COALESCE(g.confidence,1.0)
FROM workspace_graph_edges g
WHERE g.subject_id IN (SELECT id FROM entities)
  AND g.object_id  IN (SELECT id FROM entities)   -- skip edges to topics/products (not entities)
ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;

-- ── predictions: from the Mind episode ledger ────────────────
INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value, predicted_confidence,
                         feature_snapshot, model_version, predicted_at,
                         outcome_value, resolved_at, resolution_window_days, created_at)
SELECT m.workspace_id, m.contact_id, COALESCE(m.kind,'icp_fit'),
       jsonb_build_object('score', m.predicted_score, 'fit', m.predicted_fit, 'reason', m.predicted_reason),
       COALESCE(m.predicted_score,50) / 100.0,
       m.features, m.model, m.predicted_at,
       CASE WHEN m.outcome_resolved_at IS NOT NULL
            THEN jsonb_build_object('replied', m.outcome_replied,
                                    'pipeline_from', m.outcome_pipeline_from,
                                    'pipeline_to', m.outcome_pipeline_to,
                                    'revenue', m.outcome_revenue,
                                    'score', m.outcome_score) END,
       m.outcome_resolved_at, COALESCE(m.outcome_window_days,30), m.created_at
FROM mind_episodes m
WHERE m.contact_id IS NOT NULL;

-- ── collections: lead lists + membership ─────────────────────
INSERT INTO collections (id, workspace_id, name, kind, source, created_at)
SELECT id, workspace_id, name, 'list', source, created_at FROM lead_lists
ON CONFLICT (id) DO NOTHING;

INSERT INTO collection_entities (collection_id, entity_id, added_at)
SELECT l.lead_list_id, COALESCE(l.contact_id, l.id), l.created_at
FROM leads l
ON CONFLICT DO NOTHING;

-- lead outreach → event observations (send + reply)
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), 'event', 'interaction.email_sent',
       jsonb_build_object('variant', l.send_variant), 'v1_backfill', 'migration', l.sent_at
FROM leads l WHERE l.sent_at IS NOT NULL;

INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), 'event', 'interaction.reply',
       jsonb_build_object('outcome', l.reply_outcome), 'v1_backfill', 'migration', l.replied_at
FROM leads l WHERE l.replied_at IS NOT NULL;

-- restore the recompute trigger for live operation
ALTER TABLE observations ENABLE TRIGGER observations_enqueue_recompute;

COMMIT;

-- ============================================================
-- VERIFY  (run these after; counts should reconcile)
-- ============================================================
-- SELECT 'companies'  src, count(*) FROM companies
--   UNION ALL SELECT 'company entities', count(*) FROM entities WHERE type='company'
--   UNION ALL SELECT 'contacts', count(*) FROM contacts
--   UNION ALL SELECT 'person entities', count(*) FROM entities WHERE type='person'
--   UNION ALL SELECT 'activity log', count(*) FROM contact_activity_log
--   UNION ALL SELECT 'event observations', count(*) FROM observations WHERE kind='event'
--   UNION ALL SELECT 'claims', count(*) FROM claims
--   UNION ALL SELECT 'mind_episodes', count(*) FROM mind_episodes
--   UNION ALL SELECT 'predictions', count(*) FROM predictions;
--
-- Diff canary — backfilled job_title claim vs the old column:
-- SELECT count(*) AS mismatches
-- FROM contacts c
-- JOIN claims cl ON cl.entity_id = c.id AND cl.property = 'job_title'
-- WHERE to_jsonb(c.job_title) IS DISTINCT FROM cl.value;
-- ============================================================
