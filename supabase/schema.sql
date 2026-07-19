--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;

-- Nous self-host: extensions this schema depends on, installed into public to
-- match production. A fresh Supabase project does not enable pgvector by default,
-- and several tables use the public.vector type, so this must run before them.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: kb_entry_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.kb_entry_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed'
);


--
-- Name: kb_entry_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.kb_entry_type AS ENUM (
    'document',
    'url',
    'research'
);


--
-- Name: template_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.template_source AS ENUM (
    'user_upload',
    'gallery',
    'editor',
    'canva',
    'pdf',
    'docx',
    'admin_editor',
    'ai_writer',
    'content_page',
    'recreate',
    'free_tool',
    'proposal_writer',
    'blueprint',
    'legal_document_writer'
);


--
-- Name: TYPE template_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.template_source IS 'Template source types: user_upload (legacy), gallery (template gallery), editor (design from scratch), canva (Canva PDF import), pdf (PDF import), docx (DOCX import), admin_editor (admin-created templates), ai_writer (AI Writer wizard), recreate (Document Recreation wizard), content_page (Content page), document_import (Document import), free_tool (Free tool generators)';


--
-- Name: template_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.template_status AS ENUM (
    'draft',
    'published',
    'archived'
);


--
-- Name: template_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.template_type AS ENUM (
    'whitepaper',
    'proposal',
    'asset',
    'audit',
    'report',
    'contract',
    'sow',
    'agreement',
    'quote',
    'offer_letter',
    'onboarding_document',
    'performance_report',
    'case_study',
    'guide',
    'brochure',
    'one_pager',
    'presentation',
    'invoice',
    'datasheet',
    'document'
);


--
-- Name: TYPE template_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.template_type IS 'Template type: proposal, whitepaper, asset, audit, report, contract, sow, agreement, quote, offer_letter, onboarding_document, performance_report, case_study, guide, brochure, one_pager, presentation, invoice, datasheet';


--
-- Name: workspace_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.workspace_role AS ENUM (
    'owner',
    'admin',
    'member',
    'viewer'
);


