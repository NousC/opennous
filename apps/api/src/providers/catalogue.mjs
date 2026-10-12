/**
 * The provider catalogue. One file that answers, for every integration we ship:
 * how it authenticates, where the user's key actually lives, and what happens to the
 * webhook once we hold that key.
 *
 * WHY THIS EXISTS
 *
 * That knowledge used to be spread across five hardcoded lists — NAMED_PROVIDERS in the
 * API, HARDCODED_PROVIDERS and EXCLUDED and an isOAuth name-list in Integrations.tsx, and
 * another isOAuth name-list in SettingsModal.tsx — plus the workflow_providers table.
 * Six sources, no owner. They drifted, and every integration bug we have chased was that
 * drift: Salesforce shipped a working PKCE flow the catalogue filtered out; Gmail rendered
 * a paste-a-key form because one list said "gmail" while the provider is named
 * "gmail_oauth"; Slack's Connect button called a path its router never answered; aiark,
 * blitz and leadmagic 404'd on connect because they were missing from NAMED_PROVIDERS.
 *
 * So: this file is the truth, it is seeded into workflow_providers on every boot, and
 * every surface reads the database. No surface may branch on a provider's NAME again. If
 * you find yourself typing `if (name === '...')` in a route or a component, the thing you
 * want is a field here.
 *
 * THE GOAL IT SERVES
 *
 * Connecting Instantly should be: click Connect, click "Get your API key" and land on the
 * exact page where the key is, paste it, done — and the webhook registers itself off that
 * same key. Nobody should ever copy a URL out of our UI into someone else's settings page
 * unless that provider gives us no other choice.
 *
 * FIELDS
 *
 *   auth      'oauth2'      we hold an OAuth app; the user clicks Connect.
 *                           ONLY set this if a handler is mounted in index.mjs, or the UI
 *                           renders a Connect button that 404s.
 *             'api_key'     one pasted key.
 *             'credentials' a multi-field form; supply authFields.
 *
 *   keyUrl    Deep link into the provider's app, on the page where the key is issued. Not
 *             a docs link. NULL where we could not confirm a real URL — a button that
 *             404s is worse than no button, and keyHint still tells them where to go.
 *
 *   keyHint   The click-path in words. Always set, because deep links rot and a sentence
 *             survives a redesign.
 *
 *   webhook   'auto'    we create it via their API on connect. Nothing for the user to do.
 *                       Requires an entry in WEBHOOK_HANDLERS *and* an /inbound route on
 *                       the worker — registering a webhook we don't serve is worse than
 *                       not registering one, because it looks like it worked.
 *             'manual'  their API cannot create one. We show our URL and a link to the
 *                       page where it gets pasted. This is a ceiling, not a TODO.
 *             'none'    the provider has no webhooks, or none we want.
 *
 *   webhookUrl   Where a 'manual' webhook gets pasted, in their app.
 *   webhookNote  What to tell the user about a 'manual' or plan-gated webhook.
 *   hidden       Real provider, deliberately not offered in the catalogue.
 *
 *   scope     WHOSE tool this is, and therefore who connects it and what it produces.
 *
 *             'workspace'  One connection covers the company. A CRM, an outbound sequencer,
 *                          Stripe: the founder or RevOps connects it once and every seat
 *                          reads the same pipeline. Backfilling one of these reconstructs
 *                          the whole book — which is what the revenue report and the
 *                          win/loss analysis are built on.
 *
 *             'personal'   One connection covers ONE person. A notetaker only holds the
 *                          calls you were in; a mailbox only holds your threads; a calendar
 *                          only your meetings. Every seat connects their own, and the
 *                          backfill produces THEIR activity, not the company's.
 *
 *             This is not cosmetic. It decides what we ask a founder for versus a rep, what
 *             a seat's backfill can honestly claim to cover, and why a report says "this is
 *             your view, not the team's" when only personal sources are connected.
 */

