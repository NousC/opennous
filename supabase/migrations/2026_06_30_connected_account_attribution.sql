-- Connected-account attribution (Phase C).
--
-- Goal: know which team MEMBER a connected mailbox belongs to, so every email
-- touch can be attributed to the rep it came through. LinkedIn connections
-- already carry owner_user_id (workspace_linkedin_connections); this brings
-- mailboxes (Gmail OAuth + custom SMTP, both in workflow_provider_connections)
-- to the same shape.
--
-- Idempotent: safe to re-run.

-- 1. Who owns this connected mailbox, and what address is it.
ALTER TABLE workflow_provider_connections
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE workflow_provider_connections
  ADD COLUMN IF NOT EXISTS account_email TEXT;

-- 2. Backfill owner from created_by (the member who connected it is its owner
--    until reassigned). created_by is NOT NULL, so this fills every existing row.
UPDATE workflow_provider_connections
  SET owner_user_id = created_by
  WHERE owner_user_id IS NULL;

-- 3. Backfill the address from the credentials blob where it is stored PLAINTEXT.
--    Gmail OAuth stores `email` plaintext; the generic SMTP path AES-encrypts
--    every value (stored as `hex:hex`). So only backfill values that look like a
--    real email and are NOT encrypted (an encrypted value contains a ':'). SMTP
--    rows fill their account_email going forward at connect time instead.
UPDATE workflow_provider_connections
  SET account_email = lower(encrypted_credentials->>'email')
  WHERE account_email IS NULL
    AND encrypted_credentials->>'email' LIKE '%@%'
    AND encrypted_credentials->>'email' NOT LIKE '%:%';

-- Lookups by owner (per-rep filtering) and by address (attribution at ingestion).
CREATE INDEX IF NOT EXISTS idx_wpc_owner
  ON workflow_provider_connections (workspace_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_wpc_account_email
  ON workflow_provider_connections (workspace_id, account_email);
