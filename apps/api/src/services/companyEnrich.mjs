// Enrich one company (GET-669) — what it is, how big, where, and what it does — on the workspace's
// OWN enrichment keys. Nous supplies no data and pays for no lookup: no connected Apollo or Prospeo,
// no enrichment, said plainly (no_enrichment_provider), never a quiet fall back to a platform key.
//
//   1. Apollo's organization lookup by domain (it burns no email credits), when the workspace's
//      Apollo is connected with "use for enrichment" on.
//   2. Else Prospeo's company enrichment, on the workspace's Prospeo key.
//
// What comes back lands as OBSERVATIONS on the company, tagged with the provider that said it, and
// the claims are recomputed from them, the same way person enrichment lands. Every person at the
// company inherits these through works_at, so it is the fit layer of their scores that fills in:
// for Nous's own scorecard on the spot (the company's people are re-scored), and for a workspace's
// own scorer the next time it reads /v2/context.
//
// A company enriched in the last 90 days comes back from what we already hold, nothing spent; pass
// force to buy it again. Same rule as POST /v2/people/:id/enrich.
import { recordObservations, recomputeClaim, rescoreCompanyMembers, listSignals, getIcpScorer } from '@nous/core';
import { getApolloEnrichmentKey, getProspeoEnrichmentKey, PROSPEO_BASE, prospeoHeaders } from './enrichment.mjs';
import { fetchOrg, normKeywords } from './companyFirmographics.mjs';

export const COMPANY_ENRICH_PROPERTIES = ['industry', 'employee_count', 'keywords', 'description', 'location', 'tech_stack'];
const REUSE_DAYS = 90;
const PROVIDERS = ['apollo', 'prospeo'];

async function domainOf(supabase, workspaceId, entityId) {
  const { data, error } = await supabase.from('entity_identifiers')
    .select('value').eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .eq('kind', 'domain').eq('status', 'active').limit(1);
  if (error) throw new Error(`domain read failed: ${error.message}`);
  return (data?.[0]?.value ?? '').toLowerCase().trim() || null;
}

/** When this company was last enriched by a provider, and by which. */
export async function lastCompanyEnrichment(supabase, workspaceId, entityId) {
  const { data, error } = await supabase.from('observations')
    .select('source, observed_at').eq('workspace_id', workspaceId).eq('entity_id', entityId)
    .eq('method', 'enrichment').in('source', PROVIDERS)
    .order('observed_at', { ascending: false }).limit(1);
  if (error) throw new Error(`enrichment history read failed: ${error.message}`);
  return data?.[0] ? { at: data[0].observed_at, provider: data[0].source } : null;
}

/** Apollo's organization → the values we keep. Null when it knows nothing useful. */
export function valuesFromApollo(org) {
  if (!org) return null;
  const v = {};
  const kw = normKeywords(org.keywords);
  if (kw) v.keywords = kw;
  const desc = String(org.short_description || org.description || '').trim();
  if (desc) v.description = desc;
  if (org.industry) v.industry = String(org.industry);
  const emp = Number(org.estimated_num_employees);
  if (Number.isFinite(emp) && emp > 0) v.employee_count = emp;
  const loc = [org.city, org.state, org.country].filter(Boolean).join(', ');
  if (loc) v.location = loc;
  const tech = Array.isArray(org.current_technologies) ? org.current_technologies.map(t => t?.name).filter(Boolean).slice(0, 40) : [];
  if (tech.length) v.tech_stack = tech;
  return Object.keys(v).length ? v : null;
}

/** Prospeo's company → the values we keep. Null when it knows nothing useful. */
export function valuesFromProspeo(co) {
  if (!co) return null;
  const v = {};
  if (co.industry) v.industry = String(co.industry);
  const emp = Number(co.employee_count);
  if (Number.isFinite(emp) && emp > 0) v.employee_count = emp;
  const desc = String(co.description || '').trim();
  if (desc) v.description = desc;
  const kw = normKeywords(co.keywords);
  if (kw) v.keywords = kw;
  const loc = [co.location?.city, co.location?.country].filter(Boolean).join(', ');
  if (loc) v.location = loc;
  const tech = co.technology?.technology_names;
  if (Array.isArray(tech) && tech.length) v.tech_stack = tech.slice(0, 40);
  return Object.keys(v).length ? v : null;
}