--
-- Name: active_account_interaction_properties(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.active_account_interaction_properties() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT ARRAY[
    'interaction.email_received',
    'interaction.email_reply',
    'interaction.reply',
    'interaction.positive_reply',
    'interaction.linkedin_message',
    'interaction.linkedin_reply',
    'interaction.linkedin_replied',
    'interaction.slack_dm',
    'interaction.slack_message',
    'interaction.meeting_held'
  ]
$$;


--
-- Name: add_user_to_team_workspaces(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_to_team_workspaces() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- When a user is added to a team, automatically add them to all existing workspaces in that team
  INSERT INTO workspace_members (workspace_id, user_id, role)
  SELECT 
    w.id,
    NEW.user_id,
    CASE 
      WHEN NEW.role IN ('founder', 'owner', 'admin') THEN 'admin'::workspace_role
      WHEN NEW.role = 'member' THEN 'member'::workspace_role
      ELSE 'viewer'::workspace_role
    END
  FROM workspaces w
  WHERE w.team_id = NEW.team_id
    AND NOT EXISTS (
      SELECT 1 FROM workspace_members wm 
      WHERE wm.workspace_id = w.id AND wm.user_id = NEW.user_id
    );
  
  RETURN NEW;
END;
$$;


--
-- Name: bump_playground_thread_updated(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bump_playground_thread_updated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update playground_threads
    set updated_at = now()
    where id = new.thread_id;
  return new;
end
$$;


--
-- Name: calculate_target_word_count(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_target_word_count(layout_structure jsonb, page_type text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  blocks JSONB;
  text_blocks_count INTEGER := 0;
  heading_blocks_count INTEGER := 0;
  graphic_blocks_count INTEGER := 0;
  layout_type TEXT;
  total_content_blocks INTEGER;
  total_blocks INTEGER;
  graphic_ratio NUMERIC;
  base_words NUMERIC;
  page_type_multiplier NUMERIC := 1.0;
  result INTEGER;
BEGIN
  -- CRITICAL: These page types have NO word count limit (return NULL)
  IF page_type IN ('cover', 'testimonials', 'table_of_contents', 'references') THEN
    RETURN NULL;
  END IF;
  
  -- Extract blocks array
  blocks := layout_structure->'blocks';
  
  -- Count block types
  SELECT 
    COUNT(*) FILTER (WHERE (elem->>'block_type') IN ('text', 'paragraph')),
    COUNT(*) FILTER (WHERE (elem->>'block_type') = 'heading'),
    COUNT(*) FILTER (WHERE (elem->>'block_type') IN ('graphic', 'image'))
  INTO text_blocks_count, heading_blocks_count, graphic_blocks_count
  FROM jsonb_array_elements(blocks) AS elem;
  
  -- Get layout type
  layout_type := COALESCE(layout_structure->>'layout_type', 'single_column');
  
  total_content_blocks := text_blocks_count + heading_blocks_count;
  total_blocks := total_content_blocks + graphic_blocks_count;
  
  -- If no content blocks, return minimum
  IF total_content_blocks = 0 THEN
    RETURN 90; -- Updated minimum
  END IF;
  
  -- PAGE TYPE MULTIPLIER: Some page types need MORE text
  CASE page_type
    WHEN 'introduction' THEN page_type_multiplier := 1.3;
    WHEN 'conclusion' THEN page_type_multiplier := 1.3;
    WHEN 'executive_summary' THEN page_type_multiplier := 1.4;
    WHEN 'foreword' THEN page_type_multiplier := 1.2;
    ELSE page_type_multiplier := 1.0;
  END CASE;
  
  -- Calculate base capacity (increased by 20% from previous)
  IF total_content_blocks <= 2 THEN
    -- Minimal layout: target 125-200 words range
    -- Base calculation: aim for ~162 words for minimal layouts (centered in 125-200 range)
    base_words := (text_blocks_count * 100.0) + (heading_blocks_count * 5.0);
  ELSE
    -- Normal layout: increased word count per block (20% increase)
    base_words := (text_blocks_count * 74.4) + (heading_blocks_count * 4.8); -- 20% increase from 62*1.2 and 4*1.2
  END IF;
  
  -- Graphics reduce available space (adjusted for minimal layouts to target 125-200 range)
  IF total_content_blocks <= 2 THEN
    -- For minimal layouts: reduce by less to keep in 125-200 range
    base_words := base_words - (graphic_blocks_count * 50.0);
  ELSE
    -- For normal layouts: increased penalty by 20% to maintain balance
    base_words := base_words - (graphic_blocks_count * 76.8); -- 20% increase from 64*1.2
  END IF;
  
  -- Layout type adjustment
  IF layout_type = 'two_column' THEN
    base_words := base_words * 0.9;
  END IF;
  
  -- Apply page type multiplier
  base_words := base_words * page_type_multiplier;
  
  -- Visual density categories with specific word count ranges
  graphic_ratio := graphic_blocks_count::NUMERIC / GREATEST(1, total_blocks);
  
  -- Determine word count based on visual density
  IF total_content_blocks <= 2 AND graphic_blocks_count >= 1 THEN
    -- Very minimal visual layout: 125-200 words (UPDATED from 60-96)
    result := GREATEST(125, LEAST(200, base_words));
  ELSIF graphic_ratio >= 0.4 THEN
    -- Very visual layout (40%+ graphics): 90-140 words
    result := GREATEST(90, LEAST(140, base_words));
  ELSIF graphic_ratio > 0 THEN
    -- Moderate visual layout (some graphics): 125-200 words
    result := GREATEST(125, LEAST(200, base_words));
  ELSE
    -- Text-heavy layout (no graphics): 200-270 words
    IF page_type IN ('introduction', 'conclusion', 'executive_summary', 'foreword') THEN
      result := GREATEST(200, LEAST(270, base_words));
    ELSE
      result := GREATEST(200, LEAST(270, base_words));
    END IF;
  END IF;
  
  -- Ensure final bounds (90-270)
  RETURN GREATEST(90, LEAST(270, ROUND(result)));
END;
$$;


--
-- Name: FUNCTION calculate_target_word_count(layout_structure jsonb, page_type text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.calculate_target_word_count(layout_structure jsonb, page_type text) IS 'Calculates target word count for page layouts. Minimal layouts (≤2 content blocks + graphics): 125-200 words. Very visual (40%+ graphics): 90-140 words. Moderate visual (some graphics): 125-200 words. Text-heavy (no graphics): 200-270 words. Special page types (cover, testimonials, table_of_contents, references) return NULL (no limit).';


--
-- Name: cleanup_expired_oauth_states(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_oauth_states() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM oauth_states WHERE expires_at < NOW();
  RETURN NEW;
END;
$$;


--
-- Name: cleanup_slack_processed_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_slack_processed_events() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM slack_processed_events WHERE processed_at < now() - interval '48 hours';
END;
$$;


--
-- Name: companies_delete_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.companies_delete_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'company';
  RETURN OLD;
END;
$$;


--
-- Name: companies_insert_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.companies_insert_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: companies_update_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.companies_update_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: compute_contact_pipeline_stage(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_contact_pipeline_stage(p_contact_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_stage TEXT := 'identified';
BEGIN
  -- CLIENT: permanent — any closed signal ever recorded
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN ('proposal_signed','deal_won','payment_received')
  ) THEN
    RETURN 'client';
  END IF;

  -- EVALUATING: high-intent signal within last 60 days
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'meeting_held',
        'pricing_page_visit',
        'proposal_sent',
        'proposal_viewed',
        'outbound_positive_reply',
        'deal_created',
        'trial_started'
      )
      AND occurred_at >= now() - interval '60 days'
  ) THEN
    RETURN 'evaluating';
  END IF;

  -- INTERESTED: medium-intent signal within last 30 days
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'email_reply',
        'linkedin_message',
        'linkedin_connected',
        'content_download',
        'community_joined',
        'event_attended',
        'website_revisit'
      )
      AND occurred_at >= now() - interval '30 days'
  ) THEN
    RETURN 'interested';
  END IF;

  -- AWARE: low-intent signal within last 30 days
  IF EXISTS (
    SELECT 1 FROM contact_activity_log
    WHERE contact_id = p_contact_id
      AND activity_type IN (
        'website_visit',
        'email_opened',
        'linkedin_view',
        'social_engagement',
        'ad_impression',
        'newsletter_signup'
      )
      AND occurred_at >= now() - interval '30 days'
  ) THEN
    RETURN 'aware';
  END IF;

  RETURN 'identified';
END;
$$;


--
-- Name: contacts_delete_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contacts_delete_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Soft-merge the entity (claims/observations preserved as audit trail).
  UPDATE entities SET status = 'merged' WHERE id = OLD.id AND type = 'person';
  RETURN OLD;
END;
$$;


--
-- Name: contacts_insert_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contacts_insert_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: contacts_update_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.contacts_update_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: create_template_settings_on_template_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_template_settings_on_template_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO template_settings (template_id)
  VALUES (NEW.id)
  ON CONFLICT (template_id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: create_workflow_version_on_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_workflow_version_on_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_version INTEGER;
BEGIN
  -- Only create version if definition changed
  IF OLD.definition IS DISTINCT FROM NEW.definition THEN
    -- Get next version number
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO next_version
    FROM workflow_versions
    WHERE workflow_id = NEW.id;

    -- Create version snapshot
    INSERT INTO workflow_versions (workflow_id, definition, version_number, created_by)
    VALUES (NEW.id, OLD.definition, next_version, NEW.created_by);

    -- Cleanup old versions (keep last 10)
    DELETE FROM workflow_versions
    WHERE workflow_id = NEW.id
    AND version_number < (
      SELECT MAX(version_number) - 9
      FROM workflow_versions
      WHERE workflow_id = NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: decay_pipeline_stages(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decay_pipeline_stages() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- ── evaluating → interested ───────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"interested"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'evaluating'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.meeting_held',
          'interaction.pricing_page_visit',
          'interaction.proposal_sent',
          'interaction.proposal_viewed',
          'interaction.outbound_positive_reply',
          'interaction.deal_created',
          'interaction.trial_started'
        )
        AND o.observed_at >= now() - interval '60 days'
    );

  -- ── interested → aware ────────────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"aware"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'interested'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.email_reply',
          'interaction.linkedin_message',
          'interaction.linkedin_connected',
          'interaction.content_download',
          'interaction.community_joined',
          'interaction.event_attended',
          'interaction.website_revisit'
        )
        AND o.observed_at >= now() - interval '30 days'
    );

  -- ── aware → identified ────────────────────────────────────────────────────
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT c.workspace_id, c.entity_id, 'state', 'pipeline_stage', '"identified"'::jsonb,
         'system', 'inference', now()
  FROM claims c
  LEFT JOIN claims src
    ON src.workspace_id = c.workspace_id
   AND src.entity_id    = c.entity_id
   AND src.property     = 'pipeline_stage_source'
   AND src.invalid_at   IS NULL
  WHERE c.property   = 'pipeline_stage'
    AND c.invalid_at IS NULL
    AND (c.value #>> '{}') = 'aware'
    AND (src.value #>> '{}') IS DISTINCT FROM 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM observations o
      WHERE o.entity_id  = c.entity_id
        AND o.property IN (
          'interaction.website_visit',
          'interaction.email_opened',
          'interaction.linkedin_view',
          'interaction.social_engagement',
          'interaction.ad_impression',
          'interaction.newsletter_signup'
        )
        AND o.observed_at >= now() - interval '30 days'
    );
END;
$$;


--
-- Name: deduct_ops_balance(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.deduct_ops_balance(p_team_id uuid, p_cost integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  UPDATE teams
  SET ops_balance = GREATEST(0, ops_balance - p_cost)
  WHERE id = p_team_id
  RETURNING ops_balance INTO v_new_balance;
  RETURN v_new_balance;
END;
$$;


--
-- Name: enqueue_claim_recompute(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_claim_recompute() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO claim_jobs (workspace_id, entity_id, property)
  VALUES (NEW.workspace_id, NEW.entity_id, NEW.property);
  RETURN NEW;
END; $$;


--
-- Name: generate_referral_code(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_referral_code(user_name text DEFAULT NULL::text) RETURNS text
    LANGUAGE plpgsql
    AS $$
  DECLARE
    base_code TEXT;
    final_code TEXT;
    counter INTEGER := 0;
  BEGIN
    IF user_name IS NOT NULL AND LENGTH(TRIM(user_name)) > 0 THEN
      base_code := UPPER(LEFT(REGEXP_REPLACE(user_name, '[^a-zA-Z0-9]', '', 'g'), 6));
      IF LENGTH(base_code) < 3 THEN
        base_code := 'REF';
      END IF;
    ELSE
      base_code := 'REF';
    END IF;

    LOOP
      final_code := base_code || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
      IF NOT EXISTS (SELECT 1 FROM affiliate_partners WHERE referral_code = final_code) THEN
        RETURN final_code;
      END IF;
      counter := counter + 1;
      IF counter > 100 THEN
        final_code := 'REF' || gen_random_uuid()::TEXT;
        final_code := UPPER(LEFT(REPLACE(final_code, '-', ''), 10));
        RETURN final_code;
      END IF;
    END LOOP;
  END;
  $$;


--
-- Name: get_next_template_version(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_next_template_version(template_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_version INTEGER;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO next_version
  FROM template_versions
  WHERE template_id = template_uuid;
  RETURN next_version;
END;
$$;


--
-- Name: get_user_workspace_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_workspace_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid();
$$;


--
-- Name: FUNCTION get_user_workspace_ids(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_workspace_ids() IS 'Returns workspace IDs for current user - bypasses RLS to avoid recursion';


--
-- Name: increment_affiliate_referrals(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_affiliate_referrals(affiliate_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
  BEGIN
    UPDATE affiliate_partners
    SET total_referrals = total_referrals + 1,
        updated_at = NOW()
    WHERE id = affiliate_id;
  END;
  $$;


--
-- Name: increment_contact_interactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_contact_interactions(contact_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
    UPDATE contacts SET interaction_count = interaction_count + 1 WHERE id =           
  contact_id;                                 
  $$;


--
-- Name: increment_signup_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_signup_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE signup_stats
  SET stat_value = stat_value + 1, updated_at = now()
  WHERE stat_key = 'total_signups';
  RETURN NEW;
END;
$$;


--
-- Name: increment_skill_download(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_skill_download(p_slug text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare new_count bigint;
begin
  insert into skill_downloads (slug, count) values (p_slug, 1)
  on conflict (slug) do update
    set count = skill_downloads.count + 1, updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;


--
-- Name: increment_template_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_template_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- This will be called from application code after creating workflow from template
  RETURN NEW;
END;
$$;


--
-- Name: insert_asset_library_entry(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_asset_library_entry(p_template_id uuid, p_type text, p_title text, p_url text DEFAULT NULL::text, p_file_path text DEFAULT NULL::text) RETURNS TABLE(id uuid, template_id uuid, workspace_id uuid, type text, title text, url text, file_path text, status text, content_text text, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_entry_id UUID;
  v_type_enum kb_entry_type;
  v_workspace_id UUID;
BEGIN
  v_type_enum := p_type::kb_entry_type;

  SELECT t.workspace_id INTO v_workspace_id
  FROM templates t
  WHERE t.id = p_template_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Template not found or has no workspace_id: %', p_template_id;
  END IF;

  INSERT INTO knowledge_base_entries (
    template_id,
    workspace_id,
    type,
    title,
    url,
    file_path,
    status
  ) VALUES (
    p_template_id,
    v_workspace_id,
    v_type_enum,
    p_title,
    p_url,
    p_file_path,
    'pending'::kb_entry_status
  )
  RETURNING knowledge_base_entries.id INTO v_entry_id;

  RETURN QUERY
  SELECT 
    kb.id,
    kb.template_id,
    kb.workspace_id,
    kb.type::TEXT,
    kb.title,
    kb.url,
    kb.file_path,
    kb.status::TEXT,
    kb.content_text,
    kb.created_at
  FROM knowledge_base_entries kb
  WHERE kb.id = v_entry_id;
END;
$$;


--
-- Name: is_workspace_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_workspace_member(workspace_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_members
                 WHERE workspace_id = workspace_uuid AND user_id = auth.uid());
$$;


--
-- Name: FUNCTION is_workspace_member(workspace_uuid uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_workspace_member(workspace_uuid uuid) IS 'Helper function to check if current user is member of a workspace';


--
-- Name: lead_list_counts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_list_counts(p_ws uuid) RETURNS TABLE(lead_list_id uuid, lead_count bigint)
    LANGUAGE sql STABLE
    AS $$
    SELECT l.lead_list_id, count(*)::bigint
    FROM leads l
    WHERE l.workspace_id = p_ws
    GROUP BY l.lead_list_id
  $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    property text NOT NULL,
    value jsonb NOT NULL,
    distribution jsonb,
    confidence real NOT NULL,
    epistemic_class text NOT NULL,
    freshness text DEFAULT 'fresh'::text NOT NULL,
    decays_at timestamp with time zone,
    supporting_observation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    last_observed_at timestamp with time zone,
    embedding public.vector(1536),
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from timestamp with time zone,
    invalid_at timestamp with time zone,
    CONSTRAINT claims_epistemic_class_check CHECK ((epistemic_class = ANY (ARRAY['observed'::text, 'inferred'::text, 'predicted'::text, 'asserted'::text]))),
    CONSTRAINT claims_freshness_check CHECK ((freshness = ANY (ARRAY['fresh'::text, 'aging'::text, 'suspect'::text, 'expired'::text])))
);


--
-- Name: collection_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_entities (
    collection_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    source text
);


--
-- Name: collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'list'::text NOT NULL,
    source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    merged_into uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'merged'::text, 'archived'::text]))),
    CONSTRAINT entities_type_check CHECK ((type = ANY (ARRAY['person'::text, 'company'::text, 'deal'::text, 'workspace'::text])))
);


--
-- Name: entity_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_identifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    confidence real DEFAULT 1.0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_identifiers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL,
    property text NOT NULL,
    value jsonb NOT NULL,
    source text NOT NULL,
    method text NOT NULL,
    source_confidence real,
    observed_at timestamp with time zone NOT NULL,
    ingested_at timestamp with time zone DEFAULT now() NOT NULL,
    external_id text,
    raw jsonb,
    content_hash text,
    embedding public.vector(1536),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id uuid,
    CONSTRAINT observations_kind_check CHECK ((kind = ANY (ARRAY['state'::text, 'event'::text])))
);


--
-- Name: leads; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.leads AS
 SELECT e.id,
    ce.collection_id AS lead_list_id,
    e.workspace_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'email'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS email,
    TRIM(BOTH ' '::text FROM concat(COALESCE(( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'first_name'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1), ''::text), ' ', COALESCE(( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'last_name'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1), ''::text))) AS name,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'company'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS company,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'linkedin_url'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS linkedin_url,
    ( SELECT min(observations.observed_at) AS min
           FROM public.observations
          WHERE ((observations.entity_id = e.id) AND (observations.property = 'interaction.email_sent'::text))) AS sent_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'send_variant'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS send_variant,
    COALESCE((( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'is_repeat_contact'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::boolean, false) AS is_repeat_contact,
    COALESCE(( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'features'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1), '{}'::jsonb) AS features,
    COALESCE(( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'fields'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1), '{}'::jsonb) AS fields,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'scorecard_score'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS scorecard_score,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'sentiment'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS reply_outcome,
    ( SELECT max(observations.observed_at) AS max
           FROM public.observations
          WHERE ((observations.entity_id = e.id) AND (observations.property = ANY (ARRAY['interaction.reply'::text, 'interaction.positive_reply'::text, 'interaction.negative_reply'::text, 'interaction.linkedin_reply'::text])))) AS replied_at,
    COALESCE(
        CASE
            WHEN (( SELECT (claims.value #>> '{}'::text[])
               FROM public.claims
              WHERE ((claims.entity_id = e.id) AND (claims.property = 'reachability_status'::text) AND (claims.invalid_at IS NULL))
             LIMIT 1) = 'bounced'::text) THEN 'bounced'::text
            WHEN (EXISTS ( SELECT 1
               FROM public.observations
              WHERE ((observations.entity_id = e.id) AND (observations.property = ANY (ARRAY['interaction.reply'::text, 'interaction.positive_reply'::text, 'interaction.negative_reply'::text, 'interaction.linkedin_reply'::text]))))) THEN 'replied'::text
            WHEN (EXISTS ( SELECT 1
               FROM public.observations
              WHERE ((observations.entity_id = e.id) AND (observations.property = 'interaction.email_sent'::text)))) THEN 'sent'::text
            WHEN (EXISTS ( SELECT 1
               FROM public.observations
              WHERE ((observations.entity_id = e.id) AND (observations.property = 'interaction.linkedin_message_sent'::text)))) THEN 'messaged'::text
            WHEN (EXISTS ( SELECT 1
               FROM public.observations
              WHERE ((observations.entity_id = e.id) AND (observations.property = 'interaction.linkedin_connected'::text)))) THEN 'connected'::text
            ELSE 'pending'::text
        END, 'pending'::text) AS status,
        CASE
            WHEN (EXISTS ( SELECT 1
               FROM public.observations
              WHERE (observations.entity_id = e.id)
             LIMIT 1)) THEN e.id
            ELSE NULL::uuid
        END AS contact_id,
    ce.added_at AS created_at,
    COALESCE(( SELECT max(claims.computed_at) AS max
           FROM public.claims
          WHERE (claims.entity_id = e.id)), ce.added_at) AS updated_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'domain'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS domain,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'reachability_status'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS email_status,
    ( SELECT observations.source
           FROM public.observations
          WHERE ((observations.entity_id = e.id) AND (observations.kind = 'event'::text) AND (observations.property ~~ 'interaction.%'::text) AND (observations.property <> 'interaction.enrichment_run'::text) AND (observations.source <> ALL (ARRAY['prospeo'::text, 'apollo'::text])))
          ORDER BY observations.observed_at DESC
         LIMIT 1) AS last_channel,
    ce.source
   FROM ((public.entities e
     JOIN public.collection_entities ce ON ((ce.entity_id = e.id)))
     JOIN public.collections c ON (((c.id = ce.collection_id) AND (c.kind = 'list'::text))))
  WHERE ((e.type = 'person'::text) AND (e.status = 'active'::text));


--
-- Name: lead_list_leads(uuid, uuid, integer, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_list_leads(p_ws uuid, p_list uuid, p_lim integer DEFAULT 50, p_off integer DEFAULT 0, p_icp text DEFAULT NULL::text, p_sort text DEFAULT 'recent'::text) RETURNS SETOF public.leads
    LANGUAGE sql STABLE
    AS $$
  SELECT l.* FROM leads l
  LEFT JOIN LATERAL (
    SELECT (p.predicted_value->>'score')::numeric AS score
    FROM predictions p
    WHERE p.workspace_id = p_ws AND p.entity_id = l.id AND p.kind = 'icp_fit'
    ORDER BY p.predicted_at DESC
    LIMIT 1
  ) pred ON TRUE
  WHERE l.workspace_id = p_ws AND l.lead_list_id = p_list
    AND (p_icp IS NULL OR (l.fields->>'icp') = p_icp)
  ORDER BY
    CASE WHEN p_sort = 'icp_score_desc'
      THEN COALESCE(pred.score, (l.fields->>'icp_score')::numeric) END DESC NULLS LAST,
    CASE WHEN p_sort = 'icp_score_asc'
      THEN COALESCE(pred.score, (l.fields->>'icp_score')::numeric) END ASC  NULLS LAST,
    l.created_at DESC
  LIMIT GREATEST(p_lim, 1) OFFSET GREATEST(p_off, 0)
$$;


--
-- Name: lead_lists_delete_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_lists_delete_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM collection_entities WHERE collection_id = OLD.id;
  DELETE FROM collections WHERE id = OLD.id;
  RETURN OLD;
END;
$$;


--
-- Name: lead_lists_insert_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_lists_insert_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: lead_lists_update_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_lists_update_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: leads_delete_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leads_delete_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF OLD.lead_list_id IS NOT NULL THEN
      DELETE FROM collection_entities WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
    END IF;
    RETURN OLD;
  END;
  $$;


--
-- Name: leads_insert_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leads_insert_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  fn_part TEXT := NULLIF(trim(split_part(COALESCE(NEW.name,''), ' ', 1)),'');
  ln_part TEXT := NULLIF(trim(substring(COALESCE(NEW.name,'') FROM position(' ' IN COALESCE(NEW.name,'')||' ') + 1)),'');
  e_email TEXT := lower(NULLIF(trim(NEW.email),''));
  e_li    TEXT := NULLIF(trim(NEW.linkedin_url),'');
  e_li_norm TEXT := regexp_replace(regexp_replace(lower(split_part(NULLIF(trim(NEW.linkedin_url),''), '?', 1)), '^https?://(www\.)?', ''), '/+$', '');
  existing_id UUID;
BEGIN
  -- Resolve to an existing entity by a strong identifier so a lead doesn't spawn
  -- a duplicate person. LinkedIn match is normalized (lowercase, drop query, strip
  -- protocol/www, strip trailing slash) so URL-shape differences still merge.
  IF NEW.contact_id IS NOT NULL THEN
    new_id := NEW.contact_id;
  ELSE
    SELECT entity_id INTO existing_id FROM entity_identifiers
     WHERE workspace_id = ws AND status = 'active'
       AND ((e_email IS NOT NULL AND kind = 'email' AND value = e_email)
         OR (e_li_norm IS NOT NULL AND e_li_norm <> '' AND kind = 'linkedin_url'
             AND regexp_replace(regexp_replace(lower(split_part(value, '?', 1)), '^https?://(www\.)?', ''), '/+$', '') = e_li_norm))
     LIMIT 1;
    IF existing_id IS NOT NULL THEN new_id := existing_id; END IF;
  END IF;

  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  -- Identifiers
  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('email',        e_email),
    ('linkedin_url', e_li)
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  -- Initial state observations
  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, new_id, 'state', k.property, k.value, 'lead_list', 'trigger', now() FROM (VALUES
    ('first_name',        to_jsonb(fn_part)),
    ('last_name',         to_jsonb(ln_part)),
    ('company',           to_jsonb(NULLIF(trim(NEW.company),''))),
    ('lead_status',       to_jsonb(NULLIF(trim(NEW.status),''))),
    ('send_variant',      to_jsonb(NULLIF(trim(NEW.send_variant),''))),
    ('scorecard_score',   to_jsonb(NEW.scorecard_score)),
    ('is_repeat_contact', to_jsonb(NEW.is_repeat_contact)),
    ('features',          CASE WHEN NEW.features IS NULL OR NEW.features = '{}'::jsonb THEN NULL ELSE NEW.features END),
    ('fields',            CASE WHEN NEW.fields   IS NULL OR NEW.fields   = '{}'::jsonb THEN NULL ELSE NEW.fields   END),
    ('pipeline_stage',    to_jsonb('cold'::text))
  ) AS k(property, value)
  WHERE k.value IS NOT NULL;

  IF NEW.sent_at IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, new_id, 'event', 'interaction.email_sent',
            jsonb_build_object('variant', NEW.send_variant),
            'lead_list', 'trigger', NEW.sent_at);
  END IF;
  IF NEW.replied_at IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, new_id, 'event', 'interaction.reply',
            jsonb_build_object('outcome', NEW.reply_outcome),
            'lead_list', 'trigger', NEW.replied_at);
  END IF;

  IF NEW.lead_list_id IS NOT NULL THEN
    INSERT INTO collection_entities (collection_id, entity_id, added_at, source)
    VALUES (NEW.lead_list_id, new_id, COALESCE(NEW.created_at, now()), NULLIF(trim(NEW.source),''))
    ON CONFLICT (collection_id, entity_id) DO UPDATE
      SET source = COALESCE(EXCLUDED.source, collection_entities.source);
  END IF;

  NEW.id := new_id;
  RETURN NEW;
END;
$_$;


--
-- Name: leads_update_handler(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leads_update_handler() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  DECLARE
    ws UUID := COALESCE(NEW.workspace_id, OLD.workspace_id);
  BEGIN
    IF NEW.sent_at IS DISTINCT FROM OLD.sent_at AND NEW.sent_at IS NOT NULL THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'event', 'interaction.email_sent',
              jsonb_build_object('variant', NEW.send_variant), 'lead_list', 'trigger', NEW.sent_at)
      ON CONFLICT DO NOTHING;
    END IF;
  
    IF NEW.replied_at IS DISTINCT FROM OLD.replied_at AND NEW.replied_at IS NOT NULL THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'event',
              CASE NEW.reply_outcome
                WHEN 'positive'       THEN 'interaction.positive_reply'
                WHEN 'negative'       THEN 'interaction.negative_reply'
                WHEN 'do_not_contact' THEN 'interaction.do_not_contact'
                WHEN 'unsubscribed'   THEN 'interaction.unsubscribed'
                ELSE                       'interaction.reply'
              END,
              jsonb_build_object('outcome', NEW.reply_outcome), 'lead_list', 'trigger', NEW.replied_at);
    END IF;
  
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'lead_status', to_jsonb(NEW.status), 'lead_list', 'trigger', now());
      IF NEW.status = 'bounced' THEN
        INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
        VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('bounced'::text), 'lead_list', 'trigger',
  now());
        INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
        VALUES (ws, OLD.id, 'event', 'interaction.email_bounced',
                jsonb_build_object('via','lead_status'), 'lead_list', 'trigger', now());
      END IF;
    END IF;

    IF NEW.reply_outcome IS DISTINCT FROM OLD.reply_outcome AND NEW.reply_outcome IS NOT NULL THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'sentiment', to_jsonb(NEW.reply_outcome::text), 'lead_list', 'trigger', now());
      IF NEW.reply_outcome = 'positive' THEN
        INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
        VALUES (ws, OLD.id, 'state', 'pipeline_stage', to_jsonb('interested'::text), 'lead_list', 'trigger',
  now());
      END IF;
      IF NEW.reply_outcome = 'unsubscribed' THEN
        INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
        VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('unsubscribed'::text), 'lead_list',
  'trigger', now());
      END IF;
    END IF;

    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    SELECT ws, OLD.id, 'state', k.property, k.new_v, 'lead_list', 'trigger', now() FROM (VALUES
      ('send_variant',      to_jsonb(NULLIF(trim(NEW.send_variant),'')),
  to_jsonb(NULLIF(trim(OLD.send_variant),''))),
      ('scorecard_score',   to_jsonb(NEW.scorecard_score),                to_jsonb(OLD.scorecard_score)),
      ('is_repeat_contact', to_jsonb(NEW.is_repeat_contact),              to_jsonb(OLD.is_repeat_contact)),
      ('features',          CASE WHEN NEW.features IS NULL OR NEW.features = '{}'::jsonb THEN NULL ELSE
  NEW.features END,
                            CASE WHEN OLD.features IS NULL OR OLD.features = '{}'::jsonb THEN NULL ELSE
  OLD.features END),
      ('fields',            CASE WHEN NEW.fields IS NULL OR NEW.fields = '{}'::jsonb THEN NULL ELSE NEW.fields
  END,
                            CASE WHEN OLD.fields IS NULL OR OLD.fields = '{}'::jsonb THEN NULL ELSE OLD.fields
  END)
    ) AS k(property, new_v, old_v) 
    WHERE k.new_v IS NOT NULL AND k.new_v IS DISTINCT FROM k.old_v;

    IF NEW.lead_list_id IS DISTINCT FROM OLD.lead_list_id THEN
      IF OLD.lead_list_id IS NOT NULL THEN
        DELETE FROM collection_entities WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
      END IF;
      IF NEW.lead_list_id IS NOT NULL THEN
        INSERT INTO collection_entities (collection_id, entity_id, added_at)
        VALUES (NEW.lead_list_id, OLD.id, now()) ON CONFLICT DO NOTHING;
      END IF;
    END IF;


    RETURN NEW;
  END;
  $$;


--
-- Name: list_document_types(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_document_types() RETURNS TABLE(document_type text, subtype text, display_name text, page_count_range jsonb)
    LANGUAGE plpgsql STABLE
    AS $$                                                                                                                                                                                               
  BEGIN                                                                                                                                                                                                                       
    RETURN QUERY                                                                                                                                                                                                              
    SELECT dtk.document_type, dtk.subtype,                                                                                                                                                                                    
      CASE WHEN dtk.subtype IS NOT NULL THEN dtk.subtype ELSE dtk.document_type END AS display_name,                                                                                                                          
      dtk.page_count_range                                                                                                                                                                                                    
    FROM document_type_knowledge dtk                                                                                                                                                                                          
    ORDER BY dtk.document_type, CASE WHEN dtk.subtype IS NULL THEN 0 ELSE 1 END, dtk.subtype;                                                                                                                                 
  END;                                                                                                                                                                                                                        
  $$;


--
-- Name: mark_inspirations_for_metadata_extraction(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_inspirations_for_metadata_extraction() RETURNS TABLE(id uuid, image_url text, type text, category text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    bi.id,
    bi.image_url,
    bi.type,
    bi.category
  FROM background_inspirations bi
  WHERE bi.active = true
    AND (bi.style IS NULL OR bi.colors = '{}'::text[] OR bi.theme_type IS NULL)
  ORDER BY bi.created_at DESC;
END;
$$;


--
-- Name: FUNCTION mark_inspirations_for_metadata_extraction(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mark_inspirations_for_metadata_extraction() IS 'Returns all active background inspirations that need metadata extraction (style, colors, theme_type). Use this to identify which inspirations need to be processed via AI.';


--
-- Name: match_company_assets(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_company_assets(query_embedding public.vector, workspace_id_param uuid, match_threshold double precision DEFAULT 0.2, match_count integer DEFAULT 10) RETURNS TABLE(company_asset_id uuid, chunk_text text, chunk_index integer, similarity double precision, metadata jsonb, asset_title text, asset_type text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ca.id as company_asset_id,
    cavs.chunk_text,
    cavs.chunk_index,
    (1 - (cavs.embedding <=> query_embedding))::float as similarity,
    cavs.metadata,
    ca.title as asset_title,
    ca.type as asset_type
  FROM company_assets_vector_store cavs
  INNER JOIN company_assets ca ON cavs.company_asset_id = ca.id
  WHERE ca.workspace_id = workspace_id_param
    AND ca.status = 'completed'
    AND (1 - (cavs.embedding <=> query_embedding)) > match_threshold
  ORDER BY cavs.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_knowledge_base(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_base(query_embedding public.vector, workspace_id uuid, match_threshold double precision DEFAULT 0.5, match_count integer DEFAULT 5) RETURNS TABLE(id uuid, title text, content_text text, type text, url text, file_path text, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.title,
    kb.content_text,
    kb.type::text,
    kb.url,
    kb.file_path,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM knowledge_base_entries kb
  WHERE kb.workspace_id = match_knowledge_base.workspace_id
    AND kb.status = 'completed'
    AND kb.embedding IS NOT NULL
    AND 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_knowledge_base_vector_store(public.vector, double precision, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_base_vector_store(query_embedding public.vector, match_threshold double precision, match_count integer, template_id uuid) RETURNS TABLE(id uuid, knowledge_base_entry_id uuid, chunk_text text, chunk_index integer, embedding public.vector, similarity double precision, metadata jsonb)
    LANGUAGE plpgsql
    AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT
    knowledge_base_vector_store.id,
    knowledge_base_vector_store.knowledge_base_entry_id,
    knowledge_base_vector_store.chunk_text,
    knowledge_base_vector_store.chunk_index,
    knowledge_base_vector_store.embedding,
    (knowledge_base_vector_store.embedding <#> query_embedding) * -1 AS similarity,
    knowledge_base_vector_store.metadata
  FROM knowledge_base_vector_store
  INNER JOIN knowledge_base_entries ON knowledge_base_vector_store.knowledge_base_entry_id = knowledge_base_entries.id
  WHERE knowledge_base_entries.template_id = match_knowledge_base_vector_store.template_id -- Filter by template_id
    AND (knowledge_base_vector_store.embedding <#> query_embedding) * -1 > match_threshold
  ORDER BY (knowledge_base_vector_store.embedding <#> query_embedding) * -1 DESC
  LIMIT match_count;
END;
$$;


--
-- Name: match_knowledge_base_vector_store(public.vector, uuid, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_knowledge_base_vector_store(query_embedding public.vector, template_id_param uuid, match_threshold double precision, match_count integer) RETURNS TABLE(knowledge_base_entry_id uuid, chunk_text text, chunk_index integer, similarity double precision, metadata jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    kbe.id as knowledge_base_entry_id,
    kbvs.chunk_text,
    kbvs.chunk_index,
    1 - (kbvs.embedding <=> query_embedding) as similarity,
    kbvs.metadata
  FROM knowledge_base_vector_store kbvs
  INNER JOIN knowledge_base_entries kbe ON kbvs.knowledge_base_entry_id = kbe.id
  WHERE kbe.template_id = template_id_param
    AND 1 - (kbvs.embedding <=> query_embedding) > match_threshold
  ORDER BY kbvs.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


--
-- Name: match_workspace_memories(uuid, public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_workspace_memories(p_workspace_id uuid, p_embedding public.vector, p_threshold double precision, p_limit integer) RETURNS TABLE(id uuid, content text, category text, source text, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.category,
    m.source,
    (1 - (m.embedding <=> p_embedding))::FLOAT AS similarity
  FROM workspace_memories m
  WHERE m.workspace_id = p_workspace_id
    AND m.is_active = true
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> p_embedding) >= p_threshold
  ORDER BY m.embedding <=> p_embedding
  LIMIT p_limit;
END;
$$;


--
-- Name: people_coverage(uuid, text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_coverage(p_workspace uuid, p_title text DEFAULT NULL::text, p_keyword text DEFAULT NULL::text, p_stale_days integer DEFAULT 90, p_limit integer DEFAULT 25) RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
    WITH matched AS (
      SELECT e.id
      FROM entities e
      WHERE e.workspace_id = p_workspace
        AND e.type = 'person' AND e.status = 'active'
        AND (p_title IS NULL OR EXISTS (
          SELECT 1 FROM claims c
          WHERE c.entity_id = e.id AND c.property = 'job_title'
            AND c.invalid_at IS NULL AND (c.value #>> '{}') ILIKE '%'||p_title||'%'))
        AND (p_keyword IS NULL OR EXISTS (
          SELECT 1 FROM claims c
          WHERE c.entity_id = e.id AND c.property IN ('job_title','company','department')
            AND c.invalid_at IS NULL AND (c.value #>> '{}') ILIKE '%'||p_keyword||'%'))
    ),
    enr AS (
      SELECT m.id,
        (SELECT max(o.observed_at) FROM observations o
           WHERE o.entity_id = m.id AND o.method = 'enrichment') AS enriched_at,
        (SELECT c.value #>> '{}' FROM claims c
           WHERE c.entity_id = m.id AND c.property = 'reachability_status'
             AND c.invalid_at IS NULL LIMIT 1) AS email_status,
        (SELECT c.value #>> '{}' FROM claims c
           WHERE c.entity_id = m.id AND c.property = 'job_title'
             AND c.invalid_at IS NULL LIMIT 1) AS job_title,
        (SELECT c.value #>> '{}' FROM claims c
           WHERE c.entity_id = m.id AND c.property = 'company'
             AND c.invalid_at IS NULL LIMIT 1) AS company
      FROM matched m
    )
    SELECT jsonb_build_object(
      'total',           (SELECT count(*) FROM enr),
      'never_enriched',  (SELECT count(*) FROM enr WHERE enriched_at IS NULL),
      'stale',           (SELECT count(*) FROM enr WHERE enriched_at IS NOT NULL
                            AND enriched_at < now() - make_interval(days => p_stale_days)),
      'fresh_verified',  (SELECT count(*) FROM enr WHERE enriched_at >= now() - make_interval(days => p_stale_days)
                            AND email_status IS NOT NULL),
      'needs_enrichment',(SELECT count(*) FROM enr WHERE enriched_at IS NULL
                            OR enriched_at < now() - make_interval(days => p_stale_days)),
      'sample', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'entity_id',   s.id,
          'job_title',   s.job_title,
          'company',     s.company,
          'enriched_at', s.enriched_at,
          'email_status', s.email_status))
        FROM (SELECT * FROM enr ORDER BY enriched_at ASC NULLS FIRST LIMIT p_limit) s
      ), '[]'::jsonb)
    );
  $$;


--
-- Name: recalculate_all_completion_rates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_all_completion_rates() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_doc RECORD;
  v_total_pages INTEGER;
  v_first_session_id TEXT;
  v_highest_page_first_session INTEGER;
  v_new_completion_rate INTEGER;
  v_existing_completion_rate INTEGER;
BEGIN
  -- Loop through all documents that have analytics events
  FOR v_doc IN 
    SELECT DISTINCT document_id 
    FROM document_analytics_events
  LOOP
    -- Get total pages for document (count page_break blocks + 1)
    SELECT (SELECT COUNT(*) FROM jsonb_array_elements(d.document_blocks) AS block WHERE (block->>'block_type') = 'page_break') + 1
    INTO v_total_pages
    FROM documents d
    WHERE d.id = v_doc.document_id;
    
    -- If total_pages calculation failed, use a simple heuristic
    IF v_total_pages IS NULL OR v_total_pages = 0 THEN
      SELECT COALESCE(MAX(page_number), 1) INTO v_total_pages
      FROM document_analytics_events
      WHERE document_id = v_doc.document_id AND event_type = 'viewed';
      
      IF v_total_pages IS NULL OR v_total_pages = 0 THEN
        v_total_pages := 1;
      END IF;
    END IF;
    
    -- Find the first session (earliest 'opened' event)
    SELECT session_id
    INTO v_first_session_id
    FROM document_analytics_events
    WHERE document_id = v_doc.document_id 
      AND event_type = 'opened'
    ORDER BY created_at ASC
    LIMIT 1;
    
    -- If we have a first session, get the highest page viewed in that session
    IF v_first_session_id IS NOT NULL THEN
      SELECT COALESCE(MAX(page_number), 0)
      INTO v_highest_page_first_session
      FROM document_analytics_events
      WHERE document_id = v_doc.document_id 
        AND session_id = v_first_session_id
        AND event_type = 'viewed'
        AND page_number IS NOT NULL;
      
      -- Calculate completion rate: (highest_page / total_pages) * 100
      IF v_highest_page_first_session > 0 AND v_total_pages > 0 THEN
        v_new_completion_rate := ROUND((v_highest_page_first_session::DECIMAL / v_total_pages::DECIMAL) * 100);
        IF v_new_completion_rate > 100 THEN
          v_new_completion_rate := 100;
        END IF;
      ELSE
        v_new_completion_rate := 0;
      END IF;
    ELSE
      v_new_completion_rate := 0;
    END IF;
    
    -- Get existing completion rate
    SELECT COALESCE(completion_rate, 0)
    INTO v_existing_completion_rate
    FROM document_analytics
    WHERE document_id = v_doc.document_id;
    
    -- Only update if new rate is higher (never decrease)
    IF v_new_completion_rate > v_existing_completion_rate THEN
      UPDATE document_analytics
      SET completion_rate = v_new_completion_rate,
          updated_at = NOW()
      WHERE document_id = v_doc.document_id;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: reject_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  DECLARE probe observations%ROWTYPE;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'observations are append-only — DELETE is not permitted';
    END IF;
    probe := NEW; probe.embedding := OLD.embedding;
    IF ROW(probe.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'observations are append-only — only the embedding index may change';
    END IF;
    RETURN NEW;
  END; $$;


--
-- Name: search_claims(uuid, public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_claims(p_workspace_id uuid, p_embedding public.vector, p_threshold double precision, p_limit integer) RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, confidence real, freshness text, similarity double precision)
    LANGUAGE plpgsql STABLE
    AS $$ 
  DECLARE v vector(1536) := p_embedding;   -- clean typed param → index-usable
  BEGIN
    RETURN QUERY
    SELECT t.id, t.entity_id, t.property, t.value, t.confidence, t.freshness, t.similarity
    FROM (
      SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness,
             (1 - (c.embedding <=> v))::FLOAT AS similarity
      FROM claims c
      WHERE c.workspace_id = p_workspace_id AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> v
      LIMIT p_limit   
    ) t
    WHERE t.similarity >= p_threshold
    ORDER BY t.similarity DESC;
  END $$;


--
-- Name: search_claims(uuid, public.vector, double precision, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_claims(p_workspace_id uuid, p_embedding public.vector, p_threshold double precision, p_limit integer, p_property_prefix text DEFAULT NULL::text) RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, confidence real, freshness text, valid_from timestamp with time zone, similarity double precision)
    LANGUAGE plpgsql STABLE
    AS $$
  DECLARE v vector(1536) := p_embedding;
  BEGIN
    RETURN QUERY
    SELECT t.id, t.entity_id, t.property, t.value, t.confidence, t.freshness, t.valid_from, t.similarity
    FROM (
      SELECT c.id, c.entity_id, c.property, c.value, c.confidence, c.freshness, c.valid_from,
             (1 - (c.embedding <=> v))::FLOAT AS similarity
      FROM claims c
      WHERE c.workspace_id = p_workspace_id
        AND c.embedding IS NOT NULL
        AND c.invalid_at IS NULL                                  -- never resurface soft-deleted/purged/deduped facts
        AND (p_property_prefix IS NULL OR c.property LIKE p_property_prefix || '%')
      ORDER BY c.embedding <=> v
      LIMIT p_limit
    ) t
    WHERE t.similarity >= p_threshold
    ORDER BY t.similarity DESC;
  END $$;


--
-- Name: search_observations(uuid, public.vector, text, text, text, timestamp with time zone, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_observations(p_workspace_id uuid, p_embedding public.vector, p_kind text DEFAULT NULL::text, p_property_prefix text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, entity_id uuid, property text, value jsonb, source text, observed_at timestamp with time zone, similarity double precision)
    LANGUAGE plpgsql STABLE
    AS $$
  DECLARE v vector(1536) := p_embedding;
  BEGIN
    RETURN QUERY
    SELECT o.id, o.entity_id, o.property, o.value, o.source, o.observed_at,
           (1 - (o.embedding <=> v))::FLOAT
    FROM observations o
    WHERE o.workspace_id = p_workspace_id AND o.embedding IS NOT NULL
      AND (p_kind            IS NULL OR o.kind = p_kind)
      AND (p_property_prefix IS NULL OR o.property ILIKE p_property_prefix || '%')
      AND (p_source          IS NULL OR o.source = p_source)
      AND (p_since           IS NULL OR o.observed_at >= p_since)
    ORDER BY o.embedding <=> v
    LIMIT p_limit;
  END $$;


--
-- Name: set_contact_pipeline_stage(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_contact_pipeline_stage(p_contact_id uuid, p_stage text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
  UPDATE contacts
  SET pipeline_stage            = p_stage,
      pipeline_stage_updated_at = now(),
      pipeline_stage_source     = 'manual'
  WHERE id = p_contact_id
    AND p_stage IN ('identified','aware','interested','evaluating','client');
$$;


--
-- Name: sync_subscription_plan_name(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_subscription_plan_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN NEW.plan_name := NEW.plan_id; NEW.updated_at := now(); RETURN NEW; END
  $$;


--
-- Name: team_active_accounts(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_active_accounts(ws_ids uuid[]) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
  WITH interacted AS (
    SELECT DISTINCT o.entity_id
    FROM observations o
    WHERE o.workspace_id = ANY(ws_ids)
      AND o.kind = 'event'
      AND o.property = ANY(active_account_interaction_properties())
  ),
  live AS (
    SELECT i.entity_id, e.type
    FROM interacted i
    JOIN entities e ON e.id = i.entity_id
    WHERE e.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM claims c
        WHERE c.entity_id = i.entity_id
          AND c.property = 'is_internal'
          AND c.value = 'true'::jsonb
          AND c.invalid_at IS NULL
      )
  ),
  accounts AS (
    SELECT COALESCE(ct.company_id, l.entity_id) AS account_id
    FROM live l
    LEFT JOIN contacts ct ON ct.id = l.entity_id AND l.type = 'person'
  )
  SELECT COUNT(DISTINCT account_id) FROM accounts;
$$;


--
-- Name: team_ops_breakdown(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_ops_breakdown(p_team_id uuid, p_since timestamp with time zone) RETURNS TABLE(event_type text, calls bigint, ops bigint)
    LANGUAGE sql STABLE
    AS $$
    SELECT wsl.event_type,
           COUNT(*)::bigint                          AS calls,
           COALESCE(SUM(wsl.billable_ops), 0)::bigint AS ops
    FROM workspace_system_log wsl
    JOIN workspaces w ON w.id = wsl.workspace_id
    WHERE w.team_id = p_team_id
      AND wsl.occurred_at >= p_since
    GROUP BY wsl.event_type;
  $$;


--
-- Name: team_ops_used(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.team_ops_used(p_team_id uuid, p_since timestamp with time zone) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(SUM(wsl.billable_ops), 0)::bigint
    FROM workspace_system_log wsl
    JOIN workspaces w ON w.id = wsl.workspace_id
    WHERE w.team_id = p_team_id AND wsl.billable_ops > 0 AND wsl.occurred_at >= p_since;
  $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


--
-- Name: trigger_recompute_pipeline_stage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_recompute_pipeline_stage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_new_stage  TEXT;
  v_cur_stage  TEXT;
  v_cur_source TEXT;
BEGIN
  IF NEW.activity_type IN ('airtable_imported','airtable_synced','airtable_pushed','contact_created') THEN
    RETURN NEW;
  END IF;

  IF NEW.occurred_at > now() THEN
    RETURN NEW;
  END IF;

  SELECT pipeline_stage, pipeline_stage_source
  INTO v_cur_stage, v_cur_source
  FROM contacts WHERE id = NEW.contact_id;

  IF v_cur_stage = 'client' THEN
    RETURN NEW;
  END IF;

  v_new_stage := compute_contact_pipeline_stage(NEW.contact_id);

  IF v_cur_source = 'auto'
     OR (v_cur_source = 'manual' AND v_new_stage = 'client')
     OR (v_cur_source = 'manual' AND (
           (v_new_stage = 'evaluating' AND v_cur_stage IN ('identified','aware','interested'))
        OR (v_new_stage = 'interested' AND v_cur_stage IN ('identified','aware'))
        OR (v_new_stage = 'aware'      AND v_cur_stage = 'identified')
     ))
  THEN
    UPDATE contacts SET
      pipeline_stage            = v_new_stage,
      pipeline_stage_updated_at = now(),
      pipeline_stage_source     = 'auto',
      last_activity_at          = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.contact_id;
  ELSE
    UPDATE contacts SET
      last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at)
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: update_api_resources_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_api_resources_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_background_inspirations_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_background_inspirations_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_blog_articles_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_blog_articles_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_community_post_comment_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_community_post_comment_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE community_posts
    SET comment_count = comment_count + 1, updated_at = now()
    WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE community_posts
    SET comment_count = GREATEST(0, comment_count - 1), updated_at = now()
    WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: update_community_post_status_changed_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_community_post_status_changed_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.status_changed_at = now();
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_community_post_upvote_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_community_post_upvote_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE community_posts
    SET upvote_count = upvote_count + 1, updated_at = now()
    WHERE id = NEW.post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE community_posts
    SET upvote_count = GREATEST(0, upvote_count - 1), updated_at = now()
    WHERE id = OLD.post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: update_companies_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_companies_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;


--
-- Name: update_company_assets_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_company_assets_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_contact_integrations_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_contact_integrations_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_contact_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_contact_stats() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE contacts SET
      total_documents_count = total_documents_count + 1,
      incoming_contacts_count = incoming_contacts_count + 1,
      last_document_at = NOW(),
      last_activity_at = NOW(),
      updated_at = NOW()
    WHERE id = NEW.contact_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE contacts SET
      total_documents_count = GREATEST(0, total_documents_count - 1),
      updated_at = NOW()
    WHERE id = OLD.contact_id;
    RETURN OLD;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_contacts_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_contacts_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_content_chat_context_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_content_chat_context_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_content_generation_jobs_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_content_generation_jobs_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_content_output_settings_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_content_output_settings_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_document_analytics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_document_analytics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_doc_id UUID;
  v_total_views INTEGER;
  v_unique_viewers INTEGER;
  v_avg_time INTEGER;
  v_avg_pages DECIMAL;
  v_completion_rate INTEGER;
  v_last_viewed TIMESTAMP WITH TIME ZONE;
  v_total_pages INTEGER;
  v_first_session_id TEXT;
  v_highest_page_first_session INTEGER;
  v_new_completion_rate INTEGER;
  v_existing_completion_rate INTEGER;
BEGIN
  v_doc_id := NEW.document_id;
  
  -- Calculate aggregates
  SELECT 
    COUNT(DISTINCT CASE WHEN event_type = 'opened' THEN session_id END),
    COUNT(DISTINCT session_id),
    COALESCE(AVG(CASE WHEN event_type = 'closed' THEN time_spent_seconds END)::INTEGER, 0),
    COALESCE(AVG(CASE WHEN event_type = 'viewed' THEN page_number END), 0),
    MAX(created_at)
  INTO v_total_views, v_unique_viewers, v_avg_time, v_avg_pages, v_last_viewed
  FROM document_analytics_events
  WHERE document_id = v_doc_id;
  
  -- Get total pages for document (count page_break blocks + 1)
  SELECT (SELECT COUNT(*) FROM jsonb_array_elements(d.document_blocks) AS block WHERE (block->>'block_type') = 'page_break') + 1
  INTO v_total_pages
  FROM documents d
  WHERE d.id = v_doc_id;
  
  -- If total_pages calculation failed, use a simple heuristic
  IF v_total_pages IS NULL OR v_total_pages = 0 THEN
    SELECT COALESCE(MAX(page_number), 1) INTO v_total_pages
    FROM document_analytics_events
    WHERE document_id = v_doc_id AND event_type = 'viewed';
    
    -- If still null, default to 1
    IF v_total_pages IS NULL OR v_total_pages = 0 THEN
      v_total_pages := 1;
    END IF;
  END IF;
  
  -- Find the first session (earliest 'opened' event)
  SELECT session_id
  INTO v_first_session_id
  FROM document_analytics_events
  WHERE document_id = v_doc_id 
    AND event_type = 'opened'
  ORDER BY created_at ASC
  LIMIT 1;
  
  -- If we have a first session, get the highest page viewed in that session
  IF v_first_session_id IS NOT NULL THEN
    SELECT COALESCE(MAX(page_number), 0)
    INTO v_highest_page_first_session
    FROM document_analytics_events
    WHERE document_id = v_doc_id 
      AND session_id = v_first_session_id
      AND event_type = 'viewed'
      AND page_number IS NOT NULL;
    
    -- Calculate completion rate: (highest_page / total_pages) * 100
    IF v_highest_page_first_session > 0 AND v_total_pages > 0 THEN
      v_new_completion_rate := ROUND((v_highest_page_first_session::DECIMAL / v_total_pages::DECIMAL) * 100);
      -- Ensure it doesn't exceed 100%
      IF v_new_completion_rate > 100 THEN
        v_new_completion_rate := 100;
      END IF;
    ELSE
      v_new_completion_rate := 0;
    END IF;
  ELSE
    -- No first session yet, completion rate is 0
    v_new_completion_rate := 0;
  END IF;
  
  -- Get existing completion rate to ensure we never decrease it
  SELECT COALESCE(completion_rate, 0)
  INTO v_existing_completion_rate
  FROM document_analytics
  WHERE document_id = v_doc_id;
  
  -- Only use new completion rate if it's higher than existing (never decrease)
  IF v_new_completion_rate > v_existing_completion_rate THEN
    v_completion_rate := v_new_completion_rate;
  ELSE
    v_completion_rate := v_existing_completion_rate;
  END IF;
  
  -- Insert or update document analytics
  INSERT INTO document_analytics (
    document_id,
    total_views,
    unique_viewers,
    average_time_spent_seconds,
    average_pages_viewed,
    completion_rate,
    last_viewed_at,
    updated_at
  )
  VALUES (
    v_doc_id,
    v_total_views,
    v_unique_viewers,
    v_avg_time,
    v_avg_pages,
    v_completion_rate,
    v_last_viewed,
    NOW()
  )
  ON CONFLICT (document_id) DO UPDATE SET
    total_views = EXCLUDED.total_views,
    unique_viewers = EXCLUDED.unique_viewers,
    average_time_spent_seconds = EXCLUDED.average_time_spent_seconds,
    average_pages_viewed = EXCLUDED.average_pages_viewed,
    completion_rate = GREATEST(document_analytics.completion_rate, EXCLUDED.completion_rate), -- Never decrease
    last_viewed_at = EXCLUDED.last_viewed_at,
    updated_at = NOW();
  
  -- Update template analytics
  UPDATE template_analytics ta
  SET 
    total_documents_created = (
      SELECT COUNT(*) FROM documents WHERE template_id = ta.template_id
    ),
    total_views = (
      SELECT COALESCE(SUM(da.total_views), 0)
      FROM documents d
      LEFT JOIN document_analytics da ON da.document_id = d.id
      WHERE d.template_id = ta.template_id
    ),
    average_view_time_seconds = (
      SELECT COALESCE(AVG(da.average_time_spent_seconds)::INTEGER, 0)
      FROM documents d
      LEFT JOIN document_analytics da ON da.document_id = d.id
      WHERE d.template_id = ta.template_id AND da.average_time_spent_seconds > 0
    ),
    average_completion_rate = (
      SELECT COALESCE(AVG(da.completion_rate)::INTEGER, 0)
      FROM documents d
      LEFT JOIN document_analytics da ON da.document_id = d.id
      WHERE d.template_id = ta.template_id AND da.completion_rate > 0
    ),
    updated_at = NOW()
  WHERE template_id = (
    SELECT template_id FROM documents WHERE id = v_doc_id
  );
  
  RETURN NEW;
END;
$$;


--
-- Name: update_document_quality_logs_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_document_quality_logs_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_document_type_knowledge_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_document_type_knowledge_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$                                                                                                                                                                                                       
  BEGIN                                                                                                                                                                                                                       
    NEW.updated_at = NOW();                                                                                                                                                                                                   
    RETURN NEW;                                                                                                                                                                                                               
  END;                                                                                                                                                                                                                        
  $$;


--
-- Name: update_documents_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_documents_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_form_submission_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_form_submission_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE forms
    SET submission_count = submission_count + 1,
        last_submission_at = NEW.submitted_at
    WHERE id = NEW.form_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE forms
    SET submission_count = GREATEST(0, submission_count - 1)
    WHERE id = OLD.form_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: update_forms_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_forms_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_free_tool_session_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_free_tool_session_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_kb_vector_store_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_kb_vector_store_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_legal_templates_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_legal_templates_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_report_design_settings_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_report_design_settings_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_template_signed_workflows_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_template_signed_workflows_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_visual_template_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_visual_template_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: update_workflow_connections_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_workflow_connections_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_workflow_metrics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_workflow_metrics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.status = 'completed' OR NEW.status = 'failed' THEN
    UPDATE workflows
    SET
      total_runs = total_runs + 1,
      successful_runs = CASE WHEN NEW.status = 'completed' THEN successful_runs + 1 ELSE successful_runs END,
      failed_runs = CASE WHEN NEW.status = 'failed' THEN failed_runs + 1 ELSE failed_runs END,
      last_run_at = NEW.completed_at
    WHERE id = NEW.workflow_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: update_workflow_providers_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_workflow_providers_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_workflows_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_workflows_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_workspace_workflow_templates_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_workspace_workflow_templates_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: user_owns_template(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_owns_template(p_template_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$                                                                                                                                                                                                       
    SELECT EXISTS (                                                                                                                                                                                           
      SELECT 1 FROM templates t                                                                                                                                                                               
      INNER JOIN workspace_members wm ON wm.workspace_id = t.workspace_id                                                                                                                                     
      WHERE t.id = p_template_id                                                                                                                                                                              
      AND wm.user_id = auth.uid()                                                                                                                                                                             
    );                                                                                                                                                                                                        
  $$;


--
-- Name: workspace_ops_stats(uuid, timestamp with time zone, text[], text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_ops_stats(p_workspace_id uuid, p_since timestamp with time zone, p_retrieval text[], p_agent_sources text[], p_billed_only boolean DEFAULT false) RETURNS TABLE(all_time bigint, in_range bigint, failed bigint, agent bigint, system bigint)
    LANGUAGE sql STABLE
    AS $$
    WITH scoped AS (
      SELECT wsl.source, wsl.event_type, wsl.summary
      FROM workspace_system_log wsl
      WHERE wsl.workspace_id = p_workspace_id
        AND (p_since IS NULL OR wsl.occurred_at >= p_since)
        AND (NOT p_billed_only OR wsl.event_type = ANY(p_retrieval))
    )
    SELECT
      workspace_ops_used(p_workspace_id, '1970-01-01'::timestamptz)
        + (SELECT COUNT(*) FROM memory_ops_log m WHERE m.workspace_id = p_workspace_id),
      (SELECT COUNT(*) FROM scoped),
      (SELECT COUNT(*) FROM scoped s
         WHERE s.summary    ~* '(fail|error|denied|rejected|exception|invalid|unauthorized)'
            OR s.event_type ~* '(fail|error|denied|rejected|exception|invalid|unauthorized)'),
      (SELECT COUNT(*) FROM scoped s WHERE s.source = ANY(p_agent_sources)),
      (SELECT COUNT(*) FROM scoped s WHERE NOT (s.source = ANY(p_agent_sources)));
  $$;


--
-- Name: workspace_ops_used(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_ops_used(p_workspace_id uuid, p_since timestamp with time zone) RETURNS bigint
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(SUM(wsl.billable_ops), 0)::bigint
    FROM workspace_system_log wsl
    WHERE wsl.workspace_id = p_workspace_id
      AND wsl.billable_ops > 0
      AND wsl.occurred_at >= p_since;
  $$;


--
-- Name: agent_routine_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_routine_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    routine_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    dedupe_key text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    thread_id uuid,
    entity_id uuid,
    error text,
    seen_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT agent_routine_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text])))
);


--
-- Name: agent_routines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_routines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    prompt text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    trigger_kind text NOT NULL,
    frequency text,
    at_time time without time zone,
    day_of_week smallint,
    day_of_month smallint,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    offset_minutes integer,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_routines_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28))),
    CONSTRAINT agent_routines_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT agent_routines_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'quarterly'::text]))),
    CONSTRAINT agent_routines_trigger_kind_check CHECK ((trigger_kind = ANY (ARRAY['clock'::text, 'before_meeting'::text]))),
    CONSTRAINT routine_shape CHECK ((((trigger_kind = 'clock'::text) AND (frequency IS NOT NULL) AND (at_time IS NOT NULL) AND (offset_minutes IS NULL)) OR ((trigger_kind = 'before_meeting'::text) AND (offset_minutes IS NOT NULL) AND (frequency IS NULL))))
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    created_by_user_id uuid,
    owner_user_id uuid,
    scope text,
    CONSTRAINT api_keys_scope_check CHECK ((scope = ANY (ARRAY['member'::text, 'admin'::text])))
);


--
-- Name: blog_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_articles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    slug text NOT NULL,
    meta_description text,
    cover_image_url text,
    content jsonb DEFAULT '{}'::jsonb,
    status text DEFAULT 'draft'::text NOT NULL,
    featured boolean DEFAULT false,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    created_by_user_id uuid,
    is_guide boolean DEFAULT false,
    article_type text DEFAULT 'article'::text,
    video_url text,
    intro_text text,
    related_workflow_slugs text[] DEFAULT ARRAY[]::text[],
    category text DEFAULT 'blog'::text NOT NULL,
    CONSTRAINT blog_articles_article_type_check CHECK ((article_type = ANY (ARRAY['article'::text, 'announcement'::text]))),
    CONSTRAINT blog_articles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: TABLE blog_articles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.blog_articles IS 'Blog articles table for CMS. Stores article metadata and rich content from Tiptap editor.';


--
-- Name: COLUMN blog_articles.slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blog_articles.slug IS 'URL-friendly identifier for articles. Must be unique. Used in public URLs like /insights/:slug.';


--
-- Name: COLUMN blog_articles.content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blog_articles.content IS 'Rich content stored as JSONB in Tiptap format. Contains structured content with blocks, formatting, and embedded media.';


--
-- Name: COLUMN blog_articles.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blog_articles.status IS 'Article status: "draft" (not publicly visible) or "published" (publicly visible).';


--
-- Name: COLUMN blog_articles.is_guide; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blog_articles.is_guide IS 'If true, this article will appear in the guides section of the resources page';


--
-- Name: COLUMN blog_articles.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blog_articles.category IS 'Coffee Shop hub category: get-started | gtm | ai-sdr | skills | guides | blog';


--
-- Name: campaign_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider text DEFAULT 'unknown'::text NOT NULL,
    campaign_id text NOT NULL,
    campaign_name text,
    step text DEFAULT ''::text NOT NULL,
    variant text DEFAULT ''::text NOT NULL,
    subject text,
    body text,
    source text DEFAULT 'webhook'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: changelog_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.changelog_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    image_url text,
    tag text DEFAULT 'feature'::text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT changelog_entries_tag_check CHECK ((tag = ANY (ARRAY['feature'::text, 'improvement'::text, 'fix'::text, 'announcement'::text])))
);


--
-- Name: claim_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.claim_jobs (
    id bigint NOT NULL,
    workspace_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    property text NOT NULL,
    enqueued_at timestamp with time zone DEFAULT now() NOT NULL,
    picked_at timestamp with time zone
);


--
-- Name: claim_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.claim_jobs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.claim_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cli_auth_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cli_auth_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_code text NOT NULL,
    user_code text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    workspace_id uuid,
    api_key_id uuid,
    raw_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: companies; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.companies AS
 SELECT id,
    workspace_id,
    created_at,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'domain'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS domain,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'hubspot_company'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS hubspot_company_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'apollo_account'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS apollo_account_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'pipedrive_org'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS pipedrive_org_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'attio_company'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS attio_company_id,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'name'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS name,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'industry'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS industry,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'employee_count'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS employee_count,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'location'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS location,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'revenue_range'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS revenue_range,
    ( SELECT
                CASE
                    WHEN (jsonb_typeof(claims.value) = 'array'::text) THEN ARRAY( SELECT jsonb_array_elements_text(claims.value) AS jsonb_array_elements_text)
                    ELSE NULL::text[]
                END AS "case"
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'tech_stack'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS tech_stack,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'enrichment_status'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS enrichment_status,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'enriched_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS enriched_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'icp_score'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS icp_score,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'icp_fit'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::boolean AS icp_fit,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'icp_reasoning'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS icp_reasoning,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'icp_scored_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS icp_scored_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_score'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS deal_health_score,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_computed_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS deal_health_computed_at,
    ( SELECT max(observations.observed_at) AS max
           FROM public.observations
          WHERE ((observations.entity_id = e.id) AND (observations.kind = 'event'::text) AND (observations.observed_at <= now()))) AS last_activity_at,
    ( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'apollo_raw'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS apollo_raw,
    COALESCE(( SELECT max(claims.computed_at) AS max
           FROM public.claims
          WHERE (claims.entity_id = e.id)), created_at) AS updated_at
   FROM public.entities e
  WHERE ((type = 'company'::text) AND (status = 'active'::text));


--
-- Name: predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.predictions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    kind text NOT NULL,
    predicted_value jsonb NOT NULL,
    predicted_confidence real NOT NULL,
    feature_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_version text,
    predicted_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome_value jsonb,
    outcome_observation_id uuid,
    resolved_at timestamp with time zone,
    resolution_window_days integer DEFAULT 30 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fired_signals jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    from_entity_id uuid NOT NULL,
    to_entity_id uuid NOT NULL,
    type text NOT NULL,
    confidence real DEFAULT 1.0 NOT NULL,
    valid_from timestamp with time zone,
    valid_to timestamp with time zone,
    supporting_observation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contacts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.contacts AS
 SELECT id,
    workspace_id,
    created_at,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'email'::text) AND (entity_identifiers.status = 'active'::text))
          ORDER BY entity_identifiers.first_seen_at
         LIMIT 1) AS email,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'linkedin_url'::text) AND (entity_identifiers.status = 'active'::text))
          ORDER BY entity_identifiers.first_seen_at
         LIMIT 1) AS linkedin_url,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'linkedin_member_id'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS linkedin_member_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'hubspot'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS hubspot_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'pipedrive'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS pipedrive_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'apollo'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS apollo_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'rb2b'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS rb2b_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'attio'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS attio_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'salesforce'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS salesforce_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'crm'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS crm_record_id,
    ( SELECT entity_identifiers.value
           FROM public.entity_identifiers
          WHERE ((entity_identifiers.entity_id = e.id) AND (entity_identifiers.kind = 'stripe'::text) AND (entity_identifiers.status = 'active'::text))
         LIMIT 1) AS stripe_customer_id,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'first_name'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS first_name,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'last_name'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS last_name,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'job_title'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS job_title,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'seniority'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS seniority,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'department'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS department,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'city'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS city,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'country'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS country,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'phone'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS phone,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'company'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS company,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'photo_url'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS photo_url,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'domain'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS domain,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'industry'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS industry,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'company_size'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS company_size,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'connection_strength'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS connection_strength,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'pipeline_stage'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS pipeline_stage,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'pipeline_stage_source'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS pipeline_stage_source,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'pipeline_stage_updated_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS pipeline_stage_updated_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'source'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS source,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'source_tag'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS source_tag,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'status'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS status,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'lead_source'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS lead_source,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'first_seen_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS first_seen_at,
    ( SELECT max(observations.observed_at) AS max
           FROM public.observations
          WHERE ((observations.entity_id = e.id) AND (observations.kind = 'event'::text) AND (observations.observed_at <= now()) AND (observations.property <> ALL (ARRAY['interaction.enrichment_run'::text, 'interaction.enrichment_completed'::text, 'interaction.score_updated'::text, '
  interaction.stage_changed'::text, 'interaction.contact_created'::text, 'interaction.contact_updated'::text])))) AS last_activity_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'last_interaction_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS last_interaction_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'last_document_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS last_document_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_score'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS deal_health_score,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_active_max'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS deal_health_active_max,
    ( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_breakdown'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS deal_health_breakdown,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_health_computed_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS deal_health_computed_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_stage'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS deal_stage,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_value'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::numeric AS deal_value,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_closed_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS deal_closed_at,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'deal_sent_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS deal_sent_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'enrichment_status'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS enrichment_status,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'enrichment_source'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS enrichment_source,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'enriched_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS enriched_at,
    (( SELECT (predictions.predicted_value ->> 'score'::text)
           FROM public.predictions
          WHERE ((predictions.entity_id = e.id) AND (predictions.kind = 'icp_fit'::text))
          ORDER BY predictions.predicted_at DESC
         LIMIT 1))::integer AS icp_score,
    (( SELECT (predictions.predicted_value ->> 'fit'::text)
           FROM public.predictions
          WHERE ((predictions.entity_id = e.id) AND (predictions.kind = 'icp_fit'::text))
          ORDER BY predictions.predicted_at DESC
         LIMIT 1))::boolean AS icp_fit,
    ( SELECT (predictions.predicted_value ->> 'reason'::text)
           FROM public.predictions
          WHERE ((predictions.entity_id = e.id) AND (predictions.kind = 'icp_fit'::text))
          ORDER BY predictions.predicted_at DESC
         LIMIT 1) AS icp_reasoning,
    ( SELECT predictions.predicted_at
           FROM public.predictions
          WHERE ((predictions.entity_id = e.id) AND (predictions.kind = 'icp_fit'::text))
          ORDER BY predictions.predicted_at DESC
         LIMIT 1) AS icp_scored_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'memory_summary'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS memory_summary,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'summary_generated_at'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::timestamp with time zone AS summary_generated_at,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'notes'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS notes,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'keywords'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS keywords,
    ( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'channels'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS channels,
    ( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'tags'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS tags,
    ( SELECT claims.value
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'apollo_raw'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS apollo_raw,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'interaction_count'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS interaction_count,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'incoming_contacts_count'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS incoming_contacts_count,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'total_documents_count'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::integer AS total_documents_count,
    (( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'total_income'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1))::numeric AS total_income,
    ( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'total_income_source'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1) AS total_income_source,
    ( SELECT relationships.to_entity_id
           FROM public.relationships
          WHERE ((relationships.from_entity_id = e.id) AND (relationships.type = 'works_at'::text) AND (relationships.valid_to IS NULL))
         LIMIT 1) AS company_id,
    NULL::uuid AS created_by,
    COALESCE(( SELECT max(claims.computed_at) AS max
           FROM public.claims
          WHERE (claims.entity_id = e.id)), created_at) AS updated_at
   FROM public.entities e
  WHERE ((type = 'person'::text) AND (status = 'active'::text) AND ((EXISTS ( SELECT 1
           FROM public.observations o
          WHERE ((o.entity_id = e.id) AND (o.kind = 'event'::text) AND ((o.property = ANY (ARRAY['interaction.reply'::text, 'interaction.email_reply'::text, 'interaction.email_replied'::text, 'interaction.email_received'::text, 'interaction.outbound_positive_reply'::text, 'interaction.linkedin_message_received'::text, 'interaction.meeting_held'::text, 'interaction.meeting_scheduled'::text, 'interaction.call'::text, 'interaction.call_held'::text, 'interaction.deal_won'::text, 'interaction.deal_lost'::text, 'interaction.deal_disqualified'::text, 'interaction.proposal_sent'::text, 'interaction.proposal_signed'::text, 'interaction.payment_received'::text, 'interaction.subscription_started'::text, 'interaction.subscription_updated'::text, 'interaction.subscription_canceled'::text, 'interaction.signed_up'::text])) OR ((o.property = 'interaction.linkedin_message'::text) AND (COALESCE(((o.raw ->> 'is_outbound'::text))::boolean, false) = false)))))) OR (EXISTS ( SELECT 1
           FROM public.entity_identifiers ei
          WHERE ((ei.entity_id = e.id) AND (ei.status = 'active'::text) AND (ei.kind = ANY (ARRAY['hubspot'::text, 'salesforce'::text, 'pipedrive'::text, 'attio'::text, 'crm'::text, 'stripe'::text]))))) OR (COALESCE(( SELECT (claims.value #>> '{}'::text[])
           FROM public.claims
          WHERE ((claims.entity_id = e.id) AND (claims.property = 'pipeline_stage'::text) AND (claims.invalid_at IS NULL))
         LIMIT 1), 'identified'::text) <> ALL (ARRAY['identified'::text, 'aware'::text, 'cold'::text, 'engaged'::text, 'connected'::text])) OR (EXISTS ( SELECT 1
           FROM public.observations o
          WHERE ((o.entity_id = e.id) AND (o.source = 'manual'::text))))));


--
-- Name: crm_hygiene_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_hygiene_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    run_id uuid,
    provider text NOT NULL,
    entity_id uuid,
    crm_record_id text,
    kind text NOT NULL,
    field text,
    current_value jsonb,
    proposed_value jsonb,
    evidence jsonb,
    confidence numeric,
    reason text,
    status text DEFAULT 'proposed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_hygiene_kind_chk CHECK ((kind = ANY (ARRAY['field_fill'::text, 'field_update'::text, 'conflict'::text, 'net_new'::text, 'icp_rescore'::text, 'milestone_sync'::text]))),
    CONSTRAINT crm_hygiene_status_chk CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'applied'::text, 'dismissed'::text, 'failed'::text])))
);


--
-- Name: crm_sync_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sync_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider text NOT NULL,
    auto_sync boolean DEFAULT false,
    last_synced_at timestamp with time zone,
    contacts_synced integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    push_activities boolean DEFAULT true,
    create_in_crm boolean DEFAULT true NOT NULL,
    create_trigger text DEFAULT 'positive_reply_or_meeting'::text NOT NULL,
    create_require_icp_fit boolean DEFAULT true NOT NULL,
    create_icp_threshold integer DEFAULT 70 NOT NULL,
    hygiene_enabled boolean DEFAULT true NOT NULL,
    hygiene_cadence text DEFAULT 'weekly'::text NOT NULL,
    hygiene_last_run_at timestamp with time zone,
    hygiene_auto_apply text DEFAULT 'off'::text NOT NULL,
    CONSTRAINT crm_sync_configs_create_trigger_chk CHECK ((create_trigger = ANY (ARRAY['any_reply_or_meeting'::text, 'positive_reply_or_meeting'::text, 'meeting_only'::text, 'interested_stage'::text]))),
    CONSTRAINT crm_sync_configs_hygiene_auto_apply_chk CHECK ((hygiene_auto_apply = ANY (ARRAY['off'::text, 'safe'::text, 'all'::text]))),
    CONSTRAINT crm_sync_configs_hygiene_cadence_chk CHECK ((hygiene_cadence = ANY (ARRAY['weekly'::text, 'monthly'::text])))
);


--
-- Name: lead_bulk_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_bulk_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    lead_list_id uuid NOT NULL,
    kind text NOT NULL,
    provider text,
    status text DEFAULT 'pending'::text NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    processed integer DEFAULT 0 NOT NULL,
    result jsonb,
    lead_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    error text,
    created_by uuid,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT lead_bulk_jobs_kind_check CHECK ((kind = ANY (ARRAY['enrich'::text, 'verify'::text]))),
    CONSTRAINT lead_bulk_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: lead_lists; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.lead_lists AS
 SELECT id,
    workspace_id,
    name,
    source,
    COALESCE((metadata -> 'columns'::text), '[]'::jsonb) AS columns,
    created_at,
    ( SELECT max(ce.added_at) AS max
           FROM public.collection_entities ce
          WHERE (ce.collection_id = c.id)) AS updated_at
   FROM public.collections c
  WHERE (kind = 'list'::text);


--
-- Name: lead_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_suppressions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    id bigint NOT NULL,
    workspace_id uuid,
    user_id uuid,
    feature text NOT NULL,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    cache_creation_tokens integer DEFAULT 0 NOT NULL,
    cache_read_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_usd numeric(12,6) DEFAULT 0 NOT NULL,
    request_id text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: llm_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.llm_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.llm_usage_id_seq OWNED BY public.llm_usage.id;


--
-- Name: memory_ops_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_ops_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    workspace_id uuid,
    op_type text NOT NULL,
    entity_type text,
    created_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'sdk'::text NOT NULL,
    api_key_id uuid
);


--
-- Name: observation_crm_pushes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observation_crm_pushes (
    workspace_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    provider text NOT NULL,
    engagement_id text NOT NULL,
    pushed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbound_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    entity_id uuid,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_status_code integer,
    last_error text,
    dead_lettered_at timestamp with time zone,
    external_id text
);


--
-- Name: pending_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid,
    thread_id uuid,
    kind text NOT NULL,
    entity_id uuid,
    recipient text,
    linkedin_url text,
    body text NOT NULL,
    rationale text,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT pending_actions_kind_check CHECK ((kind = ANY (ARRAY['linkedin_message'::text, 'linkedin_invite'::text]))),
    CONSTRAINT pending_actions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'rejected'::text, 'failed'::text])))
);


--
-- Name: playbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playbooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body_md text DEFAULT ''::text NOT NULL,
    source text DEFAULT 'nous'::text NOT NULL,
    file_path text,
    version integer DEFAULT 1 NOT NULL,
    synced_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text,
    CONSTRAINT playbooks_kind_check CHECK ((kind = ANY (ARRAY['voice'::text, 'outreach'::text, 'icp'::text, 'positioning'::text]))),
    CONSTRAINT playbooks_source_check CHECK ((source = ANY (ARRAY['nous'::text, 'claude_code'::text])))
);


--
-- Name: playground_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playground_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    tool_calls jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playground_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: playground_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.playground_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    lead_list_id uuid,
    provider text,
    campaign_id text,
    title text NOT NULL,
    period_from timestamp with time zone,
    period_to timestamp with time zone,
    markdown text NOT NULL,
    metrics_json jsonb,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    type text DEFAULT 'docs'::text NOT NULL,
    description text,
    thumbnail_url text,
    sort_order integer DEFAULT 0 NOT NULL,
    published boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN resources.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.resources.type IS 'repo | video | paper | docs | guide';


--
-- Name: roadmap_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roadmap_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'planned'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roadmap_items_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'shipped'::text])))
);


--
-- Name: scorecard_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scorecard_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    target numeric,
    steps integer DEFAULT 0 NOT NULL,
    gap_before numeric,
    gap_after numeric,
    signal_count integer,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scorecard_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scorecard_signals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    weight integer DEFAULT 0 NOT NULL,
    rule jsonb DEFAULT '{}'::jsonb NOT NULL,
    coverage integer DEFAULT 0 NOT NULL,
    added_in uuid,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: signup_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signup_stats (
    stat_key text NOT NULL,
    stat_value integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: skill_downloads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_downloads (
    slug text NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: slack_channel_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_channel_map (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_channel_id text NOT NULL,
    slack_channel_name text,
    account_ref text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    plan_name text DEFAULT 'starter'::text NOT NULL,
    status text DEFAULT 'trial'::text NOT NULL,
    current_period_start timestamp with time zone DEFAULT now(),
    current_period_end timestamp with time zone DEFAULT (now() + '1 mon'::interval),
    trial_ends_at timestamp with time zone,
    stripe_subscription_id text,
    stripe_price_id text,
    stripe_customer_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    lifetime_credits_total integer,
    lifetime_credits_used integer DEFAULT 0,
    plan_id text NOT NULL,
    is_comp boolean DEFAULT false NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    quantity integer DEFAULT 1 NOT NULL
);


--
-- Name: team_accounts_grace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_accounts_grace (
    team_id uuid NOT NULL,
    grace_started_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    email text NOT NULL,
    token text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT valid_role CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text]))),
    CONSTRAINT valid_status CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: TABLE team_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_invitations IS 'Stores team invitation records with unique tokens for email-based invitations';


--
-- Name: COLUMN team_invitations.token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.token IS 'Unique token used in invitation URL (e.g., /accept-invitation?token=xxx)';


--
-- Name: COLUMN team_invitations.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_invitations.expires_at IS 'Invitation expires 7 days after creation by default';


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT valid_role CHECK ((role = ANY (ARRAY['founder'::text, 'owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
);


--
-- Name: TABLE team_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.team_members IS 'Tracks team membership (many-to-many relationship between users and teams)';


--
-- Name: COLUMN team_members.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.team_members.role IS 'User role within the team: owner, admin, member, or viewer';


--
-- Name: team_ops_email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_ops_email_log (
    team_id uuid NOT NULL,
    kind text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_ops_grace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_ops_grace (
    team_id uuid NOT NULL,
    grace_started_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: team_records_grace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_records_grace (
    team_id uuid NOT NULL,
    grace_started_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_customer_id text,
    lifetime_deal_dismissed_at timestamp with time zone,
    ops_balance integer DEFAULT 5000 NOT NULL,
    ops_accounts_limit integer DEFAULT 50 NOT NULL,
    ops_total_purchased integer DEFAULT 0 NOT NULL,
    auto_topup_enabled boolean DEFAULT false NOT NULL,
    auto_topup_threshold integer DEFAULT 1000 NOT NULL,
    auto_topup_pack_id text,
    stripe_payment_method_id text,
    ops_topup_balance bigint DEFAULT 0 NOT NULL
);


--
-- Name: trigger_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trigger_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    events text[] NOT NULL,
    signing_secret text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text,
    team_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    onboarding_completed_at timestamp with time zone,
    use_case text,
    supabase_user_id uuid NOT NULL,
    is_admin boolean DEFAULT false,
    profile_picture_url text,
    company_name text,
    default_signature text,
    default_signature_type text DEFAULT 'type'::text,
    is_vip boolean DEFAULT false,
    website_url text,
    account_setup_completed_at timestamp with time zone,
    referred_by_code text,
    referred_by_affiliate_id uuid,
    how_heard_about_us text,
    acquisition_referral_code text,
    use_cases text[],
    welcome_email_sent_at timestamp with time zone,
    CONSTRAINT users_default_signature_type_check CHECK ((default_signature_type = ANY (ARRAY['draw'::text, 'type'::text, 'upload'::text])))
);


--
-- Name: COLUMN users.onboarding_completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.onboarding_completed_at IS 'Timestamp when user completed onboarding flow';


--
-- Name: COLUMN users.use_case; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.use_case IS 'User-selected use case from onboarding: Personal, Freelancer, Small agency, Medium business, Enterprise';


--
-- Name: COLUMN users.profile_picture_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.profile_picture_url IS 'URL to user profile picture stored in Supabase Storage';


--
-- Name: webhook_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    payload jsonb NOT NULL,
    headers jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: weekly_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.weekly_updates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    week integer NOT NULL,
    title text NOT NULL,
    date text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    yt_title text,
    yt_url text,
    published boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    worker text NOT NULL,
    status text NOT NULL,
    summary text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    duration_ms integer,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_provider_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_provider_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    name text NOT NULL,
    encrypted_credentials jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone,
    is_verified boolean DEFAULT false,
    last_test_at timestamp with time zone,
    mcp_endpoint text,
    mcp_transport text DEFAULT 'streamable_http'::text,
    owner_user_id uuid,
    account_email text
);


--
-- Name: TABLE workflow_provider_connections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.workflow_provider_connections IS 'User workspace connections to providers with encrypted credentials';


--
-- Name: COLUMN workflow_provider_connections.mcp_endpoint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workflow_provider_connections.mcp_endpoint IS 'MCP server endpoint URL for providers using Model Context Protocol';


--
-- Name: COLUMN workflow_provider_connections.mcp_transport; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workflow_provider_connections.mcp_transport IS 'MCP transport type (streamable_http, sse, etc.)';


--
-- Name: workflow_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    logo_url text,
    category text,
    api_docs_url text,
    api_docs_summary jsonb,
    auth_type text,
    auth_fields jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_url text,
    key_hint text,
    webhook_mode text,
    webhook_settings_url text,
    CONSTRAINT workflow_providers_auth_type_check CHECK ((auth_type = ANY (ARRAY['oauth2'::text, 'api_key'::text, 'credentials'::text, 'none'::text]))),
    CONSTRAINT workflow_providers_webhook_mode_check CHECK (((webhook_mode IS NULL) OR (webhook_mode = ANY (ARRAY['auto'::text, 'manual'::text, 'none'::text]))))
);


--
-- Name: TABLE workflow_providers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.workflow_providers IS 'Updated with AI providers (Anthropic, Google, OpenAI) and Assetly internal actions';


--
-- Name: workspace_audit_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_audit_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    health integer NOT NULL,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    finding_keys text[] DEFAULT '{}'::text[] NOT NULL,
    high_count integer DEFAULT 0 NOT NULL,
    failing integer DEFAULT 0 NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_graph_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_graph_edges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid,
    subject_label text NOT NULL,
    relationship text NOT NULL,
    object_type text NOT NULL,
    object_id uuid,
    object_label text NOT NULL,
    confidence double precision DEFAULT 1.0,
    source text DEFAULT 'extraction'::text,
    source_memory_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_linkedin_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_linkedin_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    unipile_account_id text NOT NULL,
    linkedin_name text,
    linkedin_headline text,
    linkedin_profile_url text,
    connected_at timestamp with time zone DEFAULT now(),
    label text,
    owner_user_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    engagement_enabled boolean DEFAULT true NOT NULL,
    last_engagement_scrape_at timestamp with time zone,
    engagement_scrape_requested_days integer,
    engagement_scrape_requested_at timestamp with time zone
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.workspace_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    job_role text,
    agent_instructions text
);


--
-- Name: workspace_skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_skills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    name text NOT NULL,
    description text NOT NULL,
    body text NOT NULL,
    requires_providers text[] DEFAULT '{}'::text[] NOT NULL,
    allowed_tools text[] DEFAULT '{}'::text[] NOT NULL,
    est_cost_usd numeric(10,4),
    is_builtin boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category text,
    summary text
);


--
-- Name: workspace_system_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_system_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    event_type text NOT NULL,
    summary text NOT NULL,
    contact_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    billable_ops integer DEFAULT 1 NOT NULL,
    user_id uuid,
    use_case text
);


--
-- Name: workspace_webhook_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_webhook_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'pending'::text NOT NULL,
    tested_at timestamp with time zone
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    slug text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    icon text,
    brand_theme jsonb DEFAULT '{}'::jsonb,
    target_audience jsonb DEFAULT '{}'::jsonb,
    design_style text DEFAULT 'corporate'::text,
    reference_images jsonb DEFAULT '[]'::jsonb,
    default_language text DEFAULT 'en'::text,
    updated_at date,
    stripe_subscription_item_id text,
    industry text DEFAULT 'agency'::text,
    default_stripe_connection_id uuid,
    proposal_flow_config jsonb DEFAULT '{"invoice": {"enabled": false}, "landing_page": {"enabled": false, "message": "", "video_url": "", "button_text": "Open Proposal"}, "post_signature": {"enabled": true, "message": "", "video_url": "", "meeting_url": "", "meeting_label": "Book Onboarding Call"}, "legal_documents": []}'::jsonb,
    icp_text text,
    country character varying(2),
    business_type text,
    plan_model text,
    default_signup_stage text,
    website text,
    playbook_rebuild_count integer DEFAULT 0 NOT NULL,
    outreach_cooldowns jsonb DEFAULT '{"any_hours": 24, "email_hours": 72, "linkedin_hours": 48}'::jsonb NOT NULL,
    CONSTRAINT workspaces_business_type_check CHECK (((business_type IS NULL) OR (business_type = ANY (ARRAY['service'::text, 'software'::text])))),
    CONSTRAINT workspaces_design_style_check CHECK ((design_style = ANY (ARRAY['corporate'::text, 'creative'::text, 'minimalist'::text, 'bold'::text, 'elegant'::text, 'modern'::text, 'classic'::text]))),
    CONSTRAINT workspaces_industry_check CHECK ((industry = ANY (ARRAY['agency'::text, 'startup'::text, 'software'::text, 'consultancy'::text]))),
    CONSTRAINT workspaces_plan_model_check CHECK (((plan_model IS NULL) OR (plan_model = ANY (ARRAY['free_plan'::text, 'free_trial'::text, 'both'::text, 'paid_only'::text]))))
);


--
-- Name: COLUMN workspaces.icon; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.icon IS 'Icon identifier/name from predefined set (e.g., emoji or icon name)';


--
-- Name: COLUMN workspaces.brand_theme; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.brand_theme IS 'Brand theme settings as JSONB. Structure:
{
  "theme": "light" | "dark",
  "secondary_color": "#hexcolor",
  "color_mode": "accent" | "consistent",
  "dark_cover_style": "secondary" | "accents",
  "logo_url": "https://...",
  "logo_position": "top-left" | "top-right" | "top-center" | "hidden",
  "background_theme": "photographic" | "visual" | "pattern" | "solid_blocks" | "bars" | "bubbles"
}';


--
-- Name: COLUMN workspaces.target_audience; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.target_audience IS 'Target audience and language preferences stored as JSONB. Structure:
{
  "audience_type": "Corporate | Technical | Consulting | Executive",
  "language_style": "Professional | Friendly | Authoritative | Technical",
  "tone": "Formal | Casual | Conversational",
  "industry": "Technology | Finance | Healthcare | Consulting",
  "custom_notes": "Additional guidance for AI..."
}';


--
-- Name: COLUMN workspaces.design_style; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.design_style IS 'Design style preference for document generation: corporate, creative, minimalist, bold, elegant, modern, classic';


--
-- Name: COLUMN workspaces.reference_images; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.reference_images IS 'Array of reference image URLs for brand guidelines: [{url, description}]';


--
-- Name: COLUMN workspaces.default_language; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.default_language IS 'Default language for document generation (ISO 639-1 code): en, de, fr, es, it, pt, nl, pl, etc.';


--
-- Name: COLUMN workspaces.industry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.industry IS 'Industry type for proposal structure recommendations: agency, startup, software, consultancy';


--
-- Name: llm_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage ALTER COLUMN id SET DEFAULT nextval('public.llm_usage_id_seq'::regclass);


--
-- Name: agent_routine_runs agent_routine_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routine_runs
    ADD CONSTRAINT agent_routine_runs_pkey PRIMARY KEY (id);


--
-- Name: agent_routines agent_routines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routines
    ADD CONSTRAINT agent_routines_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_workspace_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_workspace_id_name_key UNIQUE (workspace_id, name);


--
-- Name: blog_articles blog_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_articles
    ADD CONSTRAINT blog_articles_pkey PRIMARY KEY (id);


--
-- Name: blog_articles blog_articles_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_articles
    ADD CONSTRAINT blog_articles_slug_key UNIQUE (slug);


--
-- Name: campaign_messages campaign_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_messages
    ADD CONSTRAINT campaign_messages_pkey PRIMARY KEY (id);


--
-- Name: campaign_messages campaign_messages_workspace_id_provider_campaign_id_step_va_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_messages
    ADD CONSTRAINT campaign_messages_workspace_id_provider_campaign_id_step_va_key UNIQUE (workspace_id, provider, campaign_id, step, variant);


--
-- Name: changelog_entries changelog_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.changelog_entries
    ADD CONSTRAINT changelog_entries_pkey PRIMARY KEY (id);


--
-- Name: claim_jobs claim_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_jobs
    ADD CONSTRAINT claim_jobs_pkey PRIMARY KEY (id);


--
-- Name: claims claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_pkey PRIMARY KEY (id);


--
-- Name: claims claims_workspace_id_entity_id_property_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_workspace_id_entity_id_property_key UNIQUE (workspace_id, entity_id, property);


--
-- Name: cli_auth_requests cli_auth_requests_device_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_auth_requests
    ADD CONSTRAINT cli_auth_requests_device_code_key UNIQUE (device_code);


--
-- Name: cli_auth_requests cli_auth_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_auth_requests
    ADD CONSTRAINT cli_auth_requests_pkey PRIMARY KEY (id);


--
-- Name: collection_entities collection_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_entities
    ADD CONSTRAINT collection_entities_pkey PRIMARY KEY (collection_id, entity_id);


--
-- Name: collections collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: crm_hygiene_proposals crm_hygiene_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_hygiene_proposals
    ADD CONSTRAINT crm_hygiene_proposals_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_configs crm_sync_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_configs
    ADD CONSTRAINT crm_sync_configs_pkey PRIMARY KEY (id);


--
-- Name: crm_sync_configs crm_sync_configs_workspace_id_provider_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sync_configs
    ADD CONSTRAINT crm_sync_configs_workspace_id_provider_key UNIQUE (workspace_id, provider);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_identifiers entity_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identifiers
    ADD CONSTRAINT entity_identifiers_pkey PRIMARY KEY (id);


--
-- Name: lead_bulk_jobs lead_bulk_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_bulk_jobs
    ADD CONSTRAINT lead_bulk_jobs_pkey PRIMARY KEY (id);


--
-- Name: lead_suppressions lead_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_suppressions
    ADD CONSTRAINT lead_suppressions_pkey PRIMARY KEY (id);


--
-- Name: lead_suppressions lead_suppressions_workspace_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_suppressions
    ADD CONSTRAINT lead_suppressions_workspace_id_email_key UNIQUE (workspace_id, email);


--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);


--
-- Name: memory_ops_log memory_ops_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ops_log
    ADD CONSTRAINT memory_ops_log_pkey PRIMARY KEY (id);


--
-- Name: observation_crm_pushes observation_crm_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observation_crm_pushes
    ADD CONSTRAINT observation_crm_pushes_pkey PRIMARY KEY (observation_id, provider);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: outbound_events outbound_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_events
    ADD CONSTRAINT outbound_events_pkey PRIMARY KEY (id);


--
-- Name: pending_actions pending_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_actions
    ADD CONSTRAINT pending_actions_pkey PRIMARY KEY (id);


--
-- Name: playbooks playbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);


--
-- Name: playbooks playbooks_workspace_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playbooks
    ADD CONSTRAINT playbooks_workspace_id_kind_key UNIQUE (workspace_id, kind);


--
-- Name: playground_messages playground_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playground_messages
    ADD CONSTRAINT playground_messages_pkey PRIMARY KEY (id);


--
-- Name: playground_threads playground_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playground_threads
    ADD CONSTRAINT playground_threads_pkey PRIMARY KEY (id);


--
-- Name: predictions predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_pkey PRIMARY KEY (id);


--
-- Name: relationships relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_pkey PRIMARY KEY (id);


--
-- Name: relationships relationships_workspace_id_from_entity_id_to_entity_id_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_workspace_id_from_entity_id_to_entity_id_type_key UNIQUE (workspace_id, from_entity_id, to_entity_id, type);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);


--
-- Name: roadmap_items roadmap_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roadmap_items
    ADD CONSTRAINT roadmap_items_pkey PRIMARY KEY (id);


--
-- Name: scorecard_runs scorecard_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_runs
    ADD CONSTRAINT scorecard_runs_pkey PRIMARY KEY (id);


--
-- Name: scorecard_signals scorecard_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_signals
    ADD CONSTRAINT scorecard_signals_pkey PRIMARY KEY (id);


--
-- Name: scorecard_signals scorecard_signals_workspace_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_signals
    ADD CONSTRAINT scorecard_signals_workspace_id_key_key UNIQUE (workspace_id, key);


--
-- Name: signup_stats signup_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_stats
    ADD CONSTRAINT signup_stats_pkey PRIMARY KEY (stat_key);


--
-- Name: skill_downloads skill_downloads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_downloads
    ADD CONSTRAINT skill_downloads_pkey PRIMARY KEY (slug);


--
-- Name: slack_channel_map slack_channel_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_channel_map
    ADD CONSTRAINT slack_channel_map_pkey PRIMARY KEY (id);


--
-- Name: slack_channel_map slack_channel_map_workspace_id_slack_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_channel_map
    ADD CONSTRAINT slack_channel_map_workspace_id_slack_channel_id_key UNIQUE (workspace_id, slack_channel_id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: subscriptions subscriptions_team_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_team_id_key UNIQUE (team_id);


--
-- Name: team_accounts_grace team_accounts_grace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_accounts_grace
    ADD CONSTRAINT team_accounts_grace_pkey PRIMARY KEY (team_id);


--
-- Name: team_invitations team_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_pkey PRIMARY KEY (id);


--
-- Name: team_invitations team_invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_token_key UNIQUE (token);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: team_ops_email_log team_ops_email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_ops_email_log
    ADD CONSTRAINT team_ops_email_log_pkey PRIMARY KEY (team_id, kind, period_start);


--
-- Name: team_ops_grace team_ops_grace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_ops_grace
    ADD CONSTRAINT team_ops_grace_pkey PRIMARY KEY (team_id);


--
-- Name: team_records_grace team_records_grace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_records_grace
    ADD CONSTRAINT team_records_grace_pkey PRIMARY KEY (team_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: teams teams_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_slug_key UNIQUE (slug);


--
-- Name: teams teams_stripe_customer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_stripe_customer_id_key UNIQUE (stripe_customer_id);


--
-- Name: trigger_subscriptions trigger_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_subscriptions
    ADD CONSTRAINT trigger_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: agent_routine_runs uniq_run_per_occurrence; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routine_runs
    ADD CONSTRAINT uniq_run_per_occurrence UNIQUE (routine_id, dedupe_key);


--
-- Name: workspace_graph_edges unique_graph_edge; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_graph_edges
    ADD CONSTRAINT unique_graph_edge UNIQUE (workspace_id, subject_label, relationship, object_label);


--
-- Name: team_members unique_team_membership; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT unique_team_membership UNIQUE (team_id, user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_supabase_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_supabase_user_id_key UNIQUE (supabase_user_id);


--
-- Name: webhook_inbox webhook_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_pkey PRIMARY KEY (id);


--
-- Name: weekly_updates weekly_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.weekly_updates
    ADD CONSTRAINT weekly_updates_pkey PRIMARY KEY (id);


--
-- Name: worker_runs worker_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_runs
    ADD CONSTRAINT worker_runs_pkey PRIMARY KEY (id);


--
-- Name: workflow_provider_connections workflow_provider_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_pkey PRIMARY KEY (id);


--
-- Name: workflow_provider_connections workflow_provider_connections_workspace_id_provider_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_workspace_id_provider_id_name_key UNIQUE (workspace_id, provider_id, name);


--
-- Name: workflow_providers workflow_providers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_providers
    ADD CONSTRAINT workflow_providers_name_key UNIQUE (name);


--
-- Name: workflow_providers workflow_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_providers
    ADD CONSTRAINT workflow_providers_pkey PRIMARY KEY (id);


--
-- Name: workspace_audit_snapshots workspace_audit_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_audit_snapshots
    ADD CONSTRAINT workspace_audit_snapshots_pkey PRIMARY KEY (id);


--
-- Name: workspace_graph_edges workspace_graph_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_graph_edges
    ADD CONSTRAINT workspace_graph_edges_pkey PRIMARY KEY (id);


--
-- Name: workspace_linkedin_connections workspace_linkedin_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_linkedin_connections
    ADD CONSTRAINT workspace_linkedin_connections_pkey PRIMARY KEY (id);


--
-- Name: workspace_linkedin_connections workspace_linkedin_connections_ws_account_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_linkedin_connections
    ADD CONSTRAINT workspace_linkedin_connections_ws_account_key UNIQUE (workspace_id, unipile_account_id);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: workspace_skills workspace_skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_pkey PRIMARY KEY (id);


--
-- Name: workspace_system_log workspace_system_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_system_log
    ADD CONSTRAINT workspace_system_log_pkey PRIMARY KEY (id);


--
-- Name: workspace_webhook_subscriptions workspace_webhook_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_webhook_subscriptions
    ADD CONSTRAINT workspace_webhook_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: workspace_webhook_subscriptions workspace_webhook_subscriptions_workspace_id_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_webhook_subscriptions
    ADD CONSTRAINT workspace_webhook_subscriptions_workspace_id_source_key UNIQUE (workspace_id, source);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_slug_key UNIQUE (slug);


--
-- Name: campaign_messages_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_messages_ws ON public.campaign_messages USING btree (workspace_id, created_at DESC);


--
-- Name: claim_jobs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claim_jobs_pending ON public.claim_jobs USING btree (enqueued_at) WHERE (picked_at IS NULL);


--
-- Name: claims_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claims_entity ON public.claims USING btree (entity_id);


--
-- Name: claims_entity_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claims_entity_property ON public.claims USING btree (entity_id, property) WHERE (invalid_at IS NULL);


--
-- Name: cli_auth_requests_device_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cli_auth_requests_device_code_idx ON public.cli_auth_requests USING btree (device_code);


--
-- Name: cli_auth_requests_user_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cli_auth_requests_user_code_idx ON public.cli_auth_requests USING btree (user_code);


--
-- Name: collection_entities_collection_added; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collection_entities_collection_added ON public.collection_entities USING btree (collection_id, added_at DESC);


--
-- Name: crm_hygiene_proposals_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_hygiene_proposals_run_idx ON public.crm_hygiene_proposals USING btree (run_id);


--
-- Name: crm_hygiene_proposals_ws_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_hygiene_proposals_ws_status_idx ON public.crm_hygiene_proposals USING btree (workspace_id, status, created_at DESC);


--
-- Name: entities_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_workspace ON public.entities USING btree (workspace_id, type) WHERE (status = 'active'::text);


--
-- Name: entity_identifiers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_identifiers_active ON public.entity_identifiers USING btree (workspace_id, kind, value) WHERE (status = 'active'::text);


--
-- Name: entity_identifiers_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_identifiers_entity ON public.entity_identifiers USING btree (entity_id);


--
-- Name: idx_api_keys_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_created_by ON public.api_keys USING btree (created_by_user_id);


--
-- Name: idx_api_keys_last_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_last_used_at ON public.api_keys USING btree (last_used_at DESC);


--
-- Name: idx_api_keys_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_workspace_id ON public.api_keys USING btree (workspace_id);


--
-- Name: idx_api_keys_workspace_revoked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_workspace_revoked ON public.api_keys USING btree (workspace_id, revoked_at) WHERE (revoked_at IS NULL);


--
-- Name: idx_audit_snapshots_ws_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_snapshots_ws_time ON public.workspace_audit_snapshots USING btree (workspace_id, checked_at DESC);


--
-- Name: idx_blog_articles_article_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_article_type ON public.blog_articles USING btree (article_type);


--
-- Name: idx_blog_articles_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_content ON public.blog_articles USING gin (content);


--
-- Name: idx_blog_articles_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_created_by ON public.blog_articles USING btree (created_by_user_id);


--
-- Name: idx_blog_articles_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_featured ON public.blog_articles USING btree (featured) WHERE (featured = true);


--
-- Name: idx_blog_articles_is_guide; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_is_guide ON public.blog_articles USING btree (is_guide) WHERE (is_guide = true);


--
-- Name: idx_blog_articles_published_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_published_at ON public.blog_articles USING btree (published_at DESC);


--
-- Name: idx_blog_articles_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_slug ON public.blog_articles USING btree (slug);


--
-- Name: idx_blog_articles_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_status ON public.blog_articles USING btree (status);


--
-- Name: idx_blog_articles_type_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_articles_type_status ON public.blog_articles USING btree (article_type, status);


--
-- Name: idx_observations_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_owner ON public.observations USING btree (workspace_id, entity_id, owner_user_id);


--
-- Name: idx_pending_actions_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_actions_open ON public.pending_actions USING btree (workspace_id, created_at DESC) WHERE (status = 'pending'::text);


--
-- Name: idx_pending_actions_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_actions_thread ON public.pending_actions USING btree (thread_id);


--
-- Name: idx_routines_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routines_due ON public.agent_routines USING btree (next_run_at) WHERE (enabled AND (trigger_kind = 'clock'::text));


--
-- Name: idx_routines_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_routines_workspace ON public.agent_routines USING btree (workspace_id) WHERE enabled;


--
-- Name: idx_runs_routine; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_routine ON public.agent_routine_runs USING btree (routine_id, started_at DESC);


--
-- Name: idx_runs_unseen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_runs_unseen ON public.agent_routine_runs USING btree (workspace_id) WHERE (seen_at IS NULL);


--
-- Name: idx_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_status ON public.subscriptions USING btree (status);


--
-- Name: idx_subscriptions_stripe_sub_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_stripe_sub_id ON public.subscriptions USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);


--
-- Name: idx_subscriptions_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_team_id ON public.subscriptions USING btree (team_id);


--
-- Name: idx_team_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_email ON public.team_invitations USING btree (email);


--
-- Name: idx_team_invitations_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_expires_at ON public.team_invitations USING btree (expires_at);


--
-- Name: idx_team_invitations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_status ON public.team_invitations USING btree (status);


--
-- Name: idx_team_invitations_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_team_id ON public.team_invitations USING btree (team_id);


--
-- Name: idx_team_invitations_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_invitations_token ON public.team_invitations USING btree (token);


--
-- Name: idx_team_invitations_unique_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_team_invitations_unique_pending ON public.team_invitations USING btree (team_id, email) WHERE (status = 'pending'::text);


--
-- Name: idx_team_members_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_team_id ON public.team_members USING btree (team_id);


--
-- Name: idx_team_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_team_members_user_id ON public.team_members USING btree (user_id);


--
-- Name: idx_teams_ops_balance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_ops_balance ON public.teams USING btree (ops_balance);


--
-- Name: idx_teams_stripe_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_teams_stripe_customer_id ON public.teams USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);


--
-- Name: idx_users_default_signature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_default_signature ON public.users USING btree (id) WHERE (default_signature IS NOT NULL);


--
-- Name: idx_users_is_vip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_is_vip ON public.users USING btree (id) WHERE (is_vip = true);


--
-- Name: idx_users_referred_by_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_referred_by_code ON public.users USING btree (referred_by_code) WHERE (referred_by_code IS NOT NULL);


--
-- Name: idx_users_supabase_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_supabase_user_id ON public.users USING btree (supabase_user_id);


--
-- Name: idx_users_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_team_id ON public.users USING btree (team_id);


--
-- Name: idx_wge_object_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_object_id ON public.workspace_graph_edges USING btree (workspace_id, object_id) WHERE (object_id IS NOT NULL);


--
-- Name: idx_wge_object_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_object_label ON public.workspace_graph_edges USING btree (workspace_id, lower(object_label));


--
-- Name: idx_wge_relationship; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_relationship ON public.workspace_graph_edges USING btree (workspace_id, relationship);


--
-- Name: idx_wge_subject_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_subject_id ON public.workspace_graph_edges USING btree (workspace_id, subject_id) WHERE (subject_id IS NOT NULL);


--
-- Name: idx_wge_subject_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_subject_label ON public.workspace_graph_edges USING btree (workspace_id, lower(subject_label));


--
-- Name: idx_wge_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wge_workspace ON public.workspace_graph_edges USING btree (workspace_id);


--
-- Name: idx_workflow_connections_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_connections_provider ON public.workflow_provider_connections USING btree (provider_id);


--
-- Name: idx_workflow_connections_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_connections_verified ON public.workflow_provider_connections USING btree (is_verified);


--
-- Name: idx_workflow_connections_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_connections_workspace ON public.workflow_provider_connections USING btree (workspace_id);


--
-- Name: idx_workflow_providers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_providers_active ON public.workflow_providers USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_workflow_providers_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_providers_category ON public.workflow_providers USING btree (category);


--
-- Name: idx_workflow_providers_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_providers_name ON public.workflow_providers USING btree (name);


--
-- Name: idx_workspace_members_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_user_id ON public.workspace_members USING btree (user_id);


--
-- Name: idx_workspace_members_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_members_workspace_id ON public.workspace_members USING btree (workspace_id);


--
-- Name: idx_workspaces_brand_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_brand_theme ON public.workspaces USING gin (brand_theme);


--
-- Name: idx_workspaces_target_audience; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_target_audience ON public.workspaces USING gin (target_audience);


--
-- Name: idx_workspaces_team_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspaces_team_id ON public.workspaces USING btree (team_id);


--
-- Name: idx_wpc_account_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wpc_account_email ON public.workflow_provider_connections USING btree (workspace_id, account_email);


--
-- Name: idx_wpc_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wpc_owner ON public.workflow_provider_connections USING btree (workspace_id, owner_user_id);


--
-- Name: lead_bulk_jobs_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_bulk_jobs_list ON public.lead_bulk_jobs USING btree (lead_list_id, created_at DESC);


--
-- Name: lead_bulk_jobs_pickup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_bulk_jobs_pickup ON public.lead_bulk_jobs USING btree (created_at) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));


--
-- Name: llm_usage_feature_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_feature_time_idx ON public.llm_usage USING btree (feature, occurred_at DESC);


--
-- Name: llm_usage_workspace_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_workspace_time_idx ON public.llm_usage USING btree (workspace_id, occurred_at DESC);


--
-- Name: memory_ops_log_api_key_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_ops_log_api_key_id_idx ON public.memory_ops_log USING btree (api_key_id);


--
-- Name: memory_ops_log_team_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_ops_log_team_created_idx ON public.memory_ops_log USING btree (team_id, created_at DESC);


--
-- Name: memory_ops_log_team_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_ops_log_team_id_created_at_idx ON public.memory_ops_log USING btree (team_id, created_at);


--
-- Name: observation_crm_pushes_ws; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observation_crm_pushes_ws ON public.observation_crm_pushes USING btree (workspace_id);


--
-- Name: observations_claim_input; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_claim_input ON public.observations USING btree (entity_id, property, observed_at DESC);


--
-- Name: observations_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX observations_dedup ON public.observations USING btree (workspace_id, source, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: observations_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_embedding ON public.observations USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


--
-- Name: observations_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX observations_timeline ON public.observations USING btree (entity_id, observed_at DESC);


--
-- Name: outbound_events_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outbound_events_dedup ON public.outbound_events USING btree (workspace_id, subscription_id, external_id);


--
-- Name: outbound_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_pending ON public.outbound_events USING btree (next_attempt_at) WHERE ((delivered_at IS NULL) AND (dead_lettered_at IS NULL));


--
-- Name: outbound_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbound_workspace ON public.outbound_events USING btree (workspace_id, occurred_at DESC);


--
-- Name: playbooks_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playbooks_workspace_idx ON public.playbooks USING btree (workspace_id);


--
-- Name: playground_messages_thread_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playground_messages_thread_created_idx ON public.playground_messages USING btree (thread_id, created_at);


--
-- Name: playground_threads_workspace_user_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX playground_threads_workspace_user_updated_idx ON public.playground_threads USING btree (workspace_id, user_id, updated_at DESC);


--
-- Name: predictions_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX predictions_entity ON public.predictions USING btree (entity_id);


--
-- Name: reports_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_list_idx ON public.reports USING btree (lead_list_id, generated_at DESC);


--
-- Name: reports_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_ws_idx ON public.reports USING btree (workspace_id, generated_at DESC);


--
-- Name: resources_published_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resources_published_idx ON public.resources USING btree (published, sort_order);


--
-- Name: scm_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scm_channel ON public.slack_channel_map USING btree (slack_channel_id);


--
-- Name: scm_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scm_workspace ON public.slack_channel_map USING btree (workspace_id);


--
-- Name: scorecard_runs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scorecard_runs_workspace ON public.scorecard_runs USING btree (workspace_id, created_at DESC);


--
-- Name: scorecard_signals_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX scorecard_signals_workspace ON public.scorecard_signals USING btree (workspace_id, active);


--
-- Name: subscriptions_stripe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_stripe_idx ON public.subscriptions USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);


--
-- Name: subscriptions_team_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subscriptions_team_unique ON public.subscriptions USING btree (team_id);


--
-- Name: teams_stripe_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX teams_stripe_customer_idx ON public.teams USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);


--
-- Name: trigger_subs_events; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_subs_events ON public.trigger_subscriptions USING gin (events) WHERE active;


--
-- Name: trigger_subs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trigger_subs_workspace ON public.trigger_subscriptions USING btree (workspace_id) WHERE active;


--
-- Name: webhook_inbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_inbox_pending ON public.webhook_inbox USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: webhook_inbox_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_inbox_workspace ON public.webhook_inbox USING btree (workspace_id, received_at DESC);


--
-- Name: wlc_engagement_request; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wlc_engagement_request ON public.workspace_linkedin_connections USING btree (engagement_scrape_requested_at) WHERE (engagement_scrape_requested_days IS NOT NULL);


--
-- Name: wlc_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wlc_workspace ON public.workspace_linkedin_connections USING btree (workspace_id);


--
-- Name: worker_runs_finished; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_runs_finished ON public.worker_runs USING btree (finished_at DESC);


--
-- Name: worker_runs_worker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_runs_worker ON public.worker_runs USING btree (worker, finished_at DESC);


--
-- Name: worker_runs_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_runs_workspace ON public.worker_runs USING btree (workspace_id, finished_at DESC);


--
-- Name: workspace_linkedin_connections_workspace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_linkedin_connections_workspace_id_idx ON public.workspace_linkedin_connections USING btree (workspace_id);


--
-- Name: workspace_system_log_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_system_log_source_idx ON public.workspace_system_log USING btree (workspace_id, source);


--
-- Name: workspace_system_log_ws_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_system_log_ws_time_idx ON public.workspace_system_log USING btree (workspace_id, occurred_at DESC);


--
-- Name: workspaces_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspaces_country_idx ON public.workspaces USING btree (country) WHERE (country IS NOT NULL);


--
-- Name: wpc_slack_team; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wpc_slack_team ON public.workflow_provider_connections USING btree (((encrypted_credentials ->> 'slack_team_id'::text)));


--
-- Name: ws_skills_builtin_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ws_skills_builtin_name ON public.workspace_skills USING btree (name) WHERE (workspace_id IS NULL);


--
-- Name: ws_skills_own_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ws_skills_own_name ON public.workspace_skills USING btree (workspace_id, name) WHERE (workspace_id IS NOT NULL);


--
-- Name: ws_skills_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ws_skills_workspace ON public.workspace_skills USING btree (workspace_id) WHERE enabled;


--
-- Name: wsl_billing_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wsl_billing_idx ON public.workspace_system_log USING btree (workspace_id, occurred_at DESC) WHERE (billable_ops > 0);


--
-- Name: wsl_use_case_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wsl_use_case_time ON public.workspace_system_log USING btree (workspace_id, use_case, occurred_at DESC);


--
-- Name: wsl_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wsl_user_time ON public.workspace_system_log USING btree (workspace_id, user_id, occurred_at DESC);


--
-- Name: campaign_messages campaign_messages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER campaign_messages_updated_at BEFORE UPDATE ON public.campaign_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: companies companies_delete_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_delete_trigger INSTEAD OF DELETE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.companies_delete_handler();


--
-- Name: companies companies_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_insert_trigger INSTEAD OF INSERT ON public.companies FOR EACH ROW EXECUTE FUNCTION public.companies_insert_handler();


--
-- Name: companies companies_update_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_update_trigger INSTEAD OF UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.companies_update_handler();


--
-- Name: contacts contacts_delete_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_delete_trigger INSTEAD OF DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.contacts_delete_handler();


--
-- Name: contacts contacts_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_insert_trigger INSTEAD OF INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.contacts_insert_handler();


--
-- Name: contacts contacts_update_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER contacts_update_trigger INSTEAD OF UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.contacts_update_handler();


--
-- Name: entities entities_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entities_touch BEFORE UPDATE ON public.entities FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: lead_lists lead_lists_delete_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lead_lists_delete_trigger INSTEAD OF DELETE ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION public.lead_lists_delete_handler();


--
-- Name: lead_lists lead_lists_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lead_lists_insert_trigger INSTEAD OF INSERT ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION public.lead_lists_insert_handler();


--
-- Name: lead_lists lead_lists_update_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lead_lists_update_trigger INSTEAD OF UPDATE ON public.lead_lists FOR EACH ROW EXECUTE FUNCTION public.lead_lists_update_handler();


--
-- Name: leads leads_delete_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER leads_delete_trigger INSTEAD OF DELETE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.leads_delete_handler();


--
-- Name: leads leads_insert_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER leads_insert_trigger INSTEAD OF INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION public.leads_insert_handler();


--
-- Name: leads leads_update_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER leads_update_trigger INSTEAD OF UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.leads_update_handler();


--
-- Name: observations observations_enqueue_recompute; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER observations_enqueue_recompute AFTER INSERT ON public.observations FOR EACH ROW EXECUTE FUNCTION public.enqueue_claim_recompute();


--
-- Name: observations observations_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER observations_immutable BEFORE DELETE OR UPDATE ON public.observations FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

ALTER TABLE public.observations DISABLE TRIGGER observations_immutable;


--
-- Name: users on_user_signup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_user_signup AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.increment_signup_count();


--
-- Name: slack_channel_map scm_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scm_touch BEFORE UPDATE ON public.slack_channel_map FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: scorecard_signals scorecard_signals_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER scorecard_signals_updated_at BEFORE UPDATE ON public.scorecard_signals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: subscriptions subscriptions_sync_name; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subscriptions_sync_name BEFORE INSERT OR UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.sync_subscription_plan_name();


--
-- Name: crm_hygiene_proposals touch_crm_hygiene_proposals; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_crm_hygiene_proposals BEFORE UPDATE ON public.crm_hygiene_proposals FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: playground_messages trg_playground_messages_bump_thread; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_playground_messages_bump_thread AFTER INSERT ON public.playground_messages FOR EACH ROW EXECUTE FUNCTION public.bump_playground_thread_updated();


--
-- Name: team_members trigger_add_user_to_team_workspaces; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_add_user_to_team_workspaces AFTER INSERT ON public.team_members FOR EACH ROW EXECUTE FUNCTION public.add_user_to_team_workspaces();


--
-- Name: workflow_provider_connections trigger_workflow_connections_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_workflow_connections_updated_at BEFORE UPDATE ON public.workflow_provider_connections FOR EACH ROW EXECUTE FUNCTION public.update_workflow_connections_updated_at();


--
-- Name: workflow_providers trigger_workflow_providers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_workflow_providers_updated_at BEFORE UPDATE ON public.workflow_providers FOR EACH ROW EXECUTE FUNCTION public.update_workflow_providers_updated_at();


--
-- Name: blog_articles update_blog_articles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_blog_articles_updated_at BEFORE UPDATE ON public.blog_articles FOR EACH ROW EXECUTE FUNCTION public.update_blog_articles_updated_at();


--
-- Name: subscriptions update_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: workspace_skills ws_skills_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ws_skills_touch BEFORE UPDATE ON public.workspace_skills FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: agent_routine_runs agent_routine_runs_routine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routine_runs
    ADD CONSTRAINT agent_routine_runs_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES public.agent_routines(id) ON DELETE CASCADE;


--
-- Name: agent_routine_runs agent_routine_runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routine_runs
    ADD CONSTRAINT agent_routine_runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.playground_threads(id) ON DELETE SET NULL;


--
-- Name: agent_routine_runs agent_routine_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routine_runs
    ADD CONSTRAINT agent_routine_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: agent_routines agent_routines_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routines
    ADD CONSTRAINT agent_routines_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: agent_routines agent_routines_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_routines
    ADD CONSTRAINT agent_routines_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id);


--
-- Name: api_keys api_keys_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: api_keys api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: blog_articles blog_articles_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_articles
    ADD CONSTRAINT blog_articles_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: campaign_messages campaign_messages_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_messages
    ADD CONSTRAINT campaign_messages_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: claim_jobs claim_jobs_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_jobs
    ADD CONSTRAINT claim_jobs_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: claim_jobs claim_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_jobs
    ADD CONSTRAINT claim_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: claims claims_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: claims claims_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: cli_auth_requests cli_auth_requests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cli_auth_requests
    ADD CONSTRAINT cli_auth_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: collection_entities collection_entities_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_entities
    ADD CONSTRAINT collection_entities_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;


--
-- Name: collection_entities collection_entities_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_entities
    ADD CONSTRAINT collection_entities_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: collections collections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: crm_hygiene_proposals crm_hygiene_proposals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_hygiene_proposals
    ADD CONSTRAINT crm_hygiene_proposals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: entities entities_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.entities(id);


--
-- Name: entities entities_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: entity_identifiers entity_identifiers_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identifiers
    ADD CONSTRAINT entity_identifiers_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_identifiers entity_identifiers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identifiers
    ADD CONSTRAINT entity_identifiers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: lead_bulk_jobs lead_bulk_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_bulk_jobs
    ADD CONSTRAINT lead_bulk_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: lead_suppressions lead_suppressions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_suppressions
    ADD CONSTRAINT lead_suppressions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: llm_usage llm_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: llm_usage llm_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: memory_ops_log memory_ops_log_api_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_ops_log
    ADD CONSTRAINT memory_ops_log_api_key_id_fkey FOREIGN KEY (api_key_id) REFERENCES public.api_keys(id) ON DELETE SET NULL;


--
-- Name: observation_crm_pushes observation_crm_pushes_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observation_crm_pushes
    ADD CONSTRAINT observation_crm_pushes_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.observations(id) ON DELETE CASCADE;


--
-- Name: observation_crm_pushes observation_crm_pushes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observation_crm_pushes
    ADD CONSTRAINT observation_crm_pushes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: observations observations_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: observations observations_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: observations observations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: outbound_events outbound_events_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_events
    ADD CONSTRAINT outbound_events_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE SET NULL;


--
-- Name: outbound_events outbound_events_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_events
    ADD CONSTRAINT outbound_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.trigger_subscriptions(id) ON DELETE CASCADE;


--
-- Name: outbound_events outbound_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_events
    ADD CONSTRAINT outbound_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pending_actions pending_actions_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_actions
    ADD CONSTRAINT pending_actions_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.playground_threads(id) ON DELETE CASCADE;


--
-- Name: pending_actions pending_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_actions
    ADD CONSTRAINT pending_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: pending_actions pending_actions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_actions
    ADD CONSTRAINT pending_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: playground_messages playground_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playground_messages
    ADD CONSTRAINT playground_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.playground_threads(id) ON DELETE CASCADE;


--
-- Name: playground_threads playground_threads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playground_threads
    ADD CONSTRAINT playground_threads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: playground_threads playground_threads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.playground_threads
    ADD CONSTRAINT playground_threads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: predictions predictions_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: predictions predictions_outcome_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_outcome_observation_id_fkey FOREIGN KEY (outcome_observation_id) REFERENCES public.observations(id);


--
-- Name: predictions predictions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_from_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_to_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: scorecard_runs scorecard_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_runs
    ADD CONSTRAINT scorecard_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: scorecard_signals scorecard_signals_added_in_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_signals
    ADD CONSTRAINT scorecard_signals_added_in_fkey FOREIGN KEY (added_in) REFERENCES public.scorecard_runs(id) ON DELETE SET NULL;


--
-- Name: scorecard_signals scorecard_signals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scorecard_signals
    ADD CONSTRAINT scorecard_signals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: slack_channel_map slack_channel_map_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_channel_map
    ADD CONSTRAINT slack_channel_map_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_accounts_grace team_accounts_grace_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_accounts_grace
    ADD CONSTRAINT team_accounts_grace_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_invitations team_invitations_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_invitations team_invitations_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_invitations
    ADD CONSTRAINT team_invitations_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_ops_email_log team_ops_email_log_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_ops_email_log
    ADD CONSTRAINT team_ops_email_log_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_ops_grace team_ops_grace_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_ops_grace
    ADD CONSTRAINT team_ops_grace_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: team_records_grace team_records_grace_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_records_grace
    ADD CONSTRAINT team_records_grace_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: trigger_subscriptions trigger_subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trigger_subscriptions
    ADD CONSTRAINT trigger_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: users users_supabase_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_supabase_user_id_fkey FOREIGN KEY (supabase_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: users users_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;


--
-- Name: webhook_inbox webhook_inbox_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_inbox
    ADD CONSTRAINT webhook_inbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: worker_runs worker_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_runs
    ADD CONSTRAINT worker_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workflow_provider_connections workflow_provider_connections_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: workflow_provider_connections workflow_provider_connections_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workflow_provider_connections workflow_provider_connections_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.workflow_providers(id) ON DELETE CASCADE;


--
-- Name: workflow_provider_connections workflow_provider_connections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_provider_connections
    ADD CONSTRAINT workflow_provider_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_audit_snapshots workspace_audit_snapshots_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_audit_snapshots
    ADD CONSTRAINT workspace_audit_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_graph_edges workspace_graph_edges_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_graph_edges
    ADD CONSTRAINT workspace_graph_edges_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_linkedin_connections workspace_linkedin_connections_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_linkedin_connections
    ADD CONSTRAINT workspace_linkedin_connections_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_linkedin_connections workspace_linkedin_connections_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_linkedin_connections
    ADD CONSTRAINT workspace_linkedin_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_skills workspace_skills_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: workspace_skills workspace_skills_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_skills
    ADD CONSTRAINT workspace_skills_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_system_log workspace_system_log_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_system_log
    ADD CONSTRAINT workspace_system_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_webhook_subscriptions workspace_webhook_subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_webhook_subscriptions
    ADD CONSTRAINT workspace_webhook_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;


--
-- Name: blog_articles Admins can delete articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete articles" ON public.blog_articles FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: blog_articles Admins can insert articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert articles" ON public.blog_articles FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: blog_articles Admins can manage blog articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage blog articles" ON public.blog_articles USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: blog_articles Admins can read all articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all articles" ON public.blog_articles FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: blog_articles Admins can update articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update articles" ON public.blog_articles FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: teams Admins can view all teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all teams" ON public.teams FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users
  WHERE ((users.id = auth.uid()) AND (users.is_admin = true)))));


