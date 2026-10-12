-- ============================================================
-- Back-compat view WRITE layer — INSTEAD OF trigger handlers
--
-- In v2, contacts / companies / lead_lists are VIEWS over the evidence
-- substrate. These INSTEAD OF triggers make the views writable: a write
-- through the view is translated into entities + entity_identifiers +
-- observations (+ predictions / relationships / collections). Without them,
-- INSERT/UPDATE/DELETE on the views fails ("cannot insert into view"), which
-- breaks contact import, contact/company create, lead lists, etc.
--
-- Fresh installs get these from schema.sql. This file is for existing
-- deployments built before they were added. Idempotent (CREATE OR REPLACE +
-- DROP TRIGGER IF EXISTS).
-- ============================================================

-- ── contacts ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.contacts_insert_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  src TEXT := COALESCE(NEW.source, 'v1_compat');
BEGIN
  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

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

  IF NEW.icp_score IS NOT NULL THEN
    INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value,
                             predicted_confidence, feature_snapshot, model_version, predicted_at)
    VALUES (ws, new_id, 'icp_fit',
            jsonb_build_object('score', NEW.icp_score, 'fit', NEW.icp_fit, 'reason', NEW.icp_reasoning),
            (NEW.icp_score::numeric) / 100,
            '{}'::jsonb, 'v1_compat', COALESCE(NEW.icp_scored_at, now()));
  END IF;

  IF NEW.company_id IS NOT NULL THEN
    INSERT INTO relationships (workspace_id, from_entity_id, to_entity_id, type, confidence)
    VALUES (ws, new_id, NEW.company_id, 'works_at', 0.9)
    ON CONFLICT (workspace_id, from_entity_id, to_entity_id, type) DO NOTHING;
  END IF;

  NEW.id := new_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.contacts_update_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  ws UUID := COALESCE(NEW.workspace_id, OLD.workspace_id);
  src TEXT := COALESCE(NEW.source, OLD.source, 'v1_compat');
BEGIN
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

  IF NEW.icp_score IS NOT NULL AND NEW.icp_score IS DISTINCT FROM OLD.icp_score THEN
    INSERT INTO predictions (workspace_id, entity_id, kind, predicted_value,
                             predicted_confidence, feature_snapshot, model_version, predicted_at)
    VALUES (ws, OLD.id, 'icp_fit',
            jsonb_build_object('score', NEW.icp_score, 'fit', NEW.icp_fit, 'reason', NEW.icp_reasoning),
            (NEW.icp_score::numeric) / 100,
            '{}'::jsonb, 'v1_compat', COALESCE(NEW.icp_scored_at, now()));
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.contacts_delete_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'person';
  RETURN OLD;
END;
$function$;

-- ── companies ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.companies_insert_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.companies_update_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.companies_delete_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'company';
  RETURN OLD;
END;
$function$;

-- ── lead_lists ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lead_lists_insert_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
BEGIN
  INSERT INTO collections (id, workspace_id, name, kind, source, metadata, created_at)
  VALUES (new_id, NEW.workspace_id, NEW.name, 'list', NEW.source,
          CASE WHEN NEW.columns IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('columns', NEW.columns) END,
          COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;
  NEW.id := new_id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lead_lists_update_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  UPDATE collections SET
    name = COALESCE(NEW.name, name),
    source = COALESCE(NEW.source, source),
    metadata = CASE
      WHEN NEW.columns IS NOT NULL THEN jsonb_set(COALESCE(metadata,'{}'::jsonb), '{columns}', NEW.columns, true)
      ELSE metadata
    END
  WHERE id = OLD.id;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.lead_lists_delete_handler()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  DELETE FROM collection_entities WHERE collection_id = OLD.id;
  DELETE FROM collections WHERE id = OLD.id;
  RETURN OLD;
END;
$function$;

-- ── triggers (INSTEAD OF, on the views) ─────────────────────
DROP TRIGGER IF EXISTS contacts_insert_trigger    ON public.contacts;
DROP TRIGGER IF EXISTS contacts_update_trigger    ON public.contacts;
DROP TRIGGER IF EXISTS contacts_delete_trigger    ON public.contacts;
DROP TRIGGER IF EXISTS companies_insert_trigger   ON public.companies;
DROP TRIGGER IF EXISTS companies_update_trigger   ON public.companies;
DROP TRIGGER IF EXISTS companies_delete_trigger   ON public.companies;
DROP TRIGGER IF EXISTS lead_lists_insert_trigger  ON public.lead_lists;
DROP TRIGGER IF EXISTS lead_lists_update_trigger  ON public.lead_lists;
DROP TRIGGER IF EXISTS lead_lists_delete_trigger  ON public.lead_lists;

CREATE TRIGGER contacts_insert_trigger    INSTEAD OF INSERT ON public.contacts   FOR EACH ROW EXECUTE FUNCTION contacts_insert_handler();
CREATE TRIGGER contacts_update_trigger    INSTEAD OF UPDATE ON public.contacts   FOR EACH ROW EXECUTE FUNCTION contacts_update_handler();
CREATE TRIGGER contacts_delete_trigger    INSTEAD OF DELETE ON public.contacts   FOR EACH ROW EXECUTE FUNCTION contacts_delete_handler();
CREATE TRIGGER companies_insert_trigger   INSTEAD OF INSERT ON public.companies  FOR EACH ROW EXECUTE FUNCTION companies_insert_handler();
CREATE TRIGGER companies_update_trigger   INSTEAD OF UPDATE ON public.companies  FOR EACH ROW EXECUTE FUNCTION companies_update_handler();
CREATE TRIGGER companies_delete_trigger   INSTEAD OF DELETE ON public.companies  FOR EACH ROW EXECUTE FUNCTION companies_delete_handler();
CREATE TRIGGER lead_lists_insert_trigger  INSTEAD OF INSERT ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION lead_lists_insert_handler();
CREATE TRIGGER lead_lists_update_trigger  INSTEAD OF UPDATE ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION lead_lists_update_handler();
CREATE TRIGGER lead_lists_delete_trigger  INSTEAD OF DELETE ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION lead_lists_delete_handler();
