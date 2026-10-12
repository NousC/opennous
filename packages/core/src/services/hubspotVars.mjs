// HubSpot fields as automation variables (GET-567): {{hubspot.deal.<property>}} and
// {{hubspot.company.<property>}}, any property the portal has, custom ones included.
//
// The CRM sync asks HubSpot for a fixed list of properties, renames them and keeps nothing raw,
// so a custom field like "onboarding_owner" is nowhere in our tables. Its NAME is: every sync
// stores the portal's full property list in crm_property_schemas. So the picker lists from
// there, and the VALUES are read live from HubSpot at send time — only the properties the
// text actually uses, for the one deal and company the run is about. One batch read each.
import { decrypt } from '../utils/encryption.js';
import { hubspotBatchRead } from '../integrations/crm/index.js';

const HS_TOKEN = /\{\{\s*hubspot\.(deal|company)\.([\w-]+)\s*\}\}/g;
const OBJECT = { deal: 'deals', company: 'companies' };

/** The HubSpot properties a set of texts uses, per object. */
export function hubspotPropsIn(texts) {
  const out = { deal: new Set(), company: new Set() };
  for (const t of texts ?? []) {
    for (const m of String(t ?? '').matchAll(HS_TOKEN)) out[m[1]].add(m[2]);
  }
  return out;
}

/** The workspace's HubSpot token, read the way the CRM sync reads it. Null when not connected. */
export async function hubspotToken(supabase, workspaceId) {
  const { data: cfg } = await supabase.from('crm_sync_configs').select('connection_id')
    .eq('workspace_id', workspaceId).eq('provider', 'hubspot').limit(1).maybeSingle();
  if (!cfg?.connection_id) return null;
  const { data: conn } = await supabase.from('workflow_provider_connections').select('encrypted_credentials')
    .eq('id', cfg.connection_id).eq('workspace_id', workspaceId).maybeSingle();
  const creds = {};
  for (const [k, v] of Object.entries(conn?.encrypted_credentials ?? {})) {
    if (typeof v === 'string') creds[k] = decrypt(v);
  }
  return creds.access_token || creds.api_key || Object.values(creds).find(v => typeof v === 'string' && v) || null;
}

async function schemaOf(supabase, workspaceId, object) {
  const { data } = await supabase.from('crm_property_schemas').select('properties')
    .eq('workspace_id', workspaceId).eq('provider', 'hubspot').eq('object_type', object).maybeSingle();
  return Array.isArray(data?.properties) ? data.properties : [];
}

/** Every deal and company property the portal has, for the variable picker. */
export async function hubspotFieldList(supabase, workspaceId) {
  const [deals, companies] = await Promise.all([schemaOf(supabase, workspaceId, 'deals'), schemaOf(supabase, workspaceId, 'companies')]);
  const shape = (list) => list
    .filter(p => p?.name)
    .map(p => ({ name: p.name, label: p.label || p.name, type: p.type ?? null, custom: !!p.custom }))
    // Your own fields first — they are why you opened this list — then HubSpot's, by label.
    .sort((a, b) => (a.custom === b.custom ? a.label.localeCompare(b.label) : a.custom ? -1 : 1));
  return { deal: shape(deals), company: shape(companies) };
}

/** A HubSpot value as an email prints it: dates as dates, the rest as HubSpot holds it. */
function printable(value, type) {
  if (value == null || value === '') return null;
  if (type === 'date' || type === 'datetime') {
    const d = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    }
  }
  if (type === 'enumeration') return String(value).split(';').filter(Boolean).join(', ');
  return String(value);
}

/**
 * The hubspot.* variables these texts use, read live for one run's deal and account. Every
 * failure — no connection, no HubSpot id, HubSpot refusing — leaves those variables empty and
 * the email still goes: a missing field is a blank, not a lost handoff.
 */
export async function hubspotTemplateVars(supabase, workspaceId, { dealId = null, accountId = null, texts = [] } = {}) {
  const wanted = hubspotPropsIn(texts);
  if (!wanted.deal.size && !wanted.company.size) return {};
  const out = {};
  try {
    const token = await hubspotToken(supabase, workspaceId);
    if (!token) return out;
    const [dealRef, companyRef, dealSchema, companySchema] = await Promise.all([
      wanted.deal.size && dealId
        ? supabase.from('entity_identifiers').select('value').eq('workspace_id', workspaceId)
          .eq('entity_id', dealId).eq('kind', 'deal_hubspot').eq('status', 'active').limit(1).maybeSingle()
        : { data: null },
      wanted.company.size && accountId
        ? supabase.from('companies').select('hubspot_company_id').eq('workspace_id', workspaceId).eq('id', accountId).maybeSingle()
        : { data: null },
      wanted.deal.size ? schemaOf(supabase, workspaceId, 'deals') : [],
      wanted.company.size ? schemaOf(supabase, workspaceId, 'companies') : [],
    ]);
    const jobs = [
      ['deal', dealRef?.data?.value, dealSchema],
      ['company', companyRef?.data?.hubspot_company_id, companySchema],
    ];
    await Promise.all(jobs.map(async ([obj, id, schema]) => {
      if (!id || !wanted[obj].size) return;
      const typeOf = new Map(schema.map(p => [p.name, p.type]));
      const [row] = await hubspotBatchRead(token, OBJECT[obj], [String(id)], [...wanted[obj]]);
      for (const prop of wanted[obj]) out[`hubspot.${obj}.${prop}`] = printable(row?.properties?.[prop], typeOf.get(prop));
    }));
  } catch (err) {
    console.warn('[automations] hubspot fields unavailable:', err?.message ?? err);
  }
  return out;
}
