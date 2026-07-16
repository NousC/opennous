-- Provider setup metadata: everything the connect form needs to hold the user's hand.
--
-- Connecting Instantly should be: click Connect, click "Get your API key" (which lands
-- on the exact page in Instantly where the key is, not their docs homepage), paste,
-- done — and the webhook registers itself off that same key. That is the whole feature.
--
-- Three of these four columns exist purely so the UI never has to know a provider's
-- name to render its form. That is the rule the rest of the integrations work is
-- enforcing: the database says how a provider connects, and the surfaces just read it.
--
--   key_url              Deep link into the provider's app, on the page where the key is
--                        actually issued. Not a docs link. The user should land on it and
--                        see the button they need.
--   key_hint             The click-path in words ("Settings → Integrations → API Keys"),
--                        because deep links rot and a sentence survives a redesign.
--   webhook_mode         What happens to the webhook once we hold the key:
--                          auto   — we POST to their webhook API on connect. Nothing to do.
--                          manual — their API cannot create one, so the user pastes ours
--                                   into their UI. We show the URL and a link to the page.
--                          none   — the provider has no webhooks (enrichment, verification).
--   webhook_settings_url Deep link to the page where a manual webhook gets pasted.
--                        Only meaningful when webhook_mode = 'manual'.
--
-- Seeded from apps/api/src/providers/catalogue.mjs on every boot, which is the single
-- source of truth. Do not hand-edit these values in the database: the next deploy will
-- overwrite them from the catalogue, which is the point.

ALTER TABLE workflow_providers
  ADD COLUMN IF NOT EXISTS key_url              TEXT,
  ADD COLUMN IF NOT EXISTS key_hint             TEXT,
  ADD COLUMN IF NOT EXISTS webhook_mode         TEXT,
  ADD COLUMN IF NOT EXISTS webhook_settings_url TEXT;

ALTER TABLE workflow_providers
  DROP CONSTRAINT IF EXISTS workflow_providers_webhook_mode_check;

ALTER TABLE workflow_providers
  ADD CONSTRAINT workflow_providers_webhook_mode_check
  CHECK (webhook_mode IS NULL OR webhook_mode IN ('auto', 'manual', 'none'));
