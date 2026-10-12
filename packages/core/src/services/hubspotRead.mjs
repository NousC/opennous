// HubSpot · Read records (GET-773): an automation step that reads HubSpot records for a date
// window and hands the next step a short, exact table. Any object the portal has, custom ones
// included: a custom object that holds one record per customer per day is why it exists.
//
// Read only. One search per period, paged, capped, and boiled down here (sums per row, the
// change against the period before, rows with nothing in them dropped), so an AI step reads a
// table of tens of rows instead of thousands of records.
import { hubspotToken } from './hubspotVars.mjs';

const HS = 'https://api.hubapi.com';
const DAY = 86_400_000;
const STANDARD = [
  { id: 'companies', label: 'Companies' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'deals', label: 'Deals' },
];

async function hs(token, path, init = {}, fetchImpl = fetch) {
  const r = await fetchImpl(`${HS}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(body?.message ?? `HubSpot answered ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

/** The objects a Read step can read: the standard three, then the portal's custom objects. */
export async function hubspotObjects(supabase, workspaceId, { fetchImpl = fetch } = {}) {
  const token = await hubspotToken(supabase, workspaceId).catch(() => null);
  if (!token) return { connected: false, objects: [] };
  const custom = await hs(token, '/crm/v3/schemas', {}, fetchImpl).catch(() => ({ results: [] }));
  return {
    connected: true,
    objects: [...STANDARD, ...(custom.results ?? []).map(s => ({ id: s.objectTypeId, label: s.labels?.plural || s.labels?.singular || s.name, custom: true }))],
  };
}

/** One object's fields, for the picker: name, label, type. */
export async function hubspotObjectFields(supabase, workspaceId, object, { fetchImpl = fetch } = {}) {
  const token = await hubspotToken(supabase, workspaceId).catch(() => null);
  if (!token) return [];
  const r = await hs(token, `/crm/v3/properties/${encodeURIComponent(object)}`, {}, fetchImpl).catch(() => ({ results: [] }));
  return (r.results ?? [])
    .filter(p => !p.hidden)
    .map(p => ({ name: p.name, label: p.label || p.name, type: p.type ?? null }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Midnight UTC of the day `back` days before `now`, as HubSpot's date filters want it (ms). */
const dayStart = (now, back = 0) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime() - back * DAY; };

/**
 * The periods a window reads: the current one and the one before it, for the change.
 * yesterday: that day vs the day before; last_7_days: the 7 days to yesterday vs the 7 before.
 */
export function periodsFor(window = 'yesterday', now = Date.now()) {
  const days = window === 'last_7_days' ? 7 : window === 'last_30_days' ? 30 : 1;
  const end = dayStart(now, 0);                  // today, midnight: the current period ends before it
  const cur = { from: end - days * DAY, to: end };
  const prev = { from: cur.from - days * DAY, to: cur.from };
  const label = (p) => (days === 1 ? new Date(p.from).toISOString().slice(0, 10) : `${new Date(p.from).toISOString().slice(0, 10)} to ${new Date(p.to - DAY).toISOString().slice(0, 10)}`);
  return { days, current: { ...cur, label: label(cur) }, previous: { ...prev, label: label(prev) } };
}

async function searchPeriod(token, object, { dateProperty, from, to, properties }, fetchImpl, cap = 2000) {
  const out = [];
  let after;
  for (let page = 0; page < Math.ceil(cap / 200); page++) {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: dateProperty, operator: 'GTE', value: String(from) },
        { propertyName: dateProperty, operator: 'LT', value: String(to) },
      ] }],
      properties, limit: 200, ...(after ? { after } : {}),
    };
    const r = await hs(token, `/crm/v3/objects/${encodeURIComponent(object)}/search`, { method: 'POST', body: JSON.stringify(body) }, fetchImpl);
    out.push(...(r.results ?? []));
    after = r.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

/**
 * Records with no name in the "one row per" field get their company's name (GET-791): a daily-stats
 * record often holds the numbers but not the name, and "Record 2116…" means nothing to a reader.
 * Through HubSpot's associations, capped, and best effort: a failure leaves the record as it was.
 */
export async function nameFromCompany(token, object, records, groupBy, fetchImpl, cap = 100) {
  if (object === 'companies') return;
  const bare = records.filter(r => !String(r.properties?.[groupBy] ?? '').trim()).slice(0, cap);
  if (!bare.length) return;
  try {
    const links = await hs(token, `/crm/v4/associations/${encodeURIComponent(object)}/companies/batch/read`,
      { method: 'POST', body: JSON.stringify({ inputs: [...new Set(bare.map(r => r.id))].map(id => ({ id })) }) }, fetchImpl);
    const companyOf = new Map((links.results ?? []).map(x => [String(x.from?.id), x.to?.[0]?.toObjectId]).filter(([, c]) => c));
    const ids = [...new Set(companyOf.values())].map(String);
    if (!ids.length) return;
    const got = await hs(token, '/crm/v3/objects/companies/batch/read',
      { method: 'POST', body: JSON.stringify({ inputs: ids.map(id => ({ id })), properties: ['name'] }) }, fetchImpl);
    const nameOf = new Map((got.results ?? []).map(c => [String(c.id), c.properties?.name]).filter(([, n]) => n));
    for (const r of bare) {
      const n = nameOf.get(String(companyOf.get(String(r.id)) ?? ''));
      if (n) r.properties = { ...(r.properties ?? {}), [groupBy]: n };
    }
  } catch { /* the table still reads, with the record's id */ }
}

const num = (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const delta = (cur, prev) => { const d = (cur ?? 0) - (prev ?? 0); return d === 0 ? '' : ` (${d > 0 ? '+' : ''}${fmt(d)})`; };

/**
 * The table, from the records of both periods. Pure. Sums each field per group (a company, say),
 * keeps groups with any activity in either period, sorts by the first field, caps the rows.
 */
export function summarizeRecords({ current, previous }, { groupBy, fields, labels = {}, maxRows = 60, periods = null, objectLabel = 'Records', compare = true }) {
  const sum = (records) => {
    const by = new Map();
    for (const r of records ?? []) {
      const key = String(r.properties?.[groupBy] ?? '').trim() || `Record ${r.id ?? '?'} (no name)`;
      const row = by.get(key) ?? {};
      for (const f of fields) { const v = num(r.properties?.[f]); if (v != null) row[f] = (row[f] ?? 0) + v; }
      by.set(key, row);
    }
    return by;
  };
  const cur = sum(current), prev = sum(previous);
  const groups = [...new Set([...cur.keys(), ...prev.keys()])]
    .map(g => ({ group: g, cur: cur.get(g) ?? {}, prev: prev.get(g) ?? {} }))
    .filter(g => fields.some(f => (g.cur[f] ?? 0) !== 0 || (g.prev[f] ?? 0) !== 0))
    .sort((a, b) => (b.cur[fields[0]] ?? 0) - (a.cur[fields[0]] ?? 0) || a.group.localeCompare(b.group));
  const totals = { cur: {}, prev: {} };
  for (const g of groups) for (const f of fields) {
    totals.cur[f] = (totals.cur[f] ?? 0) + (g.cur[f] ?? 0);
    totals.prev[f] = (totals.prev[f] ?? 0) + (g.prev[f] ?? 0);
  }
  const head = fields.map(f => labels[f] ?? f);
  const line = (name, c, p) => [name, ...fields.map(f => `${fmt(c[f] ?? 0)}${compare ? delta(c[f], p[f]) : ''}`)].join(' | ');
  const shown = groups.slice(0, maxRows);
  const text = [
    `${objectLabel}${periods ? `, ${periods.current.label}${compare ? ` (change vs ${periods.previous.label})` : ''}` : ''}: ${groups.length} with activity${groups.length > shown.length ? `, top ${shown.length} shown` : ''}.`,
    [labels[groupBy] ?? 'Name', ...head].join(' | '),
    ...shown.map(g => line(g.group, g.cur, g.prev)),
    line('Total', totals.cur, totals.prev),
  ].join('\n');
  return { text, rows: shown.map(g => ({ group: g.group, current: g.cur, previous: g.prev })), totals, count: groups.length };
}

/**
 * Read the step's records and boil them down (see summarizeRecords).
 * cfg = { object, object_label?, fields[], group_by, date_property, window }
 */
export async function readHubspotRecords(supabase, workspaceId, cfg, { now = Date.now(), fetchImpl = fetch } = {}) {
  const token = await hubspotToken(supabase, workspaceId).catch(() => null);
  if (!token) return { ok: false, reason: 'hubspot_not_connected' };
  const fields = (cfg.fields ?? []).filter(Boolean);
  if (!cfg.object || !fields.length) return { ok: false, reason: 'hubspot_read_not_set' };
  const dateProperty = cfg.date_property || 'hs_createdate';
  const groupBy = cfg.group_by || 'hs_object_id';
  const periods = periodsFor(cfg.window, now);
  const properties = [...new Set([...fields, groupBy, dateProperty])];
  try {
    // Compare with the period before unless switched off (GET-787).
    const compare = cfg.compare !== false;
    const [current, previous] = await Promise.all([
      searchPeriod(token, cfg.object, { dateProperty, from: periods.current.from, to: periods.current.to, properties }, fetchImpl),
      compare ? searchPeriod(token, cfg.object, { dateProperty, from: periods.previous.from, to: periods.previous.to, properties }, fetchImpl) : Promise.resolve([]),
    ]);
    if (groupBy !== 'hs_object_id') await nameFromCompany(token, cfg.object, [...current, ...previous], groupBy, fetchImpl);
    const labels = Object.fromEntries((cfg.field_labels ?? []).map(x => [x.name, x.label]));
    const out = summarizeRecords({ current, previous }, { groupBy, fields, labels, periods, objectLabel: cfg.object_label || 'Records', compare });
    return { ok: true, ...out, periods, read: current.length + previous.length };
  } catch (err) {
    return { ok: false, reason: err.status === 401 ? 'hubspot_expired' : err.status === 403 ? 'hubspot_missing_scope' : `hubspot_read_failed: ${String(err.message).slice(0, 160)}` };
  }
}