--
-- Name: blog_articles Anyone can read published blogs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read published blogs" ON public.blog_articles FOR SELECT USING ((status = 'published'::text));


--
-- Name: workflow_providers Anyone can view active providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view active providers" ON public.workflow_providers FOR SELECT USING ((is_active = true));


--
-- Name: teams Only team owners can delete teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only team owners can delete teams" ON public.teams FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.team_members
  WHERE ((team_members.team_id = teams.id) AND (team_members.user_id = auth.uid()) AND (team_members.role = ANY (ARRAY['founder'::text, 'owner'::text]))))));


--
-- Name: changelog_entries Public can read changelog; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read changelog" ON public.changelog_entries FOR SELECT USING (true);


--
-- Name: blog_articles Public can read published articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read published articles" ON public.blog_articles FOR SELECT USING ((status = 'published'::text));


--
-- Name: roadmap_items Public read roadmap_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read roadmap_items" ON public.roadmap_items FOR SELECT USING (true);


--
-- Name: weekly_updates Public read weekly_updates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read weekly_updates" ON public.weekly_updates FOR SELECT USING (true);


--
-- Name: team_invitations Service role can manage all invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage all invitations" ON public.team_invitations USING ((auth.role() = 'service_role'::text));


--
-- Name: subscriptions Service role can manage subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage subscriptions" ON public.subscriptions USING ((auth.role() = 'service_role'::text));


