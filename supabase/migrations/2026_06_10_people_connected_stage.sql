-- People page: only people who REPLIED; formalize the "connected" stage.
--
-- One change to the `contacts` view's WHERE filter (column list/order are
-- unchanged, so the INSTEAD OF triggers keep working): add 'connected' to the
-- set of pipeline stages kept OUT of People. An accepted LinkedIn connection
-- with no conversation yet is a real, agent-curable stage, but it must not
-- flood the People list with hundreds of cold connections. It stays queryable
-- via the agent (observations / get_account) and via a stage filter.
--
-- The LinkedIn-message clause stays INBOUND-only (is_outbound = false): People
-- is the set of people who actually answered us, not everyone we reached out
-- to. An outbound message we send never graduates anyone; a received reply
-- does (and also advances their stage to 'interested' via the stage engine).

CREATE OR REPLACE VIEW contacts AS
 SELECT
   id,
   workspace_id,
   created_at,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'email' AND status = 'active' LIMIT 1) AS email,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_url' AND status = 'active' LIMIT 1) AS linkedin_url,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'linkedin_member_id' AND status = 'active' LIMIT 1) AS linkedin_member_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'hubspot' AND status = 'active' LIMIT 1) AS hubspot_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'pipedrive' AND status = 'active' LIMIT 1) AS pipedrive_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'apollo' AND status = 'active' LIMIT 1) AS apollo_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'rb2b' AND status = 'active' LIMIT 1) AS rb2b_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'attio' AND status = 'active' LIMIT 1) AS attio_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'salesforce' AND status = 'active' LIMIT 1) AS salesforce_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'crm' AND status = 'active' LIMIT 1) AS crm_record_id,
   (SELECT value FROM entity_identifiers WHERE entity_id = e.id AND kind = 'stripe' AND status = 'active' LIMIT 1) AS stripe_customer_id,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'first_name' AND invalid_at IS NULL LIMIT 1) AS first_name,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'last_name' AND invalid_at IS NULL LIMIT 1) AS last_name,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'job_title' AND invalid_at IS NULL LIMIT 1) AS job_title,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'seniority' AND invalid_at IS NULL LIMIT 1) AS seniority,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'department' AND invalid_at IS NULL LIMIT 1) AS department,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'city' AND invalid_at IS NULL LIMIT 1) AS city,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'country' AND invalid_at IS NULL LIMIT 1) AS country,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'phone' AND invalid_at IS NULL LIMIT 1) AS phone,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'company' AND invalid_at IS NULL LIMIT 1) AS company,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'photo_url' AND invalid_at IS NULL LIMIT 1) AS photo_url,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'domain' AND invalid_at IS NULL LIMIT 1) AS domain,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'industry' AND invalid_at IS NULL LIMIT 1) AS industry,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'company_size' AND invalid_at IS NULL LIMIT 1) AS company_size,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'connection_strength' AND invalid_at IS NULL LIMIT 1) AS connection_strength,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage' AND invalid_at IS NULL LIMIT 1) AS pipeline_stage,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage_source' AND invalid_at IS NULL LIMIT 1) AS pipeline_stage_source,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'pipeline_stage_updated_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS pipeline_stage_updated_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'source' AND invalid_at IS NULL LIMIT 1) AS source,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'source_tag' AND invalid_at IS NULL LIMIT 1) AS source_tag,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'status' AND invalid_at IS NULL LIMIT 1) AS status,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'lead_source' AND invalid_at IS NULL LIMIT 1) AS lead_source,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'first_seen_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS first_seen_at,
   (SELECT max(observed_at) FROM observations WHERE entity_id = e.id AND kind = 'event' AND observed_at <= now()) AS last_activity_at,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'last_interaction_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS last_interaction_at,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'last_document_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS last_document_at,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_health_score' AND invalid_at IS NULL LIMIT 1))::integer AS deal_health_score,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_health_active_max' AND invalid_at IS NULL LIMIT 1))::integer AS deal_health_active_max,
   (SELECT value FROM claims WHERE entity_id = e.id AND property = 'deal_health_breakdown' AND invalid_at IS NULL LIMIT 1) AS deal_health_breakdown,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_health_computed_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_health_computed_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_stage' AND invalid_at IS NULL LIMIT 1) AS deal_stage,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_value' AND invalid_at IS NULL LIMIT 1))::numeric AS deal_value,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_closed_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_closed_at,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'deal_sent_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS deal_sent_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'enrichment_status' AND invalid_at IS NULL LIMIT 1) AS enrichment_status,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'enrichment_source' AND invalid_at IS NULL LIMIT 1) AS enrichment_source,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'enriched_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS enriched_at,
   ((SELECT predicted_value ->> 'score' FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1))::integer AS icp_score,
   ((SELECT predicted_value ->> 'fit' FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1))::boolean AS icp_fit,
   (SELECT predicted_value ->> 'reason' FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1) AS icp_reasoning,
   (SELECT predicted_at FROM predictions WHERE entity_id = e.id AND kind = 'icp_fit' ORDER BY predicted_at DESC LIMIT 1) AS icp_scored_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'memory_summary' AND invalid_at IS NULL LIMIT 1) AS memory_summary,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'summary_generated_at' AND invalid_at IS NULL LIMIT 1))::timestamptz AS summary_generated_at,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'notes' AND invalid_at IS NULL LIMIT 1) AS notes,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'keywords' AND invalid_at IS NULL LIMIT 1) AS keywords,
   (SELECT value FROM claims WHERE entity_id = e.id AND property = 'channels' AND invalid_at IS NULL LIMIT 1) AS channels,
   (SELECT value FROM claims WHERE entity_id = e.id AND property = 'tags' AND invalid_at IS NULL LIMIT 1) AS tags,
   (SELECT value FROM claims WHERE entity_id = e.id AND property = 'apollo_raw' AND invalid_at IS NULL LIMIT 1) AS apollo_raw,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'interaction_count' AND invalid_at IS NULL LIMIT 1))::integer AS interaction_count,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'incoming_contacts_count' AND invalid_at IS NULL LIMIT 1))::integer AS incoming_contacts_count,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'total_documents_count' AND invalid_at IS NULL LIMIT 1))::integer AS total_documents_count,
   ((SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'total_income' AND invalid_at IS NULL LIMIT 1))::numeric AS total_income,
   (SELECT value #>> '{}'::text[] FROM claims WHERE entity_id = e.id AND property = 'total_income_source' AND invalid_at IS NULL LIMIT 1) AS total_income_source,
   (SELECT to_entity_id FROM relationships WHERE from_entity_id = e.id AND type = 'works_at' AND valid_to IS NULL LIMIT 1) AS company_id,
   NULL::uuid AS created_by,
   COALESCE((SELECT max(computed_at) FROM claims WHERE entity_id = e.id), created_at) AS updated_at
 FROM entities e
 WHERE e.type = 'person' AND e.status = 'active'
   AND (
     -- People = someone you've actually engaged or messaged, not merely
     -- connected with or scraped.
     EXISTS (
       SELECT 1 FROM observations o
       WHERE o.entity_id = e.id AND o.kind = 'event' AND (
         o.property IN (
           'interaction.reply', 'interaction.email_reply', 'interaction.email_replied',
           'interaction.email_received', 'interaction.outbound_positive_reply',
           'interaction.linkedin_message_received',
           'interaction.meeting_held', 'interaction.meeting_scheduled',
           'interaction.call', 'interaction.call_held',
           'interaction.deal_won', 'interaction.deal_lost', 'interaction.deal_disqualified',
           'interaction.proposal_sent', 'interaction.proposal_signed',
           'interaction.payment_received', 'interaction.subscription_started',
           'interaction.subscription_updated', 'interaction.subscription_canceled',
           'interaction.signed_up'
         )
         -- a LinkedIn message graduates the person only when it's INBOUND (one we
         -- RECEIVED — i.e. they replied). Outbound messages we send do NOT qualify:
         -- People is the set of people who actually answered, not everyone we
         -- reached out to. A bare connection (no reply yet) also does NOT qualify.
         OR (o.property = 'interaction.linkedin_message'
             AND COALESCE((o.raw ->> 'is_outbound')::boolean, false) = false)
       )
     )
     -- ...or they're in your CRM / a customer
     OR EXISTS (
       SELECT 1 FROM entity_identifiers ei
       WHERE ei.entity_id = e.id AND ei.status = 'active'
         AND ei.kind IN ('hubspot', 'salesforce', 'pipedrive', 'attio', 'crm', 'stripe')
     )
     -- ...or the pipeline advanced past the top of funnel (interested+). 'connected'
     -- is an accepted LinkedIn connection with no conversation yet — kept OUT of
     -- People (it would flood the list) but still a real, agent-curable stage.
     OR COALESCE(
       (SELECT value #>> '{}'::text[] FROM claims
        WHERE entity_id = e.id AND property = 'pipeline_stage' AND invalid_at IS NULL LIMIT 1),
       'identified'
     ) NOT IN ('identified', 'aware', 'cold', 'engaged', 'connected')
     -- ...or you added them yourself
     OR EXISTS (
       SELECT 1 FROM observations o WHERE o.entity_id = e.id AND o.source = 'manual'
     )
   );