import { WEBHOOK_HANDLERS } from './webhooks.mjs';

const SMTP_FIELDS = [
  { name: 'host',      label: 'Mail server host',     type: 'text',     placeholder: 'smtp.yourdomain.com',   description: "Your provider's SMTP host. We derive the IMAP host automatically (smtp. → imap.)." },
  { name: 'port',      label: 'SMTP port',            type: 'text',     placeholder: '587',                   description: '587 (STARTTLS) or 465 (SSL). Leave blank for 587.', optional: true },
  { name: 'username',  label: 'Email address',        type: 'text',     placeholder: 'you@yourdomain.com',    description: 'The mailbox we poll for incoming messages.' },
  { name: 'password',  label: 'Password',             type: 'password', placeholder: 'app-specific password', description: "For Gmail / Outlook, generate an app password — your login password won't work." },
  { name: 'imap_host', label: 'IMAP host (optional)', type: 'text',     placeholder: 'imap.yourdomain.com',   description: "Only needed if your IMAP host doesn't match the smtp. → imap. pattern.", optional: true },
  { name: 'imap_port', label: 'IMAP port (optional)', type: 'text',     placeholder: '993',                   description: 'Defaults to 993 (SSL).', optional: true },
];

const FELLOW_FIELDS = [
  { name: 'api_key',   label: 'API key',             type: 'password', placeholder: 'Paste your Fellow API key', description: 'User settings → Developer API → create a key with Super Admin access, so every meeting in your Fellow workspace comes in. It is shown once.' },
  { name: 'subdomain', label: 'Workspace subdomain', type: 'text',     placeholder: 'acme',                      description: 'The part before .fellow.app in your Fellow address — for acme.fellow.app, enter acme.' },
];

const RINGCENTRAL_FIELDS = [
  { name: 'jwt',           label: 'JWT credential',          type: 'password', placeholder: 'Paste the JWT', description: 'RingCentral Developer Console → Credentials → Create JWT, as a Super Admin service user, restricted to the OpenNous app. It is shown once.' },
  { name: 'client_id',     label: 'Client ID (optional)',     type: 'text',     placeholder: 'Only for your own RingCentral app', description: 'Leave empty to connect through the OpenNous app. Fill in only if your admin created a private app for us.', optional: true },
  { name: 'client_secret', label: 'Client secret (optional)', type: 'password', placeholder: 'Only with your own client ID', description: "Your private app's client secret, if you entered a client ID.", optional: true },
];

