-- Lead source — a permanent, system-managed column on every lead list.
--
-- `source` answers "where did this lead come from?" (Sales Navigator, Apollo,
-- a CSV upload, the API, a manual add, LinkedIn engagement…). It is distinct
-- from the Channel column, which is the OUTREACH channel a lead went out on.
--
-- It lives on collection_entities (the list-membership row), not on the entity,
-- so the SAME person can carry a different source in list A vs list B — which is
-- exactly what makes per-campaign reporting trustworthy ("campaign A pulled from
-- a high-intent LinkedIn scraper, campaign B from cold Apollo, same copy").
--
-- It is NOT a user-creatable column: it's surfaced by the leads view directly so
-- the agent can always read it, regardless of what an import CSV happened to carry.

ALTER TABLE collection_entities ADD COLUMN IF NOT EXISTS source TEXT;

-- Backfill existing memberships from their list's own source so the column is
-- populated for data that predates per-lead source (instead of showing blank).
UPDATE collection_entities ce
   SET source = c.source
  FROM collections c
 WHERE ce.collection_id = c.id
   AND ce.source IS NULL
   AND c.source IS NOT NULL;

-- Recreate the leads view with the source column appended (last position so the
-- CREATE OR REPLACE is additive and the INSTEAD OF triggers stay attached).
CREATE OR REPLACE VIEW leads AS
 SELECT
   e.id,
   ce.collection_id AS lead_list_id,
   e.workspace_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'email' AND status = 'active' LIMIT 1) AS email,
   TRIM(BOTH ' ' FROM concat(
     COALESCE((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'first_name' AND invalid_at IS NULL LIMIT 1), ''),
     ' ',
     COALESCE((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'last_name' AND invalid_at IS NULL LIMIT 1), ''))) AS name,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'company' AND invalid_at IS NULL LIMIT 1) AS company,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_url' AND status = 'active' LIMIT 1) AS linkedin_url,
   (SELECT min(observed_at) FROM observations WHERE entity_id = e.id AND property = 'interaction.email_sent') AS sent_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'send_variant' AND invalid_at IS NULL LIMIT 1) AS send_variant,
   COALESCE(((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'is_repeat_contact' AND invalid_at IS NULL LIMIT 1))::boolean, false) AS is_repeat_contact,
   COALESCE((SELECT value FROM claims WHERE entity_id = e.id AND property = 'features' AND invalid_at IS NULL LIMIT 1), '{}'::jsonb) AS features,
   COALESCE((SELECT value FROM claims WHERE entity_id = e.id AND property = 'fields' AND invalid_at IS NULL LIMIT 1), '{}'::jsonb) AS fields,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'scorecard_score' AND invalid_at IS NULL LIMIT 1))::integer AS scorecard_score,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'sentiment' AND invalid_at IS NULL LIMIT 1) AS reply_outcome,
   (SELECT max(observed_at) FROM observations WHERE entity_id = e.id AND property = ANY (ARRAY['interaction.reply','interaction.positive_reply','interaction.negative_reply'])) AS replied_at,
   COALESCE(
     CASE
       WHEN (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'reachability_status' AND invalid_at IS NULL LIMIT 1) = 'bounced' THEN 'bounced'
       WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id AND property = ANY (ARRAY['interaction.reply','interaction.positive_reply','interaction.negative_reply'])) THEN 'replied'
       WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id AND property = 'interaction.email_sent') THEN 'sent'
       ELSE 'pending'
     END, 'pending') AS status,
   CASE WHEN EXISTS (SELECT 1 FROM observations WHERE entity_id = e.id LIMIT 1) THEN e.id ELSE NULL::uuid END AS contact_id,
   ce.added_at AS created_at,
   COALESCE((SELECT max(computed_at) FROM claims WHERE entity_id = e.id), ce.added_at) AS updated_at,
   -- Outbound foundation columns: company domain (from enrichment), email
   -- verification status (verified/bounced/catch_all/…), and the channel of the
   -- most recent interaction (source of the latest interaction.* event).
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'domain' AND invalid_at IS NULL LIMIT 1) AS domain,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'reachability_status' AND invalid_at IS NULL LIMIT 1) AS email_status,
   (SELECT source FROM observations
      WHERE entity_id = e.id AND kind = 'event' AND property LIKE 'interaction.%'
        AND property <> 'interaction.enrichment_run'
        AND source NOT IN ('prospeo', 'apollo')
      ORDER BY observed_at DESC LIMIT 1) AS last_channel,
   -- Lead source: where this lead came from, per-list (membership-scoped).
   ce.source AS source
 FROM entities e
   JOIN collection_entities ce ON ce.entity_id = e.id
   JOIN collections c ON c.id = ce.collection_id AND c.kind = 'list'
 WHERE e.type = 'person' AND e.status = 'active';

-- Insert handler — carry NEW.source onto the list-membership row. A re-import
-- with a source backfills a previously-null one; an explicit source wins.
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
$fn$;