--
-- Name: api_keys Service role full access to api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to api_keys" ON public.api_keys TO service_role USING (true) WITH CHECK (true);


--
-- Name: blog_articles Service role full access to blog_articles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to blog_articles" ON public.blog_articles TO service_role USING (true) WITH CHECK (true);


--
-- Name: workflow_provider_connections Service role full access to workflow_provider_connections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to workflow_provider_connections" ON public.workflow_provider_connections TO service_role USING (true) WITH CHECK (true);


--
-- Name: team_members Team admins can remove team members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team admins can remove team members" ON public.team_members FOR DELETE USING (((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid()) AND (tm.role = ANY (ARRAY['founder'::text, 'owner'::text, 'admin'::text]))))) OR (user_id = auth.uid())));


--
-- Name: team_members Team admins can update team member roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team admins can update team member roles" ON public.team_members FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.team_members team_members_1
  WHERE ((team_members_1.team_id = team_members_1.team_id) AND (team_members_1.user_id = auth.uid()) AND (team_members_1.role = ANY (ARRAY['founder'::text, 'owner'::text, 'admin'::text]))))));


--
-- Name: team_members Team members can view team members in their team; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team members can view team members in their team" ON public.team_members FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid())))));


--
-- Name: teams Team owners and admins can update their team; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Team owners and admins can update their team" ON public.teams FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.team_members
  WHERE ((team_members.team_id = teams.id) AND (team_members.user_id = auth.uid()) AND (team_members.role = ANY (ARRAY['founder'::text, 'owner'::text, 'admin'::text]))))));


