-- LinkedIn Connections funnel: extend the leads view `status` so the connect →
-- message → reply funnel surfaces as clear stages. Two new stages are added,
-- ordered AFTER email 'sent' so existing email lists are unaffected (a lead only
-- reaches 'messaged'/'connected' if it carries the new LinkedIn observations):
--   'messaged'  — interaction.linkedin_message_sent (we DM'd them; first contact)
--   'connected' — interaction.linkedin_connected     (accepted, not yet messaged)
-- Every other column is reproduced verbatim from the live view definition.
CREATE OR REPLACE VIEW leads AS
 SELECT e.id,
    ce.collection_id AS lead_list_id,
    e.workspace_id,
    (SELECT entity_identifiers.value FROM entity_identifiers
      WHERE entity_identifiers.entity_id = e.id AND entity_identifiers.kind = 'email' AND entity_identifiers.status = 'active' LIMIT 1) AS email,
    TRIM(BOTH ' ' FROM concat(
      COALESCE((SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'first_name' AND claims.invalid_at IS NULL LIMIT 1), ''),
      ' ',
      COALESCE((SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'last_name' AND claims.invalid_at IS NULL LIMIT 1), ''))) AS name,
    (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'company' AND claims.invalid_at IS NULL LIMIT 1) AS company,
    (SELECT entity_identifiers.value FROM entity_identifiers WHERE entity_identifiers.entity_id = e.id AND entity_identifiers.kind = 'linkedin_url' AND entity_identifiers.status = 'active' LIMIT 1) AS linkedin_url,
    (SELECT min(observations.observed_at) FROM observations WHERE observations.entity_id = e.id AND observations.property = 'interaction.email_sent') AS sent_at,
    (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'send_variant' AND claims.invalid_at IS NULL LIMIT 1) AS send_variant,
    COALESCE(((SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'is_repeat_contact' AND claims.invalid_at IS NULL LIMIT 1))::boolean, false) AS is_repeat_contact,
    COALESCE((SELECT claims.value FROM claims WHERE claims.entity_id = e.id AND claims.property = 'features' AND claims.invalid_at IS NULL LIMIT 1), '{}'::jsonb) AS features,
    COALESCE((SELECT claims.value FROM claims WHERE claims.entity_id = e.id AND claims.property = 'fields' AND claims.invalid_at IS NULL LIMIT 1), '{}'::jsonb) AS fields,
    ((SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'scorecard_score' AND claims.invalid_at IS NULL LIMIT 1))::integer AS scorecard_score,
    (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'sentiment' AND claims.invalid_at IS NULL LIMIT 1) AS reply_outcome,
    (SELECT max(observations.observed_at) FROM observations WHERE observations.entity_id = e.id AND observations.property = ANY (ARRAY['interaction.reply','interaction.positive_reply','interaction.negative_reply','interaction.linkedin_reply'])) AS replied_at,
    COALESCE(
      CASE
        WHEN (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'reachability_status' AND claims.invalid_at IS NULL LIMIT 1) = 'bounced' THEN 'bounced'
        WHEN EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = e.id AND observations.property = ANY (ARRAY['interaction.reply','interaction.positive_reply','interaction.negative_reply','interaction.linkedin_reply'])) THEN 'replied'
        WHEN EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = e.id AND observations.property = 'interaction.email_sent') THEN 'sent'
        WHEN EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = e.id AND observations.property = 'interaction.linkedin_message_sent') THEN 'messaged'
        WHEN EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = e.id AND observations.property = 'interaction.linkedin_connected') THEN 'connected'
        ELSE 'pending'
      END, 'pending') AS status,
    CASE WHEN EXISTS (SELECT 1 FROM observations WHERE observations.entity_id = e.id LIMIT 1) THEN e.id ELSE NULL::uuid END AS contact_id,
    ce.added_at AS created_at,
    COALESCE((SELECT max(claims.computed_at) FROM claims WHERE claims.entity_id = e.id), ce.added_at) AS updated_at,
    (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'domain' AND claims.invalid_at IS NULL LIMIT 1) AS domain,
    (SELECT claims.value #>> '{}'::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = 'reachability_status' AND claims.invalid_at IS NULL LIMIT 1) AS email_status,
    (SELECT observations.source FROM observations
      WHERE observations.entity_id = e.id AND observations.kind = 'event' AND observations.property ~~ 'interaction.%'
        AND observations.property <> 'interaction.enrichment_run' AND (observations.source <> ALL (ARRAY['prospeo','apollo']))
      ORDER BY observations.observed_at DESC LIMIT 1) AS last_channel,
    ce.source
   FROM entities e
     JOIN collection_entities ce ON ce.entity_id = e.id
     JOIN collections c ON c.id = ce.collection_id AND c.kind = 'list'
  WHERE e.type = 'person' AND e.status = 'active';
