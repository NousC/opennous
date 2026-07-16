-- Add EmailBison to workflow_providers so the connect flow can resolve a provider_id.
-- Safe to re-run.
INSERT INTO workflow_providers (name, display_name, category)
VALUES ('emailbison', 'EmailBison', 'outbound')
ON CONFLICT (name) DO NOTHING;
