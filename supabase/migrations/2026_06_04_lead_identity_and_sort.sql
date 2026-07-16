-- Two fixes for lead lists:
--  1. leads_insert_handler now RESOLVES to an existing entity by email or
--     linkedin_url before creating a new one. Without this, re-importing a
--     person whose identifier is already claimed by another entity left the new
--     lead with NO linkedin_url (ON CONFLICT DO NOTHING on the unique
--     (workspace_id, kind, value) identifier) — the blank LinkedIn column.
--  2. lead_list_leads() — paginated + ICP-filtered + numerically-sortable read,
--     so the UI can sort by ICP score across the whole list (a JSONB ->> field
--     can't be ordered numerically through PostgREST).
-- Idempotent. Run in the Supabase SQL editor.

-- ── 1. identity-resolving insert handler ──
CREATE OR REPLACE FUNCTION leads_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  fn_part TEXT := NULLIF(trim(split_part(COALESCE(NEW.name,''), ' ', 1)),'');
  ln_part TEXT := NULLIF(trim(substring(COALESCE(NEW.name,'') FROM position(' ' IN COALESCE(NEW.name,'')||' ') + 1)),'');
  e_email TEXT := lower(NULLIF(trim(NEW.email),''));
  e_li    TEXT := NULLIF(trim(NEW.linkedin_url),'');
  existing_id UUID;
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    new_id := NEW.contact_id;
  ELSE
    -- Resolve to an existing entity by a strong identifier (no duplicate people,
    -- and the new lead inherits the identifier instead of orphaning).
    SELECT entity_id INTO existing_id FROM entity_identifiers
     WHERE workspace_id = ws AND status = 'active'
       AND ((e_email IS NOT NULL AND kind = 'email'        AND value = e_email)
         OR (e_li    IS NOT NULL AND kind = 'linkedin_url' AND value = e_li))
     LIMIT 1;
    IF existing_id IS NOT NULL THEN new_id := existing_id; END IF;
  END IF;

  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('email',        e_email),
    ('linkedin_url', e_li)
  ) AS k(kind, value)
  WHERE k.value IS NOT NULL
  ON CONFLICT DO NOTHING;

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
            jsonb_build_object('variant', NEW.send_variant), 'lead_list', 'trigger', NEW.sent_at);
  END IF;
  IF NEW.replied_at IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, new_id, 'event', 'interaction.reply',
            jsonb_build_object('outcome', NEW.reply_outcome), 'lead_list', 'trigger', NEW.replied_at);
  END IF;

  IF NEW.lead_list_id IS NOT NULL THEN
    INSERT INTO collection_entities (collection_id, entity_id, added_at)
    VALUES (NEW.lead_list_id, new_id, COALESCE(NEW.created_at, now()))
    ON CONFLICT DO NOTHING;
  END IF;

  NEW.id := new_id;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS leads_insert_trigger ON leads;
CREATE TRIGGER leads_insert_trigger INSTEAD OF INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION leads_insert_handler();

-- ── 2. sortable / filtered / paginated read ──
-- p_sort: 'recent' (default), 'icp_score_desc', 'icp_score_asc'
-- p_icp:  NULL (all), 'true', 'false'
CREATE OR REPLACE FUNCTION lead_list_leads(
  p_ws UUID, p_list UUID, p_lim INT DEFAULT 50, p_off INT DEFAULT 0,
  p_icp TEXT DEFAULT NULL, p_sort TEXT DEFAULT 'recent'
) RETURNS SETOF leads LANGUAGE sql STABLE AS $$
  SELECT * FROM leads
  WHERE workspace_id = p_ws AND lead_list_id = p_list
    AND (p_icp IS NULL OR (fields->>'icp') = p_icp)
  ORDER BY
    CASE WHEN p_sort = 'icp_score_desc' THEN (fields->>'icp_score')::numeric END DESC NULLS LAST,
    CASE WHEN p_sort = 'icp_score_asc'  THEN (fields->>'icp_score')::numeric END ASC  NULLS LAST,
    created_at DESC
  LIMIT GREATEST(p_lim, 1) OFFSET GREATEST(p_off, 0)
$$;
