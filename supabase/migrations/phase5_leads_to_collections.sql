-- ============================================================
-- Phase 5: leads + lead_lists → entities + collections + claims
--          + cold-outbound primitives (reachability, sentiment, archived)
--
-- Same pattern as Phase 4c: drop the v1 tables, replace with VIEWs over the
-- v2 substrate, INSTEAD OF triggers for INSERT/UPDATE/DELETE.
--
-- New v2 primitives this migration introduces:
--   - entities.status gains 'archived' (for retiring cold prospects)
--   - collections.metadata JSONB (carries the lead-list `columns` UI config)
--   - claim properties: reachability_status, sentiment, lead_status, send_variant,
--     scorecard_score, is_repeat_contact, features, fields
-- ============================================================

BEGIN;

-- ── Step 0: schema additions ──────────────────────────────────────────────

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_status_check;
ALTER TABLE entities ADD CONSTRAINT entities_status_check
  CHECK (status IN ('active', 'merged', 'archived'));

ALTER TABLE collections ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Step 1: defensive final backfill ──────────────────────────────────────

-- 1a) Lead identifiers (email, linkedin_url) onto their entity.
INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), k.kind, k.value
FROM leads l
CROSS JOIN LATERAL (VALUES
  ('email',        lower(NULLIF(trim(l.email),''))),
  ('linkedin_url', NULLIF(trim(l.linkedin_url),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
  AND COALESCE(l.contact_id, l.id) IN (SELECT id FROM entities)
ON CONFLICT DO NOTHING;

-- 1b) Lead profile + status + cold-outbound claim columns.
INSERT INTO claims (workspace_id, entity_id, property, value,
                    confidence, epistemic_class, freshness, last_observed_at, computed_at)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), k.property, k.value,
       0.6, 'observed', 'aging', COALESCE(l.updated_at, l.created_at, now()), now()
FROM leads l
CROSS JOIN LATERAL (VALUES
  -- Name split
  ('first_name',       to_jsonb(NULLIF(trim(split_part(l.name, ' ', 1)),''))),
  ('last_name',        to_jsonb(NULLIF(trim(substring(l.name FROM position(' ' IN l.name) + 1)),''))),
  ('company',          to_jsonb(NULLIF(trim(l.company),''))),
  -- Cold-outbound primitives
  ('lead_status',      to_jsonb(NULLIF(trim(l.status),''))),
  ('send_variant',     to_jsonb(NULLIF(trim(l.send_variant),''))),
  ('scorecard_score',  to_jsonb(l.scorecard_score)),
  ('is_repeat_contact',to_jsonb(l.is_repeat_contact)),
  ('features',         CASE WHEN l.features IS NULL OR l.features = '{}'::jsonb THEN NULL ELSE l.features END),
  ('fields',           CASE WHEN l.fields   IS NULL OR l.fields   = '{}'::jsonb THEN NULL ELSE l.fields   END),
  -- Pipeline stage derivation:
  --   * bounced status        → keep current stage, mark reachability below
  --   * replied with positive → 'interested'
  --   * replied with negative → 'aware'  (still engaged but signal is negative)
  --   * sent but no reply     → 'cold'   (we touched them, no signal back)
  --   * pending (no send yet) → 'cold'
  ('pipeline_stage',
    CASE
      WHEN l.reply_outcome = 'positive' THEN to_jsonb('interested'::text)
      WHEN l.reply_outcome IN ('negative','do_not_contact') THEN to_jsonb('aware'::text)
      ELSE to_jsonb('cold'::text)
    END
  ),
  -- Reachability claim — derived from status/reply_outcome
  ('reachability_status',
    CASE
      WHEN l.status = 'bounced' THEN to_jsonb('bounced'::text)
      WHEN l.reply_outcome = 'unsubscribed' THEN to_jsonb('unsubscribed'::text)
      ELSE NULL
    END
  ),
  -- Sentiment claim — derived from reply_outcome
  ('sentiment',
    CASE
      WHEN l.reply_outcome = 'positive' THEN to_jsonb('positive'::text)
      WHEN l.reply_outcome = 'negative' THEN to_jsonb('negative'::text)
      WHEN l.reply_outcome = 'do_not_contact' THEN to_jsonb('do_not_contact'::text)
      ELSE NULL
    END
  )
) AS k(property, value)
WHERE k.value IS NOT NULL
  AND COALESCE(l.contact_id, l.id) IN (SELECT id FROM entities)
ON CONFLICT (workspace_id, entity_id, property) DO NOTHING;

-- 1c) Lead outreach events that the original v1→v2 migration backfilled
-- already cover sent_at/replied_at. Add reply outcome events here so the
-- reply classifier loop has structured event observations to work with.
INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), 'event',
       CASE l.reply_outcome
         WHEN 'positive'        THEN 'interaction.positive_reply'
         WHEN 'negative'        THEN 'interaction.negative_reply'
         WHEN 'do_not_contact'  THEN 'interaction.do_not_contact'
         WHEN 'unsubscribed'    THEN 'interaction.unsubscribed'
       END,
       jsonb_build_object('outcome', l.reply_outcome),
       'v1_backfill', 'migration', l.replied_at
