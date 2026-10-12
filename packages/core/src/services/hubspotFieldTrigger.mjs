// "When a HubSpot field changes" (GET-781): an automation trigger on any field of any HubSpot
// object, custom ones included. "Lifecycle Stage changes to Customer", "Onboarding Status
// changes", "the deal amount changes".
//
// No webhooks to configure in HubSpot and nothing new to store. Every few minutes: which records
// of that object were modified in the last half hour, then each one's history of the watched
// field (HubSpot keeps it). A history entry inside the window is a change: old value, new value,
// when. Each change runs the automation once (the run's dedupe key is the change itself, so the
// overlapping windows never run it twice).
import { hubspotToken } from './hubspotVars.mjs';

const HS = 'https://api.hubapi.com';
export const FIELD_CHANGE_WINDOW_MS = 30 * 60_000;

async function hs(token, path, init = {}, fetchImpl = fetch) {
  const r = await fetchImpl(`${HS}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(body?.message ?? `HubSpot answered ${r.status}`); e.status = r.status; throw e; }
  return body;
}

const modified = (cfg) => (cfg.object === 'contacts' ? 'lastmodifieddate' : 'hs_lastmodifieddate');
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * The changes in one record's field history inside [since, now]. Pure.
 * history: HubSpot's propertiesWithHistory[property], newest first: [{ value, timestamp }].
 * `to` keeps only changes to that value; `from` only changes away from it.
 */
export function changesFromHistory(history, { since, to = null, from = null }) {
  const h = [...(history ?? [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const out = [];
  for (let i = 0; i < h.length; i++) {
    const at = Date.parse(h[i].timestamp);
    if (!(at >= since)) break;
    const next = h[i].value ?? null;
    const prev = h[i + 1]?.value ?? null;
    if (same(prev, next)) continue;
    if (to && !same(next, to)) continue;
    if (from && !same(prev, from)) continue;
    out.push({ old: prev, new: next, at: h[i].timestamp });
  }
  return out;
}

/** Records of `object` changed since `since`, with the watched field's history. */
async function recentChanges(token, cfg, since, fetchImpl, cap = 500, onlySet = false) {
  const ids = [];
  let after;
  for (let page = 0; page < Math.ceil(cap / 100); page++) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: modified(cfg), operator: 'GTE', value: String(since) },
        // Looking back days (a test), only records that hold the field: a portal can modify
        // hundreds of records a day (one customer: ~940) and most never had the field at all.
        ...(onlySet ? [{ propertyName: cfg.property, operator: 'HAS_PROPERTY' }] : []),
      ] }],
      sorts: [{ propertyName: modified(cfg), direction: 'DESCENDING' }],
      properties: ['hs_object_id'], limit: 100, ...(after ? { after } : {}),
    };
    const r = await hs(token, `/crm/v3/objects/${encodeURIComponent(cfg.object)}/search`, { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
    ids.push(...(r.results ?? []).map(x => x.id));
    after = r.paging?.next?.after;
    if (!after) break;
  }
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await hs(token, `/crm/v3/objects/${encodeURIComponent(cfg.object)}/batch/read`, {
      method: 'POST',
      body: JSON.stringify({ inputs: ids.slice(i, i + 50).map(id => ({ id })), properties: [cfg.property, cfg.name_property || 'name'], propertiesWithHistory: [cfg.property] }),
    }, fetchImpl);
    for (const rec of r.results ?? []) {
      for (const c of changesFromHistory(rec.propertiesWithHistory?.[cfg.property], { since, to: cfg.to || null, from: cfg.from || null })) {
        out.push({ objectId: rec.id, name: rec.properties?.[cfg.name_property || 'name'] ?? null, ...c });
      }
    }
  }
  return out;
}

/** Changes for one automation's trigger in the window. { ok, changes } | { ok: false, reason }. */
export async function hubspotFieldChanges(supabase, workspaceId, cfg, { since, fetchImpl = fetch, cap = 500, onlySet = false } = {}) {
  if (!cfg?.object || !cfg?.property) return { ok: false, reason: 'hubspot_trigger_not_set' };
  const token = await hubspotToken(supabase, workspaceId).catch(() => null);
  if (!token) return { ok: false, reason: 'hubspot_not_connected' };
  try {
    return { ok: true, changes: await recentChanges(token, cfg, since, fetchImpl, cap, onlySet) };
  } catch (err) {
    return { ok: false, reason: err.status === 401 ? 'hubspot_expired' : `hubspot_read_failed: ${String(err.message).slice(0, 160)}` };
  }
}

/** Our account for a HubSpot record: its HubSpot id among our identifiers. */
export async function entityForHubspotId(supabase, workspaceId, objectId) {
  const { data } = await supabase.from('entity_identifiers').select('entity_id')
    .eq('workspace_id', workspaceId).eq('kind', 'hubspot').eq('value', String(objectId)).limit(1);
  return data?.[0]?.entity_id ?? null;
}

/** The words a run and its steps get for a change: "Onboarding Status changed from Pending to Active". */
export function changeText(cfg, ch) {
  const field = cfg.property_label || cfg.property;
  const who = ch.name ? `${ch.name}: ` : '';
  return `${who}${field} changed from ${shown(ch.old)} to ${shown(ch.new)}.`;
}

/** A value as a person reads it: HubSpot hands dates over as millisecond timestamps. */
function shown(v) {
  if (v == null || v === '') return '(empty)';
  const s = String(v);
  if (/^\d{12,13}$/.test(s)) { const d = new Date(Number(s)); if (!Number.isNaN(d.getTime())) return `"${d.toISOString().slice(0, 10)}"`; }
  return `"${s}"`;
}
