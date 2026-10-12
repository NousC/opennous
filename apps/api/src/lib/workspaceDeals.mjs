// Every CRM deal in a workspace, for the Accounts page's Sales Pipeline and Handoff tabs (GET-267).
//
// A deal is a `type: 'deal'` entity: its name, stage, status, value and close date are claims,
// it `belongs_to` a company, and people are `stakeholder_of` it. There is no view that joins
// those, and a large customer workspace holds thousands of deals, so this reads them in pages (PostgREST
// stops at 1000 rows without saying so) and in batches small enough that a batch's claims never
// reach that cap either.
//
// Outcome is crmDealState — the same reading the account's Deals section and the deal page use —
// so a deal is never "won" on one screen and "open" on the other.

import { crmDealState } from '@nous/core';
import { inDealWindow, lostCutoff } from './dealListWindow.mjs';

const PAGE = 1000;
const BATCH = 110;          // 110 deals × 8 claim properties = 880 rows, under the cap
const CONCURRENCY = 4;
const PROPS = ['name', 'stage', 'status', 'value', 'currency', 'close_date', 'owner_name', 'owner_email'];

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const num = (v) => { const n = Number(unwrap(v)); return v == null || !Number.isFinite(n) ? null : n; };
const str = (v) => { const u = unwrap(v); return u == null || u === '' ? null : String(u); };

async function allRows(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function inBatches(ids, fn) {
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  const results = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    results.push(...await Promise.all(batches.slice(i, i + CONCURRENCY).map(fn)));
  }
  return results.flat();
}

/**
 * `windowed` applies the same rule the flattened path applies (dealWindow.mjs): open and won at
 * any age, losses only from the last 12 months. Off by default — the revenue report reads this
 * function too, and it must keep seeing every deal.
 *
 * @param {{ status?: 'open'|'won'|'lost'|'all', visibleCompanyIds?: Set<string> | null,
 *           windowed?: boolean }} opts
 * @returns deals: { id, company_id, company_name, company_domain, name, stage, status, value,
 *   currency, close_date, roster_ids, roster_count, roster_people: { id, name, photo }[] }[]
 */
export async function listWorkspaceDeals(supabase, workspaceId, { status = 'all', visibleCompanyIds = null, windowed = false, owner = null } = {}) {
  const entities = await allRows((from, to) => supabase.from('entities').select('id')
    .eq('workspace_id', workspaceId).eq('type', 'deal').order('id').range(from, to));
  const ids = entities.map(e => e.id);
  if (!ids.length) return [];

  const [claims, belongs, roster] = await Promise.all([
    inBatches(ids, async (batch) => {
      const { data, error } = await supabase.from('claims').select('entity_id, property, value')
        .eq('workspace_id', workspaceId).in('entity_id', batch).in('property', PROPS).is('invalid_at', null);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    inBatches(ids, async (batch) => {
      const { data, error } = await supabase.from('relationships').select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'belongs_to').in('from_entity_id', batch).is('valid_to', null);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    inBatches(ids, async (batch) => allRows((from, to) => supabase.from('relationships').select('from_entity_id, to_entity_id')
      .eq('workspace_id', workspaceId).eq('type', 'stakeholder_of').in('to_entity_id', batch).is('valid_to', null)
      .order('id').range(from, to))),
  ]);

  const byId = new Map(ids.map(id => [id, { id, company_id: null, roster_ids: [], roster_count: 0, claims: {} }]));
  for (const c of claims) { const d = byId.get(c.entity_id); if (d) d.claims[c.property] = c.value; }
  for (const r of belongs) { const d = byId.get(r.from_entity_id); if (d && !d.company_id) d.company_id = r.to_entity_id; }
  for (const r of roster) {
    const d = byId.get(r.to_entity_id);
    if (!d) continue;
    d.roster_count++;
    d.roster_ids.push(r.from_entity_id);
  }

  let deals = [...byId.values()].map(d => {
    const name = str(d.claims.name);
    const stage = str(d.claims.stage);
    return {
      id: d.id, company_id: d.company_id, name: name || 'Untitled deal', stage,
      status: crmDealState({ status: str(d.claims.status), stage }),
      value: num(d.claims.value), currency: str(d.claims.currency), close_date: str(d.claims.close_date),
      owner_name: str(d.claims.owner_name) ?? str(d.claims.owner_email),
      roster_ids: d.roster_ids, roster_count: d.roster_count,
    };
  });
  // A deal that hangs off no account can't be opened from one; the deal page lives under it.
  deals = deals.filter(d => d.company_id);
  if (visibleCompanyIds) deals = deals.filter(d => visibleCompanyIds.has(d.company_id));
  if (windowed) { const cutoff = lostCutoff(); deals = deals.filter(d => inDealWindow(d, cutoff)); }
  // The viewer's own deals. `owner_name` above already falls back to the owner's EMAIL when the
  // CRM gave no name, so both sets are tested against the one field.
  if (owner) {
    const mine = new Set([...(owner.names ?? []), ...(owner.emails ?? [])].map(v => String(v).toLowerCase()));
    if (mine.size) deals = deals.filter(d => d.owner_name && mine.has(String(d.owner_name).toLowerCase()));
  }
  if (status !== 'all') deals = deals.filter(d => d.status === status);

  const companyIds = [...new Set(deals.map(d => d.company_id))];
  const companies = await inBatches(companyIds, async (batch) => {
    const { data, error } = await supabase.from('companies').select('id, name, domain')
      .eq('workspace_id', workspaceId).in('id', batch);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  const coById = new Map(companies.map(c => [c.id, c]));

  // The faces on each deal, resolved here: the browser's contact list is capped, so a large
  // workspace's deals would otherwise show nobody on them.
  // Faces for the first five on each deal; the full roster stays in roster_ids (the revenue report reads it).
  const personIds = [...new Set(deals.flatMap(d => d.roster_ids.slice(0, 5)))];
  const people = await inBatches(personIds, async (batch) => {
    const { data, error } = await supabase.from('contacts').select('id, first_name, last_name, email, photo_url')
      .eq('workspace_id', workspaceId).in('id', batch);
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  const personById = new Map(people.map(p => [p.id, {
    id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unknown', photo: p.photo_url || null,
  }]));

  return deals.map(d => ({
    ...d,
    company_name: coById.get(d.company_id)?.name ?? null,
    company_domain: coById.get(d.company_id)?.domain ?? null,
    roster_people: d.roster_ids.slice(0, 5).map(id => personById.get(id)).filter(Boolean),
  }));
}