FROM leads l
WHERE l.reply_outcome IN ('positive','negative','do_not_contact','unsubscribed')
  AND l.replied_at IS NOT NULL
  AND COALESCE(l.contact_id, l.id) IN (SELECT id FROM entities);

INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
SELECT l.workspace_id, COALESCE(l.contact_id, l.id), 'event',
       'interaction.email_bounced',
       jsonb_build_object('via', 'lead_status'),
       'v1_backfill', 'migration', COALESCE(l.updated_at, l.created_at, now())
FROM leads l
WHERE l.status = 'bounced'
  AND COALESCE(l.contact_id, l.id) IN (SELECT id FROM entities);

-- 1d) Collection metadata (the lead-list `columns` config) onto the
-- already-migrated collection rows.
UPDATE collections c
SET metadata = jsonb_build_object('columns', ll.columns)
FROM lead_lists ll
WHERE c.id = ll.id
  AND ll.columns IS NOT NULL
  AND (c.metadata IS NULL OR c.metadata = '{}'::jsonb);

-- ── Step 2: drop the v1 tables ────────────────────────────────────────────
DROP TABLE IF EXISTS leads CASCADE;
DROP TABLE IF EXISTS lead_lists CASCADE;

-- ── Step 3: lead_lists VIEW ───────────────────────────────────────────────
CREATE VIEW lead_lists AS
SELECT
  c.id,
  c.workspace_id,
  c.name,
  c.source,
  COALESCE(c.metadata->'columns', '[]'::jsonb) AS columns,
  c.created_at,
  (SELECT max(ce.added_at) FROM collection_entities ce WHERE ce.collection_id = c.id) AS updated_at
FROM collections c
WHERE c.kind = 'list';

-- ── Step 4: leads VIEW ────────────────────────────────────────────────────
CREATE VIEW leads AS
SELECT
  e.id,
  ce.collection_id AS lead_list_id,
  e.workspace_id,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'email'        AND status = 'active' LIMIT 1) AS email,
  TRIM(BOTH ' ' FROM CONCAT(
    COALESCE((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'first_name' AND invalid_at IS NULL LIMIT 1), ''),
    ' ',
    COALESCE((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'last_name'  AND invalid_at IS NULL LIMIT 1), '')
  )) AS name,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'company'     AND invalid_at IS NULL LIMIT 1) AS company,
  (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_url' AND status = 'active' LIMIT 1) AS linkedin_url,
  -- Outreach state
  (SELECT min(observed_at) FROM observations WHERE entity_id = e.id AND property = 'interaction.email_sent') AS sent_at,
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'send_variant'      AND invalid_at IS NULL LIMIT 1) AS send_variant,
  COALESCE(
    ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'is_repeat_contact' AND invalid_at IS NULL LIMIT 1))::boolean,
    false
  ) AS is_repeat_contact,
  COALESCE(
    (SELECT value FROM claims WHERE entity_id = e.id AND property = 'features' AND invalid_at IS NULL LIMIT 1),
    '{}'::jsonb
  ) AS features,
  COALESCE(
    (SELECT value FROM claims WHERE entity_id = e.id AND property = 'fields' AND invalid_at IS NULL LIMIT 1),
    '{}'::jsonb
  ) AS fields,
  ((SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'scorecard_score' AND invalid_at IS NULL LIMIT 1))::integer AS scorecard_score,
  -- Reply state
  (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'sentiment'    AND invalid_at IS NULL LIMIT 1) AS reply_outcome,
  (SELECT max(observed_at) FROM observations WHERE entity_id = e.id
     AND property IN ('interaction.reply','interaction.positive_reply','interaction.negative_reply')) AS replied_at,
  -- lead_status: derive a v1-like value from v2 claims/observations
  COALESCE(
    CASE
      WHEN (SELECT value #>> '{}' FROM claims WHERE entity_id = e.id AND property = 'reachability_status' AND invalid_at IS NULL LIMIT 1) = 'bounced'
        THEN 'bounced'
      WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id
                   AND property IN ('interaction.reply','interaction.positive_reply','interaction.negative_reply'))
        THEN 'replied'
      WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id AND property = 'interaction.email_sent')
        THEN 'sent'
      ELSE 'pending'
    END,
    'pending'
  ) AS status,
  -- contact_id: same as e.id for resolved/engaged leads (the migration convention).
  -- Old "orphan" leads with no engagement → NULL (semantically "not yet a contact").
  CASE
    WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id LIMIT 1)
      THEN e.id
    ELSE NULL
  END AS contact_id,
  e.created_at,
  COALESCE((SELECT max(computed_at) FROM claims WHERE entity_id = e.id), e.created_at) AS updated_at
