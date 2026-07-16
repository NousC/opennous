-- Channel column should reflect outreach/export, NOT enrichment. Enrichment runs
-- log an `interaction.enrichment_run` observation with source 'prospeo'/'apollo',
-- which was hijacking last_channel (showing "Prospeo" on enriched leads). Exclude
-- enrichment from the last_channel computation. View body otherwise unchanged.

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
   -- verification status, and the channel of the most recent OUTREACH interaction
   -- (enrichment runs excluded, so the column reflects where the lead was contacted
   -- or exported, not that we enriched them).
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'domain' AND invalid_at IS NULL LIMIT 1) AS domain,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'reachability_status' AND invalid_at IS NULL LIMIT 1) AS email_status,
   (SELECT source FROM observations
      WHERE entity_id = e.id AND kind = 'event' AND property LIKE 'interaction.%'
        AND property <> 'interaction.enrichment_run'
        AND source NOT IN ('prospeo', 'apollo')
      ORDER BY observed_at DESC LIMIT 1) AS last_channel
 FROM entities e
   JOIN collection_entities ce ON ce.entity_id = e.id
   JOIN collections c ON c.id = ce.collection_id AND c.kind = 'list'
 WHERE e.type = 'person' AND e.status = 'active';
