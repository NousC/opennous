-- Per-activity CRM push idempotency: prevents the same activity from being pushed twice
-- (e.g. webhook redelivery without external_id, race in logActivity, manual replay).
-- Also doubles as a back-reference: pushed_to_crms = { hubspot: "12345", attio: "rec_abc" }.
ALTER TABLE contact_activity_log
  ADD COLUMN IF NOT EXISTS pushed_to_crms JSONB NOT NULL DEFAULT '{}'::jsonb;
