-- Built-in email verification: register MillionVerifier + NeverBounce as
-- workflow providers so the BYOK connect flow can resolve a provider_id and the
-- lead-list "Verify emails" action can find the workspace's own verifier key.
-- Category 'verification' is distinct from 'enrichment' (find email) — verify
-- validates deliverability of an email we already have. Safe to re-run.
INSERT INTO workflow_providers (name, display_name, category)
VALUES
  ('millionverifier', 'MillionVerifier', 'verification'),
  ('neverbounce',     'NeverBounce',     'verification')
ON CONFLICT (name) DO NOTHING;