--
-- Name: team_invitations Users can manage invitations they sent; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage invitations they sent" ON public.team_invitations USING ((invited_by_user_id = auth.uid()));


--
-- Name: workflow_provider_connections Users can manage provider connections in their workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage provider connections in their workspace" ON public.workflow_provider_connections USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = auth.uid()))));


--
-- Name: api_keys Users can manage workspace api keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage workspace api keys" ON public.api_keys USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));


--
-- Name: workflow_provider_connections Users can manage workspace connections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage workspace connections" ON public.workflow_provider_connections USING (public.is_workspace_member(workspace_id)) WITH CHECK (public.is_workspace_member(workspace_id));


--
-- Name: team_invitations Users can view invitations they sent; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view invitations they sent" ON public.team_invitations FOR SELECT USING ((invited_by_user_id = auth.uid()));


--
-- Name: team_members Users can view their own team membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own team membership" ON public.team_members FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: subscriptions Users can view their team subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their team subscriptions" ON public.subscriptions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.users u
  WHERE ((u.id = auth.uid()) AND (u.team_id = subscriptions.team_id)))));


--
-- Name: teams Users can view their teams; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their teams" ON public.teams FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.team_members
  WHERE ((team_members.team_id = teams.id) AND (team_members.user_id = auth.uid())))));


