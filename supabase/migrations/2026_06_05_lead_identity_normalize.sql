-- Lead identity resolution: match linkedin_url NORMALIZED, not exact.
--
-- The resolver matched `value = e_li` exactly, so a stored contact URL with a
-- trailing slash (…/in/nikolai-petrov/) failed to match a scraped lead URL
-- without one (…/in/nikolai-petrov) — spawning a DUPLICATE person entity
-- instead of merging into the existing contact. The LinkedIn engagement worker
-- hit this for every engager who was already a contact (e.g. Nikolai).
--
-- Fix: compare a canonical form on both sides — lowercase, drop query string,
-- strip protocol + www, strip trailing slashes — so all the common URL shapes
-- collapse to the same key (linkedin.com/in/<slug>). Email match is unchanged.

CREATE OR REPLACE FUNCTION leads_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
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
  IF NEW.contact_id IS NOT NULL THEN
    new_id := NEW.contact_id;
  ELSE
    -- Resolve to an existing entity by a strong identifier (no duplicate people,
    -- and the new lead inherits the identifier instead of orphaning). LinkedIn
    -- match is normalized so trailing-slash / www / case differences still merge.
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