export const CATALOGUE = {
  // ── Outbound ──────────────────────────────────────────────────────────────
  instantly: {
    display: 'Instantly', category: 'outbound', auth: 'api_key',
    keyUrl:  'https://app.instantly.ai/app/settings/integrations',
    keyHint: 'Settings → Integrations → API Keys → Create API Key. Make a V2 key; V1 keys do not work.',
    webhook: 'auto',
    // The key needs a webhooks scope (webhooks:create / webhooks:all / all:*). A narrow
    // key connects fine and then 403s on the webhook, which we report rather than hide.
    webhookNote: 'If your API key was created with limited scopes, Instantly will refuse the webhook. Recreate the key with webhook access and reconnect.',
  },
  lemlist: {
    display: 'lemlist', category: 'outbound', auth: 'api_key',
    keyUrl:  null,   // Documented as a click-path only; no URL we can confirm.
    keyHint: 'Profile picture (bottom left) → Settings → Integrations → Generate a new API key. It is shown once.',
    webhook: 'auto',
  },
  heyreach: {
    display: 'HeyReach', category: 'outbound', auth: 'api_key',
    keyUrl:  null,
    keyHint: 'Integrations (left sidebar) → Make → Connect Now → New API Key.',
    webhook: 'auto',
  },
  smartlead: {
    display: 'Smartlead', category: 'outbound', auth: 'api_key',
    keyUrl:  null,
    keyHint: 'Settings → Activate API → Generate API Key. If you do not see "Activate API", your plan does not include it.',
    // Smartlead documents TWO different webhook endpoints with two different event
    // vocabularies that contradict each other, and the account-level one is only in a
    // guide, not the reference. Registering against the wrong one fails silently, which
    // is the exact failure mode we are trying to end. Manual until a live key settles it.
    webhook: 'manual',
    webhookUrl: null,
    webhookNote: 'Smartlead binds webhooks to a campaign, so add this URL to each campaign you want flowing into Nous.',
  },
  emailbison: {
    display: 'EmailBison', category: 'outbound', auth: 'api_key',
    // EmailBison is white-labelled and self-hostable, so every customer is on their own
    // host. There is no single URL that could be right for everyone.
    keyUrl:  null,
    keyHint: 'On your EmailBison instance: Settings → Developer API → New API Token. Choose an api-user token, not super-admin.',
    webhook: 'manual',
    webhookUrl: null,
    webhookNote: 'On your instance: Settings → Webhooks → New Webhook URL.',
  },

  // ── Meetings ──────────────────────────────────────────────────────────────
  calendly: {
    display: 'Calendly', category: 'meetings', auth: 'api_key',
    keyUrl:  'https://calendly.com/integrations/api_webhooks',
    keyHint: 'Integrations → API & Webhooks → Generate new token. It is shown once.',
    webhook: 'auto',
    webhookNote: 'Calendly only allows webhooks on Standard plans and above. On a free plan we still import your meetings, just not in realtime.',
  },
  cal_com: {
    display: 'Cal.com', category: 'meetings', auth: 'api_key',
    keyUrl:  'https://app.cal.com/settings/developer/api-keys',
    keyHint: 'Settings → Developer → API keys → Add.',
    webhook: 'auto',
  },
  fathom: {
    display: 'Fathom', category: 'meetings', auth: 'api_key',
    keyUrl:  'https://fathom.video/customize#api-access-header',
    keyHint: 'Settings → API Access → generate an API key.',
    // Fathom's webhook-create API did not reliably register a destination for us:
    // connections came back with an api_key but no webhook_id, and Fathom's own UI
    // showed no webhook — so 'auto' reported success while nothing was ever wired up
    // and no meeting reached us. Manual is the honest, working path: we hand the user
    // the inbound URL and they paste it into Fathom's own Add Webhook form.
    webhook: 'manual',
    webhookUrl: 'https://fathom.video/customize#api-access-header',
    // Fathom keys are user-scoped, not workspace-scoped.
    webhookNote: 'In Fathom → Settings → API Access → your API client → Add Webhook, paste the URL above as the Destination URL, keep the "My Recordings" scope on, and enable the Summary, Action items and Transcript events. Fathom keys only see meetings you recorded or that were shared with you, so each rep connects their own.',
  },
  fireflies: {
    display: 'Fireflies.ai', category: 'meetings', auth: 'api_key',
    keyUrl:  'https://app.fireflies.ai/settings/developer-settings',
    keyHint: 'Settings → Developer settings → copy your API key.',
    // Fireflies has no webhook mutation in its GraphQL API — not a gap on our side.
    webhook: 'manual',
    webhookUrl: 'https://app.fireflies.ai/integrations/api/webhook',
    webhookNote: 'Fireflies only fires webhooks for the meeting OWNER, so connect the account that organises the calls.',
  },
  granola: {
    display: 'Granola', category: 'meetings', auth: 'api_key',
    // Granola issues personal API keys inside the app (no confirmable web deep link).
    keyUrl:  null,
    keyHint: 'In Granola → Settings → Connectors → API keys → create a key. It starts with grn_ and is shown once.',
    // Granola's public API creates the webhook off our key (Standard Webhooks, HMAC-SHA256
    // signing secret returned once). It's gated to Business/Enterprise; on other plans the
    // subscribe 402/403/404s and we fall back to the poller — see subscribeGranola.
    webhook: 'auto',
    // Granola keys are personal (they see only the notes you own or that were shared with
    // you), so each rep connects their own — same shape as Fathom/Fireflies.
    webhookNote: 'Granola only offers webhooks on Business and Enterprise plans. On other plans we still import your notes on a schedule, just not in realtime. Granola keys are personal, so each person connects their own to bring in the meetings they attended.',
  },
  fellow: {
    display: 'Fellow', category: 'meetings',
    // Two fields, not one: Fellow's API lives on the customer's own subdomain
    // (https://{subdomain}.fellow.app/api/v1), so a key alone cannot reach anything.
    auth: 'credentials',
    authFields: FELLOW_FIELDS,
    // Issued under the user's own settings, on their own subdomain — no subdomain-free deep link.
    keyUrl:  null,
    keyHint: 'In Fellow → User settings → Developer API → create a key with Super Admin access (shown once), so we bring in every meeting in your Fellow workspace. A regular key only brings in the meetings its owner can see. No Developer API section? A workspace admin enables the API under Workspace settings → Security.',
    // Fellow's API creates the webhook off the key (svix-signed, secret returned once) and
    // challenge-verifies our URL on create. Workspaces can have webhooks switched off (503);
    // then the poller is the ingest path — see subscribeFellow.
    webhook: 'auto',
    webhookNote: 'One Fellow connection covers the whole team. With a Super Admin key we receive every meeting in the Fellow workspace; with a regular key, only the key owner\'s. If webhooks are not enabled on your Fellow workspace, meetings still import on a schedule, just not in realtime.',
  },
  ringcentral: {
    display: 'RingCentral', category: 'meetings',
    // JWT bearer auth (GET-289): the customer pastes a JWT made for a service user, restricted to
    // our RingCentral app (RINGCENTRAL_CLIENT_ID / _SECRET). A customer with their own private app
    // adds its client id + secret. One connection reads the whole company call log.
    auth: 'credentials',
    authFields: RINGCENTRAL_FIELDS,
    keyUrl:  process.env.RINGCENTRAL_CLIENT_ID
      ? `https://developers.ringcentral.com/console/my-credentials/create?client_id=${encodeURIComponent(process.env.RINGCENTRAL_CLIENT_ID)}`
      : 'https://developers.ringcentral.com/console/my-credentials',
    keyHint: 'Sign in to the RingCentral Developer Console as a Super Admin (ideally a service user, so the connection survives people leaving) → Credentials → Create JWT → restrict it to the OpenNous app → paste it here. We read your company call log and, if you have RingSense, its call transcripts.',
    // RingCentral has no account-level "call ended" event: the worker polls the company call log
    // every 5 minutes (pollers/ringcentral.mjs). Nothing to register.
    webhook: 'none',
    webhookNote: 'One RingCentral connection covers the whole company. Calls import every 5 minutes. Calls transcribed by RingSense are analysed and scored; other calls are logged on the contact with their duration and direction.',
  },

  // ── CRM ───────────────────────────────────────────────────────────────────
  salesforce: {
    display: 'Salesforce', category: 'crm', auth: 'oauth2',   // PKCE handler mounted in index.mjs
    keyHint: 'Sign in with Salesforce.',
    webhook: 'none',
  },
  hubspot: {
    display: 'HubSpot', category: 'crm', auth: 'api_key',
    keyUrl:  null,   // The private-app page is portal-scoped; no portal-free deep link.
    keyHint: 'Settings (gear) → Integrations → Private Apps → create an app → Auth → copy the access token.',
    // HubSpot's webhook API is app-level and needs a developer key — a private-app token
    // cannot create a subscription. Their docs say so outright. Manual is the ceiling
    // until we ship a public OAuth app.
    webhook: 'manual',
    webhookUrl: null,
    webhookNote: 'In your private app → Webhooks tab → paste this as the target URL.',
  },
  pipedrive: {
    display: 'Pipedrive', category: 'crm', auth: 'api_key',
    keyUrl:  'https://app.pipedrive.com/settings/api',
    keyHint: 'Settings → Personal preferences → API → copy your personal API token.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Removed from the catalogue on request. The gated CRMs are Salesforce, HubSpot and Attio.',
  },
  attio: {
    display: 'Attio', category: 'crm', auth: 'api_key',
    keyUrl:  null,   // app.attio.com/{workspace-slug}/settings/developers — slug is per-user.
    keyHint: 'Settings → Developers → New access token. You must be an admin.',
    // Same as Pipedrive: their API allows it, our worker has no /inbound/attio route yet.
    webhook: 'none',
  },

  // ── Enrichment ────────────────────────────────────────────────────────────
  apollo: {
    display: 'Apollo.io', category: 'enrichment', auth: 'api_key',
    keyUrl:  'https://developer.apollo.io/#/keys',
    keyHint: 'Settings → Integrations → API → Create new key.',
    webhook: 'none',   // Apollo takes a webhook_url per request; nothing to register.
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02). We do not run enrichment providers.',
  },
  prospeo: {
    display: 'Prospeo', category: 'enrichment', auth: 'api_key',
    keyUrl:  'https://app.prospeo.io/api',
    keyHint: 'API → copy your key.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02). We do not run enrichment providers.',
  },
  findymail: {
    display: 'Findymail', category: 'enrichment', auth: 'api_key',
    keyUrl:  'https://app.findymail.com/user/api-tokens',
    keyHint: 'Account → API tokens → create a token.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02). We do not run enrichment providers.',
  },
  aiark: {
    display: 'AI-Ark', category: 'enrichment', auth: 'api_key',
    keyUrl:  null,
    keyHint: 'AI-Ark dashboard → API.',
    webhook: 'none',   // aiark posts back per-job; the worker's /inbound/aiark takes that.
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02). We do not run enrichment providers.',
  },
  leadmagic: {
    display: 'LeadMagic', category: 'enrichment', auth: 'api_key',
    keyUrl:  null,
    keyHint: 'LeadMagic dashboard → API key.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02). We do not run enrichment providers.',
  },
  blitz: {
    display: 'Blitz', category: 'enrichment', auth: 'api_key',
    keyUrl:  null,
    keyHint: 'Blitz dashboard → API key.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Stub — no real integration wired (no API base URL, no key URL) and the brand is ambiguous. Removed from the catalogue until it is actually built.',
  },

  // ── Verification ──────────────────────────────────────────────────────────
  millionverifier: {
    display: 'MillionVerifier', category: 'verification', auth: 'api_key',
    keyUrl:  'https://app.millionverifier.com/api',
    keyHint: 'API → copy your API key.',
    webhook: 'none',   // Their webhook is an account-level UI setting; we poll instead.
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02).',
  },
  neverbounce: {
    display: 'NeverBounce', category: 'verification', auth: 'api_key',
    keyUrl:  'https://app.neverbounce.com/apps/custom-integration/new',
    keyHint: 'Apps → Custom Integration → create, then copy the secret key.',
    webhook: 'none',   // Per-job callback_url; nothing to register up front.
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02).',
  },

  // ── Scraping ──────────────────────────────────────────────────────────────
  apify: {
    display: 'Apify', category: 'scraping', auth: 'api_key',
    keyUrl:  'https://console.apify.com/settings/integrations',
    keyHint: 'Settings → Integrations → copy your Personal API token.',
    webhook: 'none',   // Apify can register webhooks, but no /inbound/apify route exists.
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02).',
  },

  // ── Communication ─────────────────────────────────────────────────────────
  gmail_oauth: {
    display: 'Gmail', category: 'communication', auth: 'oauth2', managed: 'composio',
    keyHint: 'Sign in with Google.',
    webhook: 'none',
  },
  google_calendar: {
    display: 'Google Calendar', category: 'communication', auth: 'oauth2', managed: 'composio',
    keyHint: 'Sign in with Google.',
    webhook: 'none',
  },
  slack: {
    display: 'Slack', category: 'communication', auth: 'oauth2',
    keyHint: 'Sign in with Slack.',
    webhook: 'none',
    // Back in the catalogue (GET-787): automations post to channels and people through it.
  },
  smtp: {
    display: 'Custom SMTP / IMAP', category: 'communication', auth: 'credentials',
    authFields: SMTP_FIELDS,
    keyHint: 'Your mail provider gives you these. For Gmail or Outlook you need an app password.',
    webhook: 'none',
  },

  // ── Product ───────────────────────────────────────────────────────────────
  linear: {
    display: 'Linear', category: 'productivity', auth: 'oauth2',
    keyHint: 'Sign in with Linear. An owner or admin connects it once for the workspace.',
    // Writes, not reads: insight topics go to Linear as issues (GET-825). Status sync back is
    // the follow-up; until its /inbound route exists the webhook stays 'none'.
    webhook: 'none',
  },

  // ── Database ──────────────────────────────────────────────────────────────
  airtable: {
    display: 'Airtable', category: 'database', auth: 'oauth2',
    keyHint: 'Sign in with Airtable.',
    webhook: 'none',
    hidden: true, hiddenWhy: 'Not used — removed from the catalogue on request (2026-09-02).',
  },

  // ── Present in the table, deliberately not offered ─────────────────────────
  //
  // These were invisible only because the frontend happened to carry them in a hardcoded
  // EXCLUDED list. Saying it here instead means the reason is written down, and the
  // database (is_active) carries the decision rather than a component.
  gmail:            { display: 'Gmail (SMTP)',      category: 'communication', auth: 'credentials', authFields: SMTP_FIELDS, webhook: 'none', hidden: true, hiddenWhy: 'Superseded by gmail_oauth. Kept for workspaces that connected it before OAuth existed.' },
  notion:           { display: 'Notion',            category: 'productivity',  auth: 'oauth2', webhook: 'none', hidden: true, hiddenWhy: 'No OAuth handler mounted. SettingsModal builds an authorize URL for it that 404s.' },
  google_analytics: { display: 'Google Analytics',  category: 'analytics',     auth: 'oauth2', webhook: 'none', hidden: true, hiddenWhy: 'No OAuth handler mounted, and not a GTM surface.' },
  outlook_oauth:    { display: 'Outlook',           category: 'communication', auth: 'oauth2', webhook: 'none', hidden: true, hiddenWhy: 'No OAuth handler mounted. Was the one such provider NOT in the old EXCLUDED list, so it rendered a Connect button that 404d.' },
  clickup:          { display: 'ClickUp',           category: 'productivity',  auth: 'api_key', webhook: 'none', hidden: true, hiddenWhy: 'Not a GTM surface.' },
  mailchimp:        { display: 'Mailchimp',         category: 'marketing',     auth: 'api_key', webhook: 'none', hidden: true, hiddenWhy: 'Not a GTM surface.' },
  stripe:           { display: 'Stripe',            category: 'payment',       auth: 'api_key', webhook: 'none', hidden: true, hiddenWhy: 'Billing, wired separately — not a user-connectable integration.' },
  // Your own model (GET-528). Connected, an automation's agent step runs on YOUR key and bills
  // your provider instead of spending OpenNous credits — the point for self-serve, where the
  // operator already pays a model provider. Was hidden as "model keys are ours"; reversed on
  // Product decision, 2026-09-29.
  anthropic:        { display: 'Claude',            category: 'ai',            auth: 'api_key', webhook: 'none',
                      keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'Console → API keys → create a key.' },
  openai:           { display: 'ChatGPT',           category: 'ai',            auth: 'api_key', webhook: 'none',
                      keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'Platform → API keys → create a secret key.' },
  // Gemini comes after ChatGPT and Claude; hidden until then.
  google:           { display: 'Gemini',            category: 'ai',            auth: 'api_key', webhook: 'none',
                      keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AI Studio → Get API key.',
                      hidden: true, hiddenWhy: 'ChatGPT and Claude first; Gemini later.' },
  assetly:          { display: 'Assetly',           category: 'productivity',  auth: 'none',    webhook: 'none', hidden: true, hiddenWhy: 'Legacy, nothing to connect.' },
  rb2b:             { display: 'RB2B',              category: 'enrichment',    auth: 'none',    webhook: 'manual', webhookUrl: null, hidden: true, hiddenWhy: 'Webhook-only source, no key to connect. Its inbound URL is on the Webhooks page.' },
  signalbase:       { display: 'Signalbase',        category: 'enrichment',    auth: 'api_key', webhook: 'none', hidden: true, hiddenWhy: 'Internal.' },
};