--
-- Name: agent_routine_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_routine_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_routines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_routines ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_articles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_articles ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: changelog_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.changelog_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_hygiene_proposals chp_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY chp_all ON public.crm_hygiene_proposals USING (public.is_workspace_member(workspace_id));


--
-- Name: claim_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.claim_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;

--
-- Name: cli_auth_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cli_auth_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: claims clm_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clm_select ON public.claims FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: collections col_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY col_select ON public.collections FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: collection_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collection_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: collections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_hygiene_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_hygiene_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_sync_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.crm_sync_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_identifiers eid_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY eid_select ON public.entity_identifiers FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: entities ent_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ent_select ON public.entities FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_identifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_identifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_bulk_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lead_bulk_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lead_suppressions ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_ops_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_ops_log ENABLE ROW LEVEL SECURITY;

--
-- Name: observations obs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY obs_select ON public.observations FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: observation_crm_pushes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observation_crm_pushes ENABLE ROW LEVEL SECURITY;

--
-- Name: observations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;

--
-- Name: observation_crm_pushes ocp_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ocp_select ON public.observation_crm_pushes FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: outbound_events oe_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY oe_select ON public.outbound_events FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: outbound_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.outbound_events ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_actions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;

--
-- Name: playbooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;

--
-- Name: playground_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playground_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: playground_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.playground_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: predictions prd_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY prd_select ON public.predictions FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: predictions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;

