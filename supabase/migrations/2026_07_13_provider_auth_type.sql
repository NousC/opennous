-- auth_type: say how a provider is actually connected, in the database.
--
-- Both the API and the frontend branch on this column to decide whether to show a
-- "Connect" button or an API-key form. It was NULL on most rows and held three
-- undocumented spellings on the rest, so that branch either never fired or fired on
-- a value nothing else understood — and each surface quietly fell back to its own
-- hardcoded list of provider names. The lists then drifted from each other and from
-- this table: Salesforce ships a complete PKCE flow that the catalogue filtered out,
-- and Gmail rendered a key form because one list said "gmail" while the OAuth
-- provider is named "gmail_oauth".
--
-- Populating this makes the database the single answer to "how does this connect",
-- which is the only way the two surfaces can't disagree again.
--
--   oauth2      — we hold an OAuth app; the user clicks Connect and authorises.
--   api_key     — the user pastes a key (or a bearer token — same form, same flow).
--                 The ceiling for most outbound tools: Instantly, Smartlead, Lemlist,
--                 HeyReach and EmailBison do not offer OAuth to third parties at all,
--                 so this is not a gap we can close by building more.
--   credentials — a multi-field form (SMTP/IMAP host, port, username, password).
--   none        — nothing to connect.
--
-- Only providers with a working OAuth handler MOUNTED are marked oauth2. HubSpot,
-- Pipedrive and Attio DO offer OAuth but we have not built it yet, so they stay
-- api_key — marking them oauth2 here would render a Connect button that 404s.

-- ── 1. Normalise the legacy spellings BEFORE the constraint. ──────────────────
--
-- Live rows already hold values the new CHECK does not allow, and none of them are
-- NULL, so the catch-all below would sail straight past them and the ALTER at the
-- bottom would abort the whole migration:
--
--   'bearer' — attio, hubspot, clickup. A bearer token IS a pasted key. Same form,
--              same storage, same test. The distinction never bought us anything.
--   'smtp'   — the `smtp` provider and the legacy `gmail` one (app-password SMTP,
--              as opposed to `gmail_oauth`). Both are the multi-field host/port form.
--
UPDATE workflow_providers SET auth_type = 'api_key'     WHERE auth_type = 'bearer';
UPDATE workflow_providers SET auth_type = 'credentials' WHERE auth_type = 'smtp';

-- ── 2. Say how each provider we actually ship connects. ───────────────────────
UPDATE workflow_providers SET auth_type = 'oauth2'
 WHERE name IN ('gmail_oauth', 'slack', 'salesforce', 'airtable');

UPDATE workflow_providers SET auth_type = 'credentials'
 WHERE name = 'smtp';

-- Everything else is a pasted key. Set it explicitly rather than leaving NULL so
-- that "NULL" means "someone added a provider and forgot", not "API key".
UPDATE workflow_providers SET auth_type = 'api_key'
 WHERE auth_type IS NULL;

-- ── 3. Stop offering providers we never built. ────────────────────────────────
--
-- outlook_oauth is marked oauth2, has no handler mounted anywhere in index.mjs, and
-- is not hidden — so it renders a Connect button that 404s, which is precisely the
-- failure this column exists to prevent.
--
-- notion, granola and google_analytics are the same story with one difference: they
-- were invisible, but only because the FRONTEND happened to carry them in a
-- hardcoded EXCLUDED list. (SettingsModal even builds authorize URLs for notion and
-- google-analytics — routes that are not mounted either.) That list is the same
-- fragile arrangement this column exists to replace, and it is being deleted, so
-- their real state has to live here now.
--
-- The honest state is "we don't support these yet", and is_active is the column every
-- catalogue query already filters on. Flip a row back the day its handler lands.
--
-- Note the ones NOT in this list: mailchimp, openai, anthropic, google, stripe and
-- clickup are real api_key providers that simply aren't GTM surfaces, and rb2b is
-- webhook-only. Those are catalogue-visibility decisions, not broken-connect ones, so
-- they stay active in the database and the catalogue decides whether to show them.
UPDATE workflow_providers SET is_active = false
 WHERE name IN ('outlook_oauth', 'notion', 'granola', 'google_analytics');

-- ── 4. Now the constraint can hold. ───────────────────────────────────────────
ALTER TABLE workflow_providers
  DROP CONSTRAINT IF EXISTS workflow_providers_auth_type_check;

ALTER TABLE workflow_providers
  ADD CONSTRAINT workflow_providers_auth_type_check
  CHECK (auth_type IN ('oauth2', 'api_key', 'credentials', 'none'));
