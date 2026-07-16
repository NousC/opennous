// Company firmographics — the feature layer the ICP model actually thinks with.
//
// WHY THIS EXISTS
//
// The scorecard's four company features are `industry`, `employee_count`, `keywords`
// and `description`. Six of the twelve active signals read `keywords` — every one that
// defines who we sell to (ai_native_gtm_service, account_data_heavy_gtm,
// multi_client_gtm_agency, claude_terminal_native, internal_gtm_revops_team) plus both
// authored exclusions (exclude_cold_calling_agency, exclude_pure_branding_agency).
//
// On 2026-07-14, `keywords` existed on 3 companies out of ~360. So none of those signals
// had ever fired. The scorer was left with job title and headcount, 386 of 444 accounts
// fired the identical two signals, and the ICP score had exactly three possible values
// (95 / 85 / 50). The model was a headcount filter wearing a semantic model's clothes,
// and both exclusions were inert — a cold-calling agency scored 95 and went into
// outreach alongside the real ICP.
//
// The producers were fixed (leadLists.mjs now persists all four; the lead-builder,
// company-people and sales-nav skills now send them). This backfills the companies that
// were already in the graph before that.
//
// It also fixes the graph. Companies bridge to each other through SHARED CLAIMS, and
// with no keywords there was almost nothing to share: 8 tiny clusters. Every company
// gains 10-20 keyword claims here, which is what turns the account graph from 277
// disconnected two-node dumbbells into something with actual structure.
//
// COST: Apollo's organization enrichment is domain-based and does NOT consume email
// credits — it is the same data their people-search already returns nested under
// `organization`. We are re-reading something we already paid for.
import { getSupabaseClient, getOrCreateEntity, assertClaims } from '@nous/core';
import { getApolloKey } from './enrichment.mjs';

const APOLLO_ORG = 'https://api.apollo.io/api/v1/organizations/enrich';

// Apollo hands keywords back as an array of short tag strings. Cap the list: a company
// with 60 keywords contributes nothing more than one with 25, and the `contains_any`
// rules match against the joined text either way.
function normKeywords(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [...new Set(raw.map(k => String(k ?? '').trim()).filter(Boolean))].slice(0, 40);
  return out.length ? out : null;
}

async function fetchOrg(domain, apiKey) {
  const url = `${APOLLO_ORG}?domain=${encodeURIComponent(domain)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': apiKey },
  });
  if (res.status === 429) return { rateLimited: true };
  if (!res.ok) return { error: `${res.status}` };
  const j = await res.json().catch(() => null);
  return { org: j?.organization ?? null };
}

/**
 * Backfill industry / employee_count / keywords / description onto company entities
 * from Apollo, for every company that is missing `keywords`.
 *
 * Only fills what is MISSING — never overwrites a claim that already exists, so a
 * hand-corrected industry or a richer signal-scan description survives.
 */
export async function backfillCompanyFirmographics(workspaceId, opts = {}) {
  const { limit = 500, dryRun = false, onProgress = null } = opts;
  const supabase = getSupabaseClient();

  const apiKey = await getApolloKey(supabase, workspaceId);
  if (!apiKey) return { error: 'apollo_not_connected' };

  // Companies with a domain identifier. `keywords` is the marker: if it is there, the
  // company has been through this (or came in from lookalike-builder, which always sent
  // them), and there is nothing to do.
  const { data: companies, error } = await supabase
    .from('entities')
    .select('id, entity_identifiers!inner(kind, value)')
    .eq('workspace_id', workspaceId)
    .eq('type', 'company')
    .eq('entity_identifiers.kind', 'domain')
    .limit(limit);
  if (error) throw error;

  const { data: haveKeywords } = await supabase
    .from('claims')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .eq('property', 'keywords');
  const done = new Set((haveKeywords || []).map(c => c.entity_id));

  const todo = (companies || [])
    .map(c => ({ id: c.id, domain: (c.entity_identifiers?.[0]?.value || '').toLowerCase().trim() }))
    .filter(c => c.domain && !done.has(c.id));

  const out = { candidates: todo.length, enriched: 0, no_match: 0, failed: 0, keywords_added: 0, dryRun };
  if (dryRun) return out;

  for (const [i, c] of todo.entries()) {
    try {
      const { org, rateLimited, error: e } = await fetchOrg(c.domain, apiKey);
      if (rateLimited) { await new Promise(r => setTimeout(r, 4000)); out.failed++; continue; }
      if (e || !org) { out.no_match++; continue; }

      const values = {};
      const kw = normKeywords(org.keywords);
      if (kw) { values.keywords = kw; out.keywords_added++; }

      const desc = (org.short_description || org.description || '').trim();
      if (desc) values.description = desc;

      if (org.industry) values.industry = String(org.industry);
      const emp = Number(org.estimated_num_employees);
      if (Number.isFinite(emp) && emp > 0) values.employee_count = emp;

      if (!Object.keys(values).length) { out.no_match++; continue; }

      // getOrCreateEntity by domain resolves to the SAME company we selected, so this
      // never forks a duplicate. assertClaims pins them the way the pipeline does.
      const entityId = await getOrCreateEntity(supabase, workspaceId, 'company', [{ kind: 'domain', value: c.domain }]);
      await assertClaims(supabase, workspaceId, entityId, { values, source: 'apollo_org_backfill' });
      out.enriched++;

      if (onProgress && i % 25 === 0) onProgress({ ...out, done: i + 1, of: todo.length });
      // Apollo's org endpoint is generous but not unlimited. Pace it.
      await new Promise(r => setTimeout(r, 120));
    } catch {
      out.failed++;   // one bad domain must never abort the run
    }
  }
  return out;
}