async function fetchProspeo(domain, key, fetchImpl = fetch) {
  const res = await fetchImpl(`${PROSPEO_BASE}/enrich-company`, {
    method: 'POST', headers: prospeoHeaders(key), body: JSON.stringify({ data: { company_website: domain } }),
  });
  const body = await res.json().catch(() => ({}));
  if (body?.error) {
    if (body.error_code === 'NO_MATCH') return { company: null };
    return { error: `Prospeo ${body.error_code || res.status}` };
  }
  return { company: body?.company ?? null };
}

/**
 * Enrich one company entity. Returns one of:
 *   { status: 'no_domain' }                       — nothing to look it up by
 *   { status: 'no_enrichment_provider' }          — the workspace connected neither Apollo nor Prospeo
 *   { status: 'cached', last_enriched_at, provider }
 *   { status: 'no_match', provider }              — the provider has nothing on it
 *   { status: 'enriched', provider, fields_added, rescored }
 * Throws only on a provider or database error worth a 502/500.
 */
export async function enrichCompanyEntity(supabase, workspaceId, entityId, { force = false, keys = null, fetchImpl, deps = {} } = {}) {
  // Injectable for tests; the real ones by default.
  const record = deps.recordObservations ?? recordObservations;
  const recompute = deps.recomputeClaim ?? recomputeClaim;
  const lookupOrg = deps.fetchOrg ?? fetchOrg;
  const scorerOf = deps.getIcpScorer ?? getIcpScorer;
  const domain = await domainOf(supabase, workspaceId, entityId);
  if (!domain) return { status: 'no_domain' };

  const [apolloKey, prospeoKey] = keys
    ? [keys.apollo ?? null, keys.prospeo ?? null]
    : await Promise.all([getApolloEnrichmentKey(supabase, workspaceId), getProspeoEnrichmentKey(supabase, workspaceId)]);
  if (!apolloKey && !prospeoKey) return { status: 'no_enrichment_provider' };

  const last = await lastCompanyEnrichment(supabase, workspaceId, entityId);
  if (!force && last && Date.now() - new Date(last.at).getTime() < REUSE_DAYS * 86_400_000) {
    return { status: 'cached', last_enriched_at: last.at, provider: last.provider };
  }

  let provider = null, values = null, raw = null;
  if (apolloKey) {
    const r = await lookupOrg(domain, apolloKey);
    if (r.rateLimited) throw Object.assign(new Error('Apollo rate limited'), { code: 'provider_rate_limited' });
    if (r.org) { provider = 'apollo'; values = valuesFromApollo(r.org); raw = r.org; }
  }
  if (!values && prospeoKey) {
    const r = await fetchProspeo(domain, prospeoKey, fetchImpl);
    if (r.error) throw Object.assign(new Error(r.error), { code: 'provider_error' });
    if (r.company) { provider = 'prospeo'; values = valuesFromProspeo(r.company); raw = r.company; }
  }
  if (!values) return { status: 'no_match', provider: provider ?? (apolloKey ? 'apollo' : 'prospeo') };

  const at = new Date().toISOString();
  await record(supabase, Object.entries(values).map(([property, value]) => ({
    workspaceId, entityId, kind: 'state', property, value,
    source: provider, method: 'enrichment', sourceConfidence: 0.8, observedAt: at,
    raw: property === 'description' ? raw : null,
  })));
  for (const p of Object.keys(values)) {
    try { await recompute(supabase, workspaceId, entityId, p); }
    catch (e) { console.warn('[company enrich] recompute', p, e.message); }
  }

  // The company's people inherit this: re-score them on Nous's scorecard. A workspace that scores
  // with its own model is skipped inside (GET-586); its scorer reads the new facts on its next run.
  let rescored = 0;
  try {
    if (await scorerOf(supabase, workspaceId) === 'external') return { status: 'enriched', provider, fields_added: Object.keys(values), rescored };
    const signals = await listSignals(supabase, workspaceId);
    if (signals.some(s => s.active)) rescored = (await rescoreCompanyMembers(supabase, workspaceId, entityId, { signals })).rescored;
  } catch (e) { console.warn('[company enrich] rescore', e.message); }

  return { status: 'enriched', provider, fields_added: Object.keys(values), rescored };
}