/** Providers offered in the catalogue UI. */
export function visibleProviders() {
  return Object.entries(CATALOGUE)
    .filter(([, p]) => !p.hidden)
    .map(([name, p]) => ({ name, ...p }));
}

export function getProvider(name) {
  const p = CATALOGUE[String(name || '').toLowerCase()];
  return p ? { name: String(name).toLowerCase(), ...p } : null;
}

/** Does connecting this provider mean pasting one key? (i.e. not OAuth, not a form) */
export function isKeyProvider(name) {
  return getProvider(name)?.auth === 'api_key';
}

export function isOAuthProvider(name) {
  return getProvider(name)?.auth === 'oauth2';
}

/**
 * Fail the boot rather than ship a catalogue that lies.
 *
 * Both of these have already happened in production, which is why they are assertions
 * and not comments: a provider marked auto with no handler silently registers nothing,
 * and a provider marked oauth2 with no mounted router renders a Connect button that 404s.
 */
export function assertCatalogueIsSane() {
  const problems = [];

  for (const [name, p] of Object.entries(CATALOGUE)) {
    if (p.webhook === 'auto' && !WEBHOOK_HANDLERS[name]) {
      problems.push(`${name}: webhook 'auto' but no entry in WEBHOOK_HANDLERS — it would register nothing and report success.`);
    }
    if (p.webhook !== 'auto' && WEBHOOK_HANDLERS[name]) {
      problems.push(`${name}: has a WEBHOOK_HANDLERS entry but webhook is '${p.webhook}' — the handler will never run.`);
    }
    if (p.auth === 'credentials' && !p.authFields?.length) {
      problems.push(`${name}: auth 'credentials' but no authFields — the form would render empty.`);
    }
  }

  if (problems.length) {
    throw new Error(`Provider catalogue is inconsistent:\n  - ${problems.join('\n  - ')}`);
  }
}

