-- Phase 3: backfill entity_identifiers for any post-migration contacts.
--
-- The original v1_to_v2 migration backfilled every contact's identifiers
-- (email / linkedin_url / linkedin_member_id / hubspot_id / pipedrive_id /
-- apollo_id) into entity_identifiers. Contacts created AFTER the migration —
-- by webhooks, CSV imports, etc. — also need to be registered so the v2
-- lookup path (resolveEntity by identifier) finds them.

INSERT INTO entity_identifiers (workspace_id, entity_id, kind, value)
SELECT c.workspace_id, c.id, k.kind, k.value
FROM contacts c
CROSS JOIN LATERAL (VALUES
  ('email',              lower(NULLIF(trim(c.email),''))),
  ('linkedin_url',       NULLIF(trim(c.linkedin_url),'')),
  ('linkedin_member_id', NULLIF(trim(c.linkedin_member_id),'')),
  ('hubspot',            NULLIF(trim(c.hubspot_id),'')),
  ('pipedrive',          NULLIF(trim(c.pipedrive_id),'')),
  ('apollo',             NULLIF(trim(c.apollo_id),''))
) AS k(kind, value)
WHERE k.value IS NOT NULL
  AND c.id IN (SELECT id FROM entities)
  AND NOT EXISTS (
    SELECT 1 FROM entity_identifiers ei
    WHERE ei.workspace_id = c.workspace_id
      AND ei.kind = k.kind
      AND ei.value = k.value
  );

-- VERIFY: how many contacts vs identifiers
-- SELECT 'contacts',           count(*) FROM contacts
-- UNION ALL SELECT 'email idents',     count(*) FROM entity_identifiers WHERE kind = 'email'
-- UNION ALL SELECT 'linkedin idents',  count(*) FROM entity_identifiers WHERE kind = 'linkedin_url';