FROM entities e
INNER JOIN collection_entities ce ON ce.entity_id = e.id
INNER JOIN collections c ON c.id = ce.collection_id AND c.kind = 'list'
WHERE e.type = 'person' AND e.status = 'active';

-- ── Step 5: INSTEAD OF triggers ───────────────────────────────────────────

-- ── lead_lists INSERT ──
CREATE OR REPLACE FUNCTION lead_lists_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
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
$fn$;
CREATE TRIGGER lead_lists_insert_trigger INSTEAD OF INSERT ON lead_lists
FOR EACH ROW EXECUTE FUNCTION lead_lists_insert_handler();

-- ── lead_lists UPDATE ──
CREATE OR REPLACE FUNCTION lead_lists_update_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
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
$fn$;
CREATE TRIGGER lead_lists_update_trigger INSTEAD OF UPDATE ON lead_lists
FOR EACH ROW EXECUTE FUNCTION lead_lists_update_handler();

-- ── lead_lists DELETE ──
CREATE OR REPLACE FUNCTION lead_lists_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM collection_entities WHERE collection_id = OLD.id;
  DELETE FROM collections WHERE id = OLD.id;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER lead_lists_delete_trigger INSTEAD OF DELETE ON lead_lists
FOR EACH ROW EXECUTE FUNCTION lead_lists_delete_handler();

-- ── leads INSERT ──
CREATE OR REPLACE FUNCTION leads_insert_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  new_id UUID := COALESCE(NEW.id, gen_random_uuid());
  ws UUID := NEW.workspace_id;
  fn_part TEXT := NULLIF(trim(split_part(COALESCE(NEW.name,''), ' ', 1)),'');
  ln_part TEXT := NULLIF(trim(substring(COALESCE(NEW.name,'') FROM position(' ' IN COALESCE(NEW.name,'')||' ') + 1)),'');
BEGIN
  -- Ensure entity (use contact_id if provided, else assign new)
  IF NEW.contact_id IS NOT NULL THEN
    new_id := NEW.contact_id;
  END IF;

  INSERT INTO entities (id, workspace_id, type, status, created_at)
  VALUES (new_id, ws, 'person', 'active', COALESCE(NEW.created_at, now()))
  ON CONFLICT (id) DO NOTHING;

  -- Identifiers
  INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
  SELECT ws, new_id, k.kind, k.value FROM (VALUES
    ('email',        lower(NULLIF(trim(NEW.email),''))),
    ('linkedin_url', NULLIF(trim(NEW.linkedin_url),''))
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
    -- A new lead with no engagement signals → cold by definition
    ('pipeline_stage',    to_jsonb('cold'::text))
  ) AS k(property, value)
  WHERE k.value IS NOT NULL;

  -- Outreach events (if pre-populated, e.g. CSV import with sent_at)
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

  -- Add to the collection (the list)
  IF NEW.lead_list_id IS NOT NULL THEN
    INSERT INTO collection_entities (collection_id, entity_id, added_at)
    VALUES (NEW.lead_list_id, new_id, COALESCE(NEW.created_at, now()))
    ON CONFLICT DO NOTHING;
  END IF;

  NEW.id := new_id;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER leads_insert_trigger INSTEAD OF INSERT ON leads
FOR EACH ROW EXECUTE FUNCTION leads_insert_handler();

