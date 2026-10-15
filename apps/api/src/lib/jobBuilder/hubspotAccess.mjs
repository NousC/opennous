// What the workspace's HubSpot connection is allowed to do (GET-868), in plain capabilities.
//
// The Job Builder must warn before it proposes a job that cannot run: a read of a custom object on
// a token without crm.objects.custom.read fails every morning with a 403 nobody sees. hubspotObjects
// swallows that failure (custom objects just vanish from the list), so this asks directly.
//
// OAuth tokens: HubSpot's token-info endpoint (GET /oauth/v1/access-tokens/{token}) lists the
// granted scopes. Private-app tokens (pat-…) have no such endpoint, so we probe cheaply instead:
// a 1-record read per standard object and the custom-object schemas, a 403 meaning "missing scope".
// Writes cannot be probed without writing, so on a private app they come back unknown (null).
import { decrypt } from '../../utils/crypto.mjs';

const HS = 'https://api.hubapi.com';

/** The capability -> the scopes that grant it. Any one entry of `anyOf` is enough; `allOf` all. */
export const CAPABILITIES = {
  read_companies: { label: 'Read companies', anyOf: ['crm.objects.companies.read', 'contacts'] },
  read_contacts: { label: 'Read contacts', anyOf: ['crm.objects.contacts.read', 'contacts'] },
  read_deals: { label: 'Read deals', anyOf: ['crm.objects.deals.read', 'contacts'] },
  read_custom_objects: { label: 'Read custom objects', allOf: ['crm.objects.custom.read', 'crm.schemas.custom.read'] },
  // A note or task is written against the record it is associated with, so the write scope of that
  // object is what HubSpot checks (the legacy `contacts` scope covers all three).
  write_notes: { label: 'Write notes', anyOf: ['crm.objects.companies.write', 'crm.objects.contacts.write', 'crm.objects.deals.write', 'contacts'] },
  write_tasks: { label: 'Write tasks', anyOf: ['crm.objects.companies.write', 'crm.objects.contacts.write', 'crm.objects.deals.write', 'contacts'] },
};

const FIX = { label: 'Reconnect HubSpot', href: '/company-sources?connect=hubspot' };

/** Scopes -> { capability: true|false }. Pure. */
export function capabilitiesFromScopes(scopes) {
  const have = new Set((scopes ?? []).map(String));
  const out = {};
  for (const [key, c] of Object.entries(CAPABILITIES)) {
    out[key] = c.allOf ? c.allOf.every(s => have.has(s)) : c.anyOf.some(s => have.has(s));
  }
  return out;
}

/** The token and how it was issued, read the way core's hubspotToken reads it. */
export async function hubspotConnectionToken(supabase, workspaceId) {
  const { data: cfg } = await supabase.from('crm_sync_configs').select('connection_id')
    .eq('workspace_id', workspaceId).eq('provider', 'hubspot').limit(1).maybeSingle();
  if (!cfg?.connection_id) return null;
  const { data: conn } = await supabase.from('workflow_provider_connections').select('encrypted_credentials')
    .eq('id', cfg.connection_id).eq('workspace_id', workspaceId).maybeSingle();
  const creds = {};
  for (const [k, v] of Object.entries(conn?.encrypted_credentials ?? {})) {
    if (typeof v !== 'string') continue;
    try { creds[k] = decrypt(v); } catch { creds[k] = v; }
  }
  const token = creds.access_token || creds.api_key || Object.values(creds).find(v => typeof v === 'string' && v) || null;
  if (!token) return null;
  return { token, oauth: !!creds.refresh_token || (!!creds.access_token && !String(token).startsWith('pat-')) };
}

async function status(fetchImpl, token, path) {
  try {
    const r = await fetchImpl(`${HS}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    let body = null;
    try { body = await r.json(); } catch { /* empty */ }
    return { status: r.status, ok: r.ok, body };
  } catch (err) {
    return { status: 0, ok: false, body: null, error: String(err?.message ?? err) };
  }
}

/** A probe's status -> true (allowed), false (missing scope), or null (could not tell). */
const probeAnswer = (s) => (s.ok ? true : s.status === 403 ? false : null);

/**
 * { connected, method: 'token_info'|'probe', expired?, scopes?, capabilities, missing[], fix? }
 * `missing` holds the capabilities that are known to be absent, each with the scopes to grant.
 */
export async function hubspotAccessForToken(conn, { fetchImpl = fetch } = {}) {
  if (!conn?.token) return { connected: false, capabilities: {}, missing: [], fix: { label: 'Connect HubSpot', href: '/company-sources?connect=hubspot' } };
  const { token } = conn;
  let result = null;
  if (!String(token).startsWith('pat-')) {
    const info = await status(fetchImpl, token, `/oauth/v1/access-tokens/${encodeURIComponent(token)}`);
    if (info.ok && Array.isArray(info.body?.scopes)) {
      result = { connected: true, method: 'token_info', hub_id: info.body.hub_id ?? null, scopes: info.body.scopes, capabilities: capabilitiesFromScopes(info.body.scopes) };
    } else if (info.status === 401) {
      return { connected: true, expired: true, method: 'token_info', capabilities: {}, missing: [], fix: FIX };
    }
  }
  if (!result) {
    // Private app (or a token-info failure): probe. A 1-record read per object, then the schemas.
    const [companies, contacts, deals, schemas] = await Promise.all([
      status(fetchImpl, token, '/crm/v3/objects/companies?limit=1'),
      status(fetchImpl, token, '/crm/v3/objects/contacts?limit=1'),
      status(fetchImpl, token, '/crm/v3/objects/deals?limit=1'),
      status(fetchImpl, token, '/crm/v3/schemas?limit=1'),
    ]);
    if ([companies, contacts, deals, schemas].some(s => s.status === 401)) {
      return { connected: true, expired: true, method: 'probe', capabilities: {}, missing: [], fix: FIX };
    }
    let custom = probeAnswer(schemas);
    // The schemas read can pass while records of the custom object cannot: read one record.
    const firstCustom = schemas.ok ? schemas.body?.results?.[0]?.objectTypeId : null;
    if (custom && firstCustom) custom = probeAnswer(await status(fetchImpl, token, `/crm/v3/objects/${encodeURIComponent(firstCustom)}?limit=1`));
    result = {
      connected: true, method: 'probe',
      capabilities: {
        read_companies: probeAnswer(companies), read_contacts: probeAnswer(contacts), read_deals: probeAnswer(deals),
        read_custom_objects: custom,
        // Unknown without a write; a private app's scopes are on its HubSpot settings page.
        write_notes: null, write_tasks: null,
      },
    };
  }
  const missing = Object.entries(result.capabilities).filter(([, v]) => v === false).map(([key]) => ({
    capability: key, label: CAPABILITIES[key].label, scopes: CAPABILITIES[key].allOf ?? [CAPABILITIES[key].anyOf[0]],
  }));
  return { ...result, missing, ...(missing.length ? { fix: FIX } : {}) };
}

/** The workspace's HubSpot access. */
export async function hubspotAccess(supabase, workspaceId, { fetchImpl = fetch } = {}) {
  const conn = await hubspotConnectionToken(supabase, workspaceId).catch(() => null);
  return hubspotAccessForToken(conn, { fetchImpl });
}
