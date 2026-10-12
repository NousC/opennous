-- Make the `leads` VIEW writable on prod. The view existed but had no INSTEAD OF
-- write triggers, so inserts failed with "cannot insert into view leads".
-- Idempotent and safe to re-run (CREATE OR REPLACE + DROP TRIGGER IF EXISTS).
-- Requires `leads` to be the v2 VIEW. Run in the Supabase SQL editor.

-- ── INSERT ──
CREATE OR REPLACE FUNCTION leads_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  fn_part TEXT := NULLIF(trim(split_part(COALESCE(NEW.name,''), ' ', 1)),'');
  ln_part TEXT := NULLIF(trim(substring(COALESCE(NEW.name,'') FROM position(' ' IN COALESCE(NEW.name,'')||' ') + 1)),'');
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    new_id := NEW.contact_id;
  END IF;

  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('email',        lower(NULLIF(trim(NEW.email),''))),
    ('linkedin_url', NULLIF(trim(NEW.linkedin_url),''))
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

-- ── UPDATE ──
CREATE OR REPLACE FUNCTION leads_update_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
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
      VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('bounced'::text), 'lead_list', 'trigger', now());
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
      VALUES (ws, OLD.id, 'state', 'pipeline_stage', to_jsonb('interested'::text), 'lead_list', 'trigger', now());
    END IF;
    IF NEW.reply_outcome = 'unsubscribed' THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('unsubscribed'::text), 'lead_list', 'trigger', now());
    END IF;
  END IF;

  INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
  SELECT ws, OLD.id, 'state', k.property, k.new_v, 'lead_list', 'trigger', now() FROM (VALUES
    ('send_variant',      to_jsonb(NULLIF(trim(NEW.send_variant),'')), to_jsonb(NULLIF(trim(OLD.send_variant),''))),
    ('scorecard_score',   to_jsonb(NEW.scorecard_score),                to_jsonb(OLD.scorecard_score)),
    ('is_repeat_contact', to_jsonb(NEW.is_repeat_contact),              to_jsonb(OLD.is_repeat_contact)),
    ('features',          CASE WHEN NEW.features IS NULL OR NEW.features = '{}'::jsonb THEN NULL ELSE NEW.features END,
                          CASE WHEN OLD.features IS NULL OR OLD.features = '{}'::jsonb THEN NULL ELSE OLD.features END),
    ('fields',            CASE WHEN NEW.fields IS NULL OR NEW.fields = '{}'::jsonb THEN NULL ELSE NEW.fields END,
                          CASE WHEN OLD.fields IS NULL OR OLD.fields = '{}'::jsonb THEN NULL ELSE OLD.fields END)
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

  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, OLD.id, 'state', 'graduated_to_contact_id', to_jsonb(NEW.contact_id::text), 'lead_list', 'trigger', now());
  END IF;

  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS leads_update_trigger ON leads;
CREATE TRIGGER leads_update_trigger INSTEAD OF UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION leads_update_handler();

-- ── DELETE (already applied, included for completeness/idempotency) ──
CREATE OR REPLACE FUNCTION leads_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.lead_list_id IS NOT NULL THEN
    DELETE FROM collection_entities WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$fn$;
DROP TRIGGER IF EXISTS leads_delete_trigger ON leads;
CREATE TRIGGER leads_delete_trigger INSTEAD OF DELETE ON leads
FOR EACH ROW EXECUTE FUNCTION leads_delete_handler();