// ── Scope ───────────────────────────────────────────────────────────────────
//
// Derived from the category, with the per-provider exceptions named below, so adding a
// provider gets the right answer by default and a wrong one has to be written down.
//
// A category is workspace-shared when ONE connection covers the company: the pipeline, the
// sequencer, the payments, the enrichment credits. It is personal when the connection is a
// person's own account and only ever sees what that person saw.
const WORKSPACE_CATEGORIES = new Set([
  'crm', 'outbound', 'payment', 'marketing', 'analytics', 'database', 'enrichment',
  'verification', 'scraping', 'ai',
]);

// The exceptions, each with its reason. These are the ones a category alone gets wrong.
const SCOPE_OVERRIDES = {
  // A notetaker's key is issued per person and only sees the calls they recorded or were
  // shared on — Fathom and Granola say so in their own docs.
  fireflies: 'personal',
  fathom: 'personal',
  granola: 'personal',
  // Fellow is the exception among note-takers: a Super Admin key reads the whole Fellow
  // workspace and its webhook can be workspace-scoped, so one connection covers the team.
  // Must agree with COMPANY_BY_NAME in sourceScope.mjs (tests/sourceScope.test.mjs checks).
  fellow: 'workspace',
  // RingCentral is the company phone system: one service-user JWT reads every call (GET-289).
  ringcentral: 'workspace',
  // A mailbox, a calendar and a scheduling link are one person's, always.
  gmail_oauth: 'personal',
  google_calendar: 'personal',
  calendly: 'personal',
  cal_com: 'personal',
  smtp: 'personal',
  // Slack is the company's room, not a person's.
  slack: 'workspace',
  // Linear is the company's issue tracker: one connection, issues filed for the team (GET-825).
  linear: 'workspace',
};

