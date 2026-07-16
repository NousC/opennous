-- Add Salesforce to workflow_providers so OAuth flow can resolve a provider_id.
-- Safe to re-run.
INSERT INTO workflow_providers (name, display_name, category)
VALUES ('salesforce', 'Salesforce', 'crm')
ON CONFLICT (name) DO NOTHING;
