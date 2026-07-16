-- Lead list outbound foundation: surface domain, email verification status,
-- and last channel on the leads view so the list shows the full outbound
-- record. Column set is otherwise unchanged; the leads write triggers are
-- unaffected (they're INSTEAD OF triggers on the view).

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
   (SELECT source FROM observations WHERE entity_id = e.id AND kind = 'event' AND property LIKE 'interaction.%' ORDER BY observed_at DESC LIMIT 1) AS last_channel
 FROM entities e
   JOIN collection_entities ce ON ce.entity_id = e.id
   JOIN collections c ON c.id = ce.collection_id AND c.kind = 'list'
 WHERE e.type = 'person' AND e.status = 'active';

-- Recreate the sortable read RPC so its RETURNS SETOF leads picks up the new
-- columns (domain / email_status / last_channel). Body unchanged.
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