// The logo file for a provider. Derived from the name, with the handful whose asset is a
// .png or is named differently written down. It lives here rather than in a frontend list
// because the catalogue is the truth about a provider and a logo is a provider fact — the
// hardcoded copy in Integrations.tsx is exactly the drift this avoids repeating.
const LOGO_EXCEPTIONS = {
  anthropic: 'claude.svg',
  google: 'gemini.svg',
  gmail_oauth: 'gmail.svg',
  google_calendar: 'google-calendar.svg',
  cal_com: 'cal_com.svg',
  aiark: 'aiark.png',
  emailbison: 'emailbison.png',
  heyreach: 'heyreach.png',
  fellow: 'fellow.png',
  smartlead: 'smartlead.png',
  leadmagic: 'leadmagic.png',
  millionverifier: 'millionverifier.png',
  neverbounce: 'neverbounce.png',
  linkedin: 'linkedin.png',
};

export function logoOf(name) {
  return `/provider-logos/${LOGO_EXCEPTIONS[name] ?? `${name}.svg`}`;
}

/** 'workspace' (one connection covers the company) or 'personal' (one connection, one seat). */
export function scopeOf(name) {
  const p = CATALOGUE[name];
  if (!p) return 'workspace';
  return SCOPE_OVERRIDES[name] ?? (WORKSPACE_CATEGORIES.has(p.category) ? 'workspace' : 'personal');
}

