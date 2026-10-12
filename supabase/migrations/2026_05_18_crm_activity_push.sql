-- Activity push from Nous → CRMs (HubSpot Engagements, Pipedrive Activities, Attio Notes).
-- Safe to re-run.

-- Identity cache columns on contacts (hubspot_id already exists)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pipedrive_id  TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS attio_id      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS salesforce_id TEXT;

CREATE INDEX IF NOT EXISTS contacts_pipedrive_id  ON contacts(pipedrive_id)  WHERE pipedrive_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_attio_id      ON contacts(attio_id)      WHERE attio_id      IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_salesforce_id ON contacts(salesforce_id) WHERE salesforce_id IS NOT NULL;

-- Per-connection toggle for activity push. Default ON for new rows; existing rows keep their explicit choice via UI.
ALTER TABLE crm_sync_configs ADD COLUMN IF NOT EXISTS push_activities BOOLEAN DEFAULT true;
