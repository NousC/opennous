// Preview fixtures for the API plan's Integrations pages (GET-631, GET-638).
// Wired into preview/server.mjs's API-plan routes only, so the visual baselines never see them.
// Shapes match apps/api: GET /api/workflow-providers, /connections (with ?include=last_synced,progress),
// /api/linkedin/status, /api/webhooks/urls, /api/workspace/composio.

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const P = (name, display_name, category, auth_type, scope, extra = {}) => ({
  id: `prov-${name}`, name, display_name, category, auth_type, scope,
  logo_url: `/provider-logos/${extra.logo ?? `${name}.svg`}`, is_active: true, ...extra,
});

const PROVIDERS = [
  P("gmail_oauth", "Gmail", "communication", "oauth2", "personal", { logo: "gmail.svg", managed_by: "composio" }),
  P("google_calendar", "Google Calendar", "communication", "oauth2", "personal", { logo: "google-calendar.svg", managed_by: "composio" }),
  P("cal_com", "Cal.com", "meetings", "api_key", "personal"),
  P("calendly", "Calendly", "meetings", "oauth2", "personal"),
  P("fireflies", "Fireflies.ai", "meetings", "api_key", "personal", { webhook_mode: "manual" }),
  P("fathom", "Fathom", "meetings", "api_key", "personal", { webhook_mode: "auto" }),
  P("granola", "Granola", "meetings", "api_key", "personal"),
  P("fellow", "Fellow", "meetings", "api_key", "company", { logo: "fellow.png" }),
  P("hubspot", "HubSpot", "crm", "oauth2", "company"),
  P("salesforce", "Salesforce", "crm", "oauth2", "company"),
  P("attio", "Attio", "crm", "api_key", "company"),
  P("pipedrive", "Pipedrive", "crm", "api_key", "company"),
  P("instantly", "Instantly", "outbound", "api_key", "company", { webhook_mode: "auto" }),
  P("smartlead", "Smartlead", "outbound", "api_key", "company", { logo: "smartlead.png", webhook_mode: "auto" }),
  P("lemlist", "Lemlist", "outbound", "api_key", "company", { webhook_mode: "auto" }),
  P("heyreach", "HeyReach", "outbound", "api_key", "company", { logo: "heyreach.png" }),
  P("slack", "Slack", "communication", "oauth2", "company"),
  P("apollo", "Apollo", "enrichment", "api_key", "company"),
  P("prospeo", "Prospeo", "enrichment", "api_key", "company"),
];
const byName = Object.fromEntries(PROVIDERS.map((p) => [p.name, p]));

const C = (id, prov, name, scope, { verified = true, synced = null, created = 60 * 24 * 9, owner = "Avery Castellan", mine = true, progress = null } = {}) => {
  const p = byName[prov];
  return {
    id, workspace_id: "ws-preview", provider_id: p.id, name, created_at: ago(created), last_used_at: null,
    is_verified: verified, last_test_at: null, owner_user_id: mine ? "u1" : "u2",
    provider: { id: p.id, name: p.name, display_name: p.display_name, logo_url: p.logo_url, auth_type: p.auth_type, category: p.category },
    credential_hints: {}, webhook_registered: prov === "cal_com", scope,
    owner_name: owner, is_mine: mine, can_manage: true,
    last_synced_at: synced === null ? null : ago(synced),
    sync_progress: progress,
  };
};

const CONNECTIONS = [
  // Gmail is mid-backfill (E5): the reading phase, threads read of threads to read.
  C("c-gmail", "gmail_oauth", "avery@opennous.example", "personal", { synced: 4, progress: { percent: 72, done: 290, total: 403, label: "Reading email" } }),
  C("c-gcal", "google_calendar", "avery@opennous.example", "personal", { synced: 12 }),
  C("c-ff", "fireflies", "Fireflies.ai", "personal", { synced: 9 }),
  C("c-hs", "hubspot", "HubSpot", "company", { synced: 2 }),
  C("c-inst", "instantly", "Instantly", "company", { synced: 60 * 26, owner: "Maya Chen", mine: false }),
  C("c-slack", "slack", "Slack", "company", { verified: false, owner: "Maya Chen", mine: false }),
];

export const apiPlanP3Routes = [
  ["GET", /^\/api\/workflow-providers$/, () => ({ providers: PROVIDERS })],
  ["GET", /^\/api\/workflow-providers\/connections$/, (_m, q) => ({
    connections: CONNECTIONS.map((c) => {
      const include = (q.get("include") ?? "").split(",");
      const { last_synced_at, sync_progress, ...rest } = c;
      return {
        ...rest,
        ...(include.includes("last_synced") ? { last_synced_at } : {}),
        ...(include.includes("progress") ? { sync_progress } : {}),
      };
    }),
  })],
  ["GET", /^\/api\/linkedin\/status$/, () => {
    const connections = [{ id: "li1", unipile_account_id: "un1", linkedin_name: "Avery Castellan", linkedin_headline: null, linkedin_profile_url: null, connected_at: ago(60 * 24 * 20), is_mine: true }];
    return { connected: true, connection: connections[0], connections, limit: 3, used: 1, can_connect_more: true };
  }],
  // /api/webhooks/urls (with the Fireflies row) lives in api-plan-p4.mjs, which the Webhooks page reads too.
  ["GET", /^\/api\/workspace\/composio$/, () => ({ configured: true })],
];