--
-- Name: relationships rel_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rel_select ON public.relationships FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: relationships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: resources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

--
-- Name: roadmap_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roadmap_items ENABLE ROW LEVEL SECURITY;

--
-- Name: slack_channel_map scm_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY scm_all ON public.slack_channel_map USING (public.is_workspace_member(workspace_id));


--
-- Name: scorecard_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scorecard_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: scorecard_signals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scorecard_signals ENABLE ROW LEVEL SECURITY;

--
-- Name: signup_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signup_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: skill_downloads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.skill_downloads ENABLE ROW LEVEL SECURITY;

--
-- Name: slack_channel_map; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.slack_channel_map ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions subscriptions_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_member_read ON public.subscriptions FOR SELECT TO authenticated USING ((team_id IN ( SELECT w.team_id
   FROM (public.workspaces w
     JOIN public.workspace_members wm ON ((wm.workspace_id = w.id)))
  WHERE (wm.user_id = auth.uid()))));


--
-- Name: team_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

--
-- Name: team_ops_email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_ops_email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: team_ops_grace; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_ops_grace ENABLE ROW LEVEL SECURITY;

--
-- Name: team_records_grace; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_records_grace ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trigger_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: trigger_subscriptions trs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trs_select ON public.trigger_subscriptions FOR SELECT USING (public.is_workspace_member(workspace_id));