-- ── leads UPDATE ──
CREATE OR REPLACE FUNCTION leads_update_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  ws UUID := COALESCE(NEW.workspace_id, OLD.workspace_id);
BEGIN
  -- Outreach state transitions written as event observations
  IF NEW.sent_at IS DISTINCT FROM OLD.sent_at AND NEW.sent_at IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, OLD.id, 'event', 'interaction.email_sent',
            jsonb_build_object('variant', NEW.send_variant),
            'lead_list', 'trigger', NEW.sent_at)
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
            jsonb_build_object('outcome', NEW.reply_outcome),
            'lead_list', 'trigger', NEW.replied_at);
  END IF;

  -- Status changes → state observations
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, OLD.id, 'state', 'lead_status', to_jsonb(NEW.status), 'lead_list', 'trigger', now());
    -- Bounce → reachability claim
    IF NEW.status = 'bounced' THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('bounced'::text),
              'lead_list', 'trigger', now());
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'event', 'interaction.email_bounced',
              jsonb_build_object('via','lead_status'),
              'lead_list', 'trigger', now());
    END IF;
  END IF;

  -- reply_outcome → sentiment claim (and pipeline_stage update if positive)
  IF NEW.reply_outcome IS DISTINCT FROM OLD.reply_outcome AND NEW.reply_outcome IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, OLD.id, 'state', 'sentiment', to_jsonb(NEW.reply_outcome::text),
            'lead_list', 'trigger', now());
    IF NEW.reply_outcome = 'positive' THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'pipeline_stage', to_jsonb('interested'::text),
              'lead_list', 'trigger', now());
    END IF;
    IF NEW.reply_outcome = 'unsubscribed' THEN
      INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
      VALUES (ws, OLD.id, 'state', 'reachability_status', to_jsonb('unsubscribed'::text),
              'lead_list', 'trigger', now());
    END IF;
  END IF;

  -- send_variant / scorecard / features / fields → claim state observations
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

  -- Move between lists if lead_list_id changed
  IF NEW.lead_list_id IS DISTINCT FROM OLD.lead_list_id THEN
    IF OLD.lead_list_id IS NOT NULL THEN
      DELETE FROM collection_entities WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
    END IF;
    IF NEW.lead_list_id IS NOT NULL THEN
      INSERT INTO collection_entities (collection_id, entity_id, added_at)
      VALUES (NEW.lead_list_id, OLD.id, now())
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  -- contact_id transition: when set on a lead, that's the graduation signal —
  -- entity merges with the contact. Our convention: contact.id == lead.id == entity.id,
  -- so when NEW.contact_id is set and matches OLD.id we don't need to do anything;
  -- when it differs (cross-id resolve), this is unusual — just record a state obs.
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL THEN
    INSERT INTO observations (workspace_id, entity_id, kind, property, value, source, method, observed_at)
    VALUES (ws, OLD.id, 'state', 'graduated_to_contact_id', to_jsonb(NEW.contact_id::text),
            'lead_list', 'trigger', now());
  END IF;

  RETURN NEW;
END;
$fn$;
CREATE TRIGGER leads_update_trigger INSTEAD OF UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION leads_update_handler();

-- ── leads DELETE ──
-- Removing a "lead row" means removing its collection membership, not the
-- underlying entity (which carries the engagement history). Per the v2 rule:
-- nothing is hard-deleted.
CREATE OR REPLACE FUNCTION leads_delete_handler() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.lead_list_id IS NOT NULL THEN
    DELETE FROM collection_entities
      WHERE collection_id = OLD.lead_list_id AND entity_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$fn$;
CREATE TRIGGER leads_delete_trigger INSTEAD OF DELETE ON leads
FOR EACH ROW EXECUTE FUNCTION leads_delete_handler();

COMMIT;

-- ── VERIFY ────────────────────────────────────────────────────────────────
-- SELECT 'leads',      count(*) FROM leads
-- UNION ALL SELECT 'lead_lists', count(*) FROM lead_lists
-- UNION ALL SELECT 'collections', count(*) FROM collections
-- UNION ALL SELECT 'collection_entities', count(*) FROM collection_entities;
--
-- SELECT property, count(*) FROM claims
-- WHERE invalid_at IS NULL AND property IN
--   ('pipeline_stage','reachability_status','sentiment','lead_status')
-- GROUP BY property ORDER BY 2 DESC;
