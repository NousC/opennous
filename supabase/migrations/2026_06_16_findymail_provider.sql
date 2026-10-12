-- Register Findymail as an enrichment provider (BYOK email-finder rung in the
-- enrichment waterfall) so the connect flow can resolve a provider_id and the
-- enrichment dispatcher's getFindymailEnrichmentKey() can find the workspace's
-- own key. Category 'enrichment' (find email) — distinct from 'verification'.
-- Findymail is BYOK only; Nous funds no built-in key. Safe to re-run.
INSERT INTO workflow_providers (name, display_name, category)
VALUES
  ('findymail', 'Findymail', 'enrichment')
ON CONFLICT (name) DO NOTHING;