--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: users users_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated USING ((id = auth.uid()));


--
-- Name: users users_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_service_role ON public.users TO service_role USING (true) WITH CHECK (true);


--
-- Name: users users_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_update_own ON public.users FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: webhook_inbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_inbox ENABLE ROW LEVEL SECURITY;

--
-- Name: weekly_updates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.weekly_updates ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_provider_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_provider_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_linkedin_connections workspace members can manage linkedin connection; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workspace members can manage linkedin connection" ON public.workspace_linkedin_connections USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = auth.uid()))));


--
-- Name: workspace_system_log workspace members can read system log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workspace members can read system log" ON public.workspace_system_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = workspace_system_log.workspace_id) AND (workspace_members.user_id = auth.uid())))));


--
-- Name: workspace_linkedin_connections workspace members can view linkedin connection; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "workspace members can view linkedin connection" ON public.workspace_linkedin_connections FOR SELECT USING ((workspace_id IN ( SELECT workspace_members.workspace_id
   FROM public.workspace_members
  WHERE (workspace_members.user_id = auth.uid()))));


--
-- Name: workspace_graph_edges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_graph_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_graph_edges workspace_graph_edges_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_graph_edges_select ON public.workspace_graph_edges FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workspace_members
  WHERE ((workspace_members.workspace_id = workspace_graph_edges.workspace_id) AND (workspace_members.user_id = auth.uid())))));


--
-- Name: workspace_graph_edges workspace_graph_edges_service_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_graph_edges_service_all ON public.workspace_graph_edges USING ((auth.role() = 'service_role'::text));


--
-- Name: workspace_linkedin_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_linkedin_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members workspace_members_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_members_select_own ON public.workspace_members FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: workspace_members workspace_members_select_same_workspace; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_members_select_same_workspace ON public.workspace_members FOR SELECT TO authenticated USING ((workspace_id IN ( SELECT public.get_user_workspace_ids() AS get_user_workspace_ids)));


--
-- Name: workspace_members workspace_members_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_members_service_role ON public.workspace_members TO service_role USING (true) WITH CHECK (true);


--
-- Name: workspace_skills; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_skills ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_system_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_system_log ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces workspaces_read_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_read_all ON public.workspaces FOR SELECT TO authenticated USING (true);


--
-- Name: workspaces workspaces_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_service_role ON public.workspaces TO service_role USING (true) WITH CHECK (true);


--
-- Name: workspaces workspaces_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspaces_update ON public.workspaces FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members wm
  WHERE ((wm.workspace_id = workspaces.id) AND (wm.user_id = auth.uid())))));


--
-- Name: workspace_skills ws_skills_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ws_skills_select ON public.workspace_skills FOR SELECT USING (((workspace_id IS NULL) OR public.is_workspace_member(workspace_id)));


--
-- Name: workspace_skills ws_skills_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ws_skills_write ON public.workspace_skills USING (((workspace_id IS NOT NULL) AND public.is_workspace_member(workspace_id))) WITH CHECK (((workspace_id IS NOT NULL) AND public.is_workspace_member(workspace_id)));


--
-- PostgreSQL database dump complete
--




--
-- Name: contact_enrichment_jobs; Type: TABLE; Schema: public; Owner: -
-- Durable progress snapshot for the post-import contact-history backfill.
-- See supabase/migrations/contact_enrichment_jobs.sql.
--

CREATE TABLE IF NOT EXISTS public.contact_enrichment_jobs (
    job_id       uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    contact_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
    contacts     jsonb NOT NULL DEFAULT '[]'::jsonb,
    status       text NOT NULL DEFAULT 'pending',
    attempts     integer NOT NULL DEFAULT 0,
    locked_at    timestamptz,
    error        text,
    state        jsonb NOT NULL DEFAULT '{}'::jsonb,
    done         boolean NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_enrichment_jobs_status ON public.contact_enrichment_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS contact_enrichment_jobs_workspace_id ON public.contact_enrichment_jobs (workspace_id);