/**
 * The catalogue as a list, filtered the way a caller actually asks for it: everything a
 * founder should connect for the company, or everything a seat connects for themselves.
 * Hidden providers never appear — hiding one is a decision, and this must not route around it.
 */
export function listProvidersByScope(scope, { categories = null } = {}) {
  return Object.entries(CATALOGUE)
    .filter(([name, p]) => !p.hidden && scopeOf(name) === scope
      && (!categories || categories.includes(p.category)))
    .map(([name, p]) => ({
      name, display: p.display, category: p.category, auth: p.auth,
      keyHint: p.keyHint ?? null, keyUrl: p.keyUrl ?? null, scope, logo: logoOf(name),
    }));
}

/**
 * Push the catalogue into workflow_providers. Runs on every boot, overwriting — the file
 * is the truth and the table is its projection, so a value hand-edited in the database is
 * meant to be overwritten here.
 */
export async function syncCatalogueToDb(supabase) {
  assertCatalogueIsSane();

  const rows = Object.entries(CATALOGUE).map(([name, p]) => ({
    name,
    display_name:         p.display,
    category:             p.category,
    auth_type:            p.auth,
    auth_fields:          p.authFields ?? null,
    key_url:              p.keyUrl ?? null,
    key_hint:             p.keyHint ?? null,
    webhook_mode:         p.webhook,
    webhook_settings_url: p.webhookUrl ?? null,
    managed_by:           p.managed ?? 'native',
    is_active:            !p.hidden,
    scope:                scopeOf(name),
  }));

  const { error } = await supabase
    .from('workflow_providers')
    .upsert(rows, { onConflict: 'name' });

  if (error) console.error('[CATALOGUE] sync failed:', error.message);
  else console.log(`[CATALOGUE] ${rows.length} providers synced`);
}
