import { hubspotLinker, withDealLinks } from '../../lib/crmLinks.mjs';
import { PRODUCT_USAGE_PROPERTIES, productUsageFromClaims } from '../../lib/productUsage.mjs';
import { activeUsersTrendFor } from '../../lib/csHealth.mjs';
import { buildAccountHealth } from '../../lib/csReport.mjs';
import { listAccountSignals, filterByCitedClaimsForViewer, assertClaims, upsertIdentifier, normalizeStage, planAccountStage, accountStage, readTitle, roleFromAuthorityClaims, COMMITTEE_ROLE_RANK, listDocuments } from '@nous/core';
import { viewerReadContext, requestMessageViewer } from '../../lib/messagePrivacy.mjs';
import { Router } from 'express';
import {
  getSupabaseClient, listNotes, listAccountNotes, listActivities,
  computeDealHealth, loadHealthInputs, loadHealthHistory, loadNextSteps,
  computeAccountHealth, selectNextStep, loadEngagementActivity, loadAccountHealthTrend,
  getAccountRecord, fetchEntityOverlays, applyCompanyOverlay,
  getRelationshipOwners, getWorkspaceMemberProfiles, effectiveOwnerUserId, accountOwnerIds,
  assignRelationshipOwner, removeRelationshipMember, markEntityPersonal, getPersonalEntityIds, personalAccountIds,
} from '@nous/core';
import { verifySupabaseAuth } from '../../middleware/supabaseAuth.mjs';
import { intelTopicsFor } from '../../lib/intelTopics.mjs';
import { loadIntelTimeline, timelineDays } from '../../lib/intelTimeline.mjs';
import { auditFromReq } from '../../lib/audit.mjs';
import { getVisibilityScope, memberVisibleAccounts, entityVisibleToMember, viewerVisibleAccountSet } from '../../lib/visibility.mjs';
import { hasListRows, listRows, facesForAccounts, listDealRows, accountCountries, dealValueByCompany } from '../../lib/listRows.mjs';
import { dealVerdict, stalePipeline } from '../../lib/dealSignals.mjs';
import { listAccountDeals, getAccountDeal, withDealPipelines, readPrimaryPipelineRef, ACCOUNT_DEAL_ID } from '../../lib/accountDeals.mjs';
import { listWorkspaceDeals } from '../../lib/workspaceDeals.mjs';
import { resolveScopedOwner, readScope } from '../../lib/ownerScope.mjs';

import { enrichCompany } from '../../services/enrichment.mjs';
import { icpFit } from '../../lib/icpFit.mjs';
import { isWorkspaceMember } from '../../lib/authz.mjs';
import { markCompanyClient } from './contacts.mjs';
import { latestStages, lifecycleDeptScope, wonCompanyIds, ownerDeptForCompany } from './lifecycle.mjs';

/**
 * The Network accounts the Accounts list leaves out. Hidden is the default; the page's filter asks
 * for `network=show` to see them (GET-1019).
 */
export async function networkExcludeIds(supabase, workspaceId, query = {}, find = personalAccountIds) {
  return query.network === 'show' ? [] : [...await find(supabase, workspaceId)];
}

export const companiesApiRouter = Router();

/** /list's account rows (entity_list_rows) as the page reads them, with faces, deal value and CS status. */
async function accountRowsOut(supabase, workspaceId, rows) {
  const [faces, dealValues, csBags] = await Promise.all([
    facesForAccounts(supabase, workspaceId, rows.map(r => r.entity_id)),
    dealValueByCompany(supabase, rows.map(r => r.entity_id)),
    csBagsFor(supabase, workspaceId, rows.map(r => r.entity_id)),
  ]);
  return rows.map(r => {
    const cs = csBags.get(r.entity_id) ?? null;
    return {
      id: r.entity_id, name: r.name, domain: r.domain, industry: r.industry ?? null,
      icp_score: r.icp_score, deal_health_score: r.deal_health,
      people_count: r.people_count, people: faces.get(r.entity_id) ?? [],
      open_deals: r.open_deals, pipeline_value: r.pipeline_value, won_value: r.won_value,
      // What the implied deal is worth, when someone has said. CRM deals carry their own
      // amount in the deals payload; this is the account that has no CRM deal.
      deal_value: dealValues.get(r.entity_id) ?? null,
      last_activity_at: r.last_activity_at, lifecycle_stage: null,
      activity_count: 0, meeting_count: 0,
      // Already on the row listRows read and dropped here until the redesign asked for them.
      // owner_name is the AE (the account's CRM owner), selected once the ownership columns exist.
      owner_name: r.owner_name ?? null, country: r.country ?? null,
      // Whether the CRM calls them a customer, in its own words (cs.status), and what they pay.
      customer_status: customerStatusOf(cs), mrr: numOrNull(cs?.mrr),
    };
  });
}

// A Cloud surface may narrow the list to the accounts one of its objects works on (GET-873, GET-891;
// a seam since GET-910): { param, resolve(supabase, req, { workspaceId, id, q, limit, offset }) ->
// { page: { ids, total }, extra } }. `param` is the query parameter that names the object; `extra` is
// added to the answer (what the list is narrowed to). Registered by cloud/index.mjs.
let accountScope = null;
export function registerAccountScope(scope) { accountScope = scope ?? null; }

/** The CRM's owner names on an account's deals, open deals first, as the shape `owners` uses. */
async function crmOwnersOfAccount(supabase, workspaceId, companyId, memberProfiles) {
  const { data: links } = await supabase.from('relationships').select('from_entity_id')
    .eq('workspace_id', workspaceId).eq('type', 'belongs_to').eq('to_entity_id', companyId).limit(200);
  const dealIds = (links || []).map(l => l.from_entity_id);
  if (!dealIds.length) return [];
  const { data: rows } = await supabase.from('claims').select('entity_id, property, value')
    .eq('workspace_id', workspaceId).in('entity_id', dealIds).in('property', ['owner_name', 'status'])
    .is('invalid_at', null);
  const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const byDeal = new Map();
  for (const r of rows || []) { const d = byDeal.get(r.entity_id) ?? {}; d[r.property] = plain(r.value); byDeal.set(r.entity_id, d); }
  const names = [...byDeal.values()].filter(d => d.owner_name)
    .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1))
    .map(d => String(d.owner_name));
  return [...new Set(names)].slice(0, 3).map(name => {
    const mate = [...memberProfiles.entries()].find(([, p]) => p.name && p.name.toLowerCase() === name.toLowerCase());
    return { user_id: mate?.[0] ?? null, name, avatar: mate?.[1]?.avatar ?? null, from_crm: !mate };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const numOrNull = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// cs.status is normalised at sync time (accountHealth.ts normaliseStatus) to these four words.
const CUSTOMER_STATUSES = new Set(['client', 'cancelled', 'prospect', 'other']);
const customerStatusOf = (cs) => {
  const s = cs?.status == null ? '' : String(cs.status).trim().toLowerCase();
  return s ? (CUSTOMER_STATUSES.has(s) ? s : 'other') : null;
};

/**
 * The CRM's own account-health bag (`entity_list_rows.cs`, keyed without the `cs.` prefix:
 * status, mrr, health_score, owner_name, ...) for a set of accounts. listRows does not select the
 * bag, so these ids are read once more, 100 at a time (an `in` list is a URL). A database whose
 * `cs` column has not been migrated answers an empty map, never an error: the account list is the
 * floor of the app and must not fall over for a health field.
 */
async function csBagsFor(supabase, workspaceId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('entity_list_rows').select('entity_id, cs')
      .eq('workspace_id', workspaceId).eq('kind', 'account')
      .in('entity_id', ids.slice(i, i + 100)).not('cs', 'is', null);
    if (error) return out;
    for (const r of data ?? []) if (r.cs && typeof r.cs === 'object') out.set(r.entity_id, r.cs);
  }
  return out;
}

// PUT /api/companies/:id/reports-to — set / clear a person's manager on the org chart as a
// manual, sticky REPORTS_TO edge (re-extraction won't overwrite it). Body: { subject_id, object_id|null }.
companiesApiRouter.put('/:id/reports-to', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(403).json({ error: 'workspace_not_found_or_unauthorized' });
    const { subject_id, object_id } = req.body || {};
    if (!subject_id) return res.status(400).json({ error: 'subject_id_required' });
    // One manager per person: clear any existing reporting line first.
    await supabase.from('workspace_graph_edges').delete()
      .eq('workspace_id', workspaceId).eq('subject_id', subject_id).eq('relationship', 'REPORTS_TO');
    if (object_id && object_id !== subject_id) {
      const { data: cts } = await supabase.from('contacts').select('id, first_name, last_name, email')
        .eq('workspace_id', workspaceId).in('id', [subject_id, object_id]);
      const nameOf = (id) => { const c = (cts || []).find(x => x.id === id); return c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Unknown') : 'Unknown'; };
      await supabase.from('workspace_graph_edges').upsert({
        workspace_id: workspaceId, subject_type: 'contact', subject_id, subject_label: nameOf(subject_id),
        relationship: 'REPORTS_TO', object_type: 'contact', object_id, object_label: nameOf(object_id),
        source: 'manual', confidence: 1.0, metadata: { confidence_level: 'confirmed', confirmed: true },
      }, { onConflict: 'workspace_id,subject_label,relationship,object_label', ignoreDuplicates: false });
    }
    return res.json({ ok: true });
  } catch (err) { console.error('[PUT /api/companies/:id/reports-to]', err); return res.status(500).json({ error: 'internal_error' }); }
});

// POST /api/companies/recompute-health?workspaceId= — one-off/cron: recompute the
// contextual score for every in-touch company and persist it, so the board is correct
// even for accounts nobody has opened. Idempotent (writes only on change).
companiesApiRouter.post('/recompute-health', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.query.workspaceId || req.body?.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    // In-touch companies = those with at least one contact.
    const { data: cRows } = await supabase.from('contacts')
      .select('company_id').eq('workspace_id', workspaceId).not('company_id', 'is', null);
    const companyIds = [...new Set((cRows || []).map(r => r.company_id))];
    let updated = 0;
    for (const id of companyIds) {
      const { data: company } = await supabase.from('companies')
        .select('id, deal_health_score').eq('id', id).maybeSingle();
      if (!company) continue;
      const { notes, activity, stakeholders, nextSteps } = await loadHealthInputs(supabase, workspaceId, id);
      const dh = computeDealHealth({ company, notes, activity, stakeholders, nextSteps });
      if (dh.score != null && dh.score !== company.deal_health_score) {
        await supabase.from('companies')
          .update({ deal_health_score: dh.score, deal_health_computed_at: new Date().toISOString() })
          .eq('id', id);
        updated++;
      }
    }
    return res.json({ total: companyIds.length, updated });
  } catch (err) {
    console.error('[POST /api/companies/recompute-health]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/deals?workspaceId=&status=open|won|lost|all — every CRM deal in the workspace,
// for the Accounts page's Sales Pipeline (open) and Handoff (won) tabs (GET-267). Same account
// visibility as /list: a member on a closed workspace sees the deals of accounts in their book.
// Each deal carries the pipeline it is in (`pipeline`, `pipeline_id`), and the response carries
// the CRM's id for the workspace's primary pipeline (`primary_pipeline_ref`, null = unknown) so
// the list can tell a deal from another pipeline apart without hiding it.
//
// `scope=mine|team` (optional, the redesign's My book / Team toggle): team = every deal, mine = the
// viewer's own even for an admin, and an empty board with `scope_unmapped: true` when we cannot
// place them. Absent = the rule below, unchanged. Each deal also carries `health_score`,
// `health_reason` and `health_at` (Nous deal health, stored on the deal row by the worker), null
// for a deal not yet scored, a closed deal, and the claims fallback path.
companiesApiRouter.get('/deals', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const status = ['open', 'won', 'lost', 'all'].includes(req.query.status) ? req.query.status : 'all';
    let visibleCompanyIds = null;
    const vis = await getVisibilityScope(supabase, workspaceId, req);
    if (vis.restrict) visibleCompanyIds = (await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId)).companyIds;
    // Ask which path answers BEFORE walking either. The flattened rows serve this request on
    // their own, so assembling the same deals from claims and then discarding them was thousands of
    // deals of work on every board load of the workspace that needed the fast path most.
    const scope = readScope(req.query.scope);
    const [hasRows, primary_pipeline_ref, scoped, personal] = await Promise.all([
      hasListRows(supabase, workspaceId, 'deal'),
      readPrimaryPipelineRef(supabase, workspaceId),
      // Who is asking, in CRM terms. With no scope: null for an admin or anyone we cannot place,
      // and null is no filter, so a rep we failed to map sees the workspace, never an empty board.
      resolveScopedOwner(supabase, workspaceId, req, scope),
      // An account marked personal is someone we know, not a deal (GET-1014): not on the board.
      getPersonalEntityIds(supabase, workspaceId),
    ]);
    const notPersonal = (d) => !personal.has(d.company_id);
    const owner = scoped.owner;
    // Health per deal is read off the row, never computed per request: a board is thousands of
    // deals. listDealRows maps it from the row (dealHealthRefresh.mjs writes it twice a day).
    const withHealth = (d) => ({ ...d, health_score: d.health_score ?? null, health_reason: d.health_reason ?? null, health_at: d.health_at ?? null });
    if (scoped.unmapped) {
      return res.json({
        deals: [], stale: stalePipeline([]), counts: { customers: null },
        primary_pipeline_ref, scope, scope_unmapped: true,
      });
    }
    // Flattened rows when this workspace has them (GET-297): thousands of deals assembled from claims
    // is the same wall the accounts list hit, and the board fell back to 200 placeholder rows.
    if (hasRows) {
      const { data: wsRow } = await supabase.from('workspaces').select('focus_country, created_at').eq('id', workspaceId).maybeSingle();
      const asked = String(req.query.country ?? '').trim();
      const country = asked === 'all' ? null : (asked || wsRow?.focus_country || null);
      const rows = await listDealRows(supabase, workspaceId, { status: String(req.query.status ?? 'all'), country, focusCountry: wsRow?.focus_country ?? null, windowed: true, owner, pipelineRef: String(req.query.pipelineId ?? '').trim() || null });
      // Why an open deal looks dead, as evidence rather than a verdict (GET-352). We never write
      // a status — the rep reads this and closes it in HubSpot, and the status comes back to us
      // through the sync like any other fact. `stale` lets the board state what share of the
      // pipeline is rotten without anyone editing a number.
      //
      // The time-based signals are all this path can serve: the flattened deal row carries no
      // roster, so `contact_count` is absent and the single-threaded reason never fires here. It
      // is wired in dealSignals and waits on the deal projection carrying its people count — a
      // deliberate gap, not a silent one.
      const withSignals = rows.filter(notPersonal).map(r => withHealth({ ...r, verdict: dealVerdict(r) }));
      // How many customers there are, so the Customer success tab can show its count without
      // being opened. That tab's own payload walks every won deal's line items and every
      // account's reasons; it stays lazy. This is one head-count against an indexed column —
      // the number was simply absent until you clicked, which reads like the tab is broken.
      //
      // Counted here rather than derived from `rows`: the deals list is country-filtered and the
      // customer-success page is not, so deriving it would print a number that disagrees with
      // the page it labels.
      const { count: customers } = await supabase
        .from('entity_list_rows')
        .select('entity_id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId).eq('kind', 'account').gt('won_deals', 0);
      return res.json({
        deals: withSignals,
        stale: stalePipeline(rows.filter(notPersonal)),
        counts: { customers: customers ?? null },
        primary_pipeline_ref, country, focus_country: wsRow?.focus_country ?? null,
        ...(scope ? { scope, scope_unmapped: false } : {}),
      });
    }
    // No flattened rows yet (a fresh or small workspace): assemble from claims, same window.
    const crmDeals = await listWorkspaceDeals(supabase, workspaceId, { status, visibleCompanyIds, windowed: true, owner });
    const deals = await withDealPipelines(supabase, workspaceId, crmDeals.filter(notPersonal));
    return res.json({ deals: deals.map(withHealth), primary_pipeline_ref, ...(scope ? { scope, scope_unmapped: false } : {}) });
  } catch (err) {
    console.error('[GET /api/companies/deals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/list?q=&limit=&offset=
//
// A PAGE of accounts, with the workspace's real total beside it (GET-290). This used to read
// every company and hand the browser the lot: on a client workspace of about 9,000 accounts PostgREST
// returned its silent maximum of 1,000, so the page showed "Accounts 1000" and the other 8,000
// existed but could not be reached. Searching happens here too — a search that only looks at the
// rows the browser happens to hold is not a search.
companiesApiRouter.get('/list', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = String(req.query.q ?? '').trim();
    // A registered account scope (registerAccountScope above): only the accounts the named object works
    // on, resolved by its surface with its own access check and the viewer's account visibility. It
    // replaces the market and owner filters.
    const scopeId = accountScope ? String(req.query[accountScope.param] ?? '').trim() : '';
    if (scopeId) {
      let scoped;
      try {
        scoped = await accountScope.resolve(supabase, req, { workspaceId, id: scopeId, q, limit, offset });
      } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message });
        throw e;
      }
      const page = scoped.page;
      const rows = [];
      for (let i = 0; i < page.ids.length; i += 100) {
        const chunk = page.ids.slice(i, i + 100);
        rows.push(...(await listRows(supabase, workspaceId, 'account', { limit: chunk.length, refine: (qq) => qq.in('entity_id', chunk) })).rows);
      }
      const at = new Map(page.ids.map((id, i) => [id, i]));
      rows.sort((a, b) => at.get(a.entity_id) - at.get(b.entity_id));
      return res.json({
        companies: await accountRowsOut(supabase, workspaceId, rows),
        total: page.total, limit, offset, q: q || null, country: null, focus_country: null, countries: [],
        ...(scoped.extra ?? {}),
      });
    }

    // `scope=mine|team` (optional): see /deals above. Asked before either path, because "mine"
    // for a viewer we cannot place is an empty page on both.
    const scope = readScope(req.query.scope);
    const scopeFields = (unmapped = false) => (scope ? { scope, scope_unmapped: unmapped } : {});
    const mineScope = scope === 'mine' ? await resolveScopedOwner(supabase, workspaceId, req, scope) : null;
    if (mineScope?.unmapped) return res.json({ companies: [], total: 0, limit, offset, q: q || null, ...scopeFields(true) });

    // The flattened list, when this workspace has one (GET-296): one indexed read instead of a
    // page assembled from claims. 1.5ms for 200 accounts ordered by last activity — the query
    // that timed out. A workspace with no rows yet falls through to the substrate path below.
    if (await hasListRows(supabase, workspaceId, 'account')) {
      // Market focus (GET-311). `country=` narrows the list, `country=all` clears it, and nothing
      // asked means the workspace's own default — one customer's workspace opens on its home country because that is where
      // their founder sells. The page is told both, so it can show which filter is on and offer the
      // rest; the focus is never applied silently to a total.
      const { data: wsRow } = await supabase.from('workspaces').select('focus_country').eq('id', workspaceId).maybeSingle();
      const asked = String(req.query.country ?? '').trim();
      const country = asked === 'all' ? null : (asked || wsRow?.focus_country || null);
      // An account shows when it holds a deal the lists show, and when it is the viewer's.
      // Both are null-safe: an unmapped viewer sees the whole workspace exactly as before.
      const { owner } = mineScope ?? await resolveScopedOwner(supabase, workspaceId, req, scope);
      // A NEW WORKSPACE SEES ITS WHOLE BOOK (GET-557). The window shows accounts with a deal or
      // activity in the last 45 days — right for a working book, wrong in the first weeks, when the
      // CRM has just imported every account and the backfill has filed three months of history:
      // accounts touched 50 or 80 days ago were hidden, and the page showed a handful of its accounts. For the first
      // 30 days, no window.
      const isNew = wsRow?.created_at && Date.now() - Date.parse(wsRow.created_at) < 30 * 86_400_000;
      // A Network account (marked personal, or all its people are) is someone we know, not an
      // account we sell to: off this list; its people stay on People (GET-1017).
      const excludeIds = await networkExcludeIds(supabase, workspaceId, req.query);
      let { rows, total } = await listRows(supabase, workspaceId, 'account', { q, limit, offset, country, focusCountry: wsRow?.focus_country ?? null, windowed: !isNew, owner, excludeIds });
      // And when the window holds nothing at all, show the accounts there are.
      if (!isNew && !total && !q && !offset) {
        ({ rows, total } = await listRows(supabase, workspaceId, 'account', { q, limit, offset, country, focusCountry: wsRow?.focus_country ?? null, windowed: false, owner, excludeIds }));
      }
      const vis = await getVisibilityScope(supabase, workspaceId, req);
      let visible = rows;
      if (vis.restrict) {
        const { companyIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
        visible = rows.filter(r => companyIds.has(r.entity_id));
      }
      return res.json({
        companies: await accountRowsOut(supabase, workspaceId, visible),
        total, limit, offset, q: q || null,
        country, focus_country: wsRow?.focus_country ?? null, countries: await accountCountries(supabase, workspaceId),
        ...scopeFields(false),
      });
    }

    let query = supabase
      .from('companies')
      // NOTE: memory_summary is NOT selected — the deployed companies view doesn't
      // expose it yet (repo schema is ahead of prod). Naming it 500s the whole route.
      // The board card falls back to industry for its blurb.
      // NOT last_activity_at (GET-295): on this view that column is an aggregate over every
      // activity of every person at the account. Asking for it on 200 rows times the query out —
      // it is the single most expensive thing a list can name. The page shows last activity from
      // the deals it already loads; an account's own figure needs a stored projection, not a view.
      .select('id, name, domain, industry, employee_count, location, revenue_range, enrichment_status, deal_health_score, icp_score', { count: 'exact' })
      .eq('workspace_id', workspaceId);
    const network = await networkExcludeIds(supabase, workspaceId, req.query);
    if (network.length) query = query.not('id', 'in', `(${network.join(',')})`);
    if (q) {
      const like = `%${q.replace(/[%,()]/g, ' ')}%`;
      query = query.or(`name.ilike.${like},domain.ilike.${like}`);
    }
    // Ordered by ID, which is the only column of this view that costs nothing (GET-293).
    // `companies` is a VIEW over a very large claims table: every other column is a lookup per row,
    // so ORDER BY last_activity_at computes it for every one of thousands of accounts before it can return 200 —
    // the statement timed out and the page read "No accounts". The page is ordered by last
    // activity in the client, where it is 200 rows in memory rather than a table scan.
    const { data: companies, error, count: total } = await query
      .order('id')
      .range(offset, offset + limit - 1);
    if (error) throw error;

    // Account visibility: in a restricted workspace a member sees only the companies
    // they own / are in touch with. Owners+admins and open workspaces see all.
    let visibleCompanies = companies || [];
    const vis = await getVisibilityScope(supabase, workspaceId, req);
    if (vis.restrict) {
      const { companyIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
      visibleCompanies = visibleCompanies.filter(c => companyIds.has(c.id));
    }

    // Hard role-scoped visibility: a member with a department role only sees the accounts
    // their department currently OWNS in the lifecycle (Sales owns pipeline + expansion; CS
    // owns handoff → activation → active-customer). Leadership and unroled members see all.
    const lifecycleOverrides = await latestStages(supabase, workspaceId, visibleCompanies.map(c => c.id));
    const deptScope = await lifecycleDeptScope(supabase, workspaceId, req.internalUserId);
    if (deptScope) {
      const won = await wonCompanyIds(supabase, workspaceId);
      visibleCompanies = visibleCompanies.filter(c =>
        ownerDeptForCompany(lifecycleOverrides.get(c.id), won.has(c.id)) === deptScope);
    }

    // Board-card metrics. Aggregated server-side (company_engagement_counts RPC) over
    // the interaction.* events — contacts.interaction_count is null in prod, and a
    // client-side count would hit PostgREST's 1000-row cap (there are thousands of events).
    // The people on this PAGE's accounts: a few faces each and the real number, read for the
    // 200 accounts on screen rather than by pulling a workspace's tens of thousands of contacts into a browser.
    const pageIds = visibleCompanies.map(c => c.id);
    // WHO IS AT THIS ACCOUNT, read from the substrate rather than the `contacts` view (GET-294).
    // That view builds every column with a lookup per row, so filtering it by company_id cannot
    // use an index and the query timed out — the column showed "—" for every account and the
    // error was swallowed. The `works_at` edge is an indexed row, and a name is one claim.
    const peopleByCompany = new Map();     // a few faces for the avatars
    const peopleCount = new Map();
    if (pageIds.length) {
      const { data: edges } = await supabase.from('relationships')
        .select('from_entity_id, to_entity_id')
        .eq('workspace_id', workspaceId).eq('type', 'works_at')
        .in('to_entity_id', pageIds)
        .limit(20000);
      const faceIds = [];
      for (const e of edges ?? []) {
        peopleCount.set(e.to_entity_id, (peopleCount.get(e.to_entity_id) ?? 0) + 1);
        const faces = peopleByCompany.get(e.to_entity_id) ?? [];
        if (faces.length < 4) {
          faces.push({ id: e.from_entity_id, name: null, photo_url: null });
          peopleByCompany.set(e.to_entity_id, faces);
          faceIds.push(e.from_entity_id);
        }
      }
      // Names for the faces only — four per account, not a workspace of people.
      if (faceIds.length) {
        const nameOf = new Map();
        for (let i = 0; i < faceIds.length; i += 300) {
          const { data: nameClaims } = await supabase.from('claims')
            .select('entity_id, property, value')
            .eq('workspace_id', workspaceId)
            .in('entity_id', faceIds.slice(i, i + 300))
            .in('property', ['first_name', 'last_name'])
            .is('invalid_at', null);
          for (const c of nameClaims ?? []) {
            const v = c.value && typeof c.value === 'object' && 'value' in c.value ? c.value.value : c.value;
            if (v == null || v === '') continue;
            const cur = nameOf.get(c.entity_id) ?? {};
            cur[c.property] = String(v);
            nameOf.set(c.entity_id, cur);
          }
        }
        for (const faces of peopleByCompany.values()) {
          for (const f of faces) {
            const n = nameOf.get(f.id);
            f.name = n ? [n.first_name, n.last_name].filter(Boolean).join(' ') || null : null;
          }
        }
      }
    }

    // Activity counts per account are an aggregate over every interaction in the workspace. On a
    // client with a year of CRM history that is millions of rows behind a page nobody asked it
    // for — the list took so long the browser gave up and said "No accounts" (GET-292). The table
    // does not show these; the board card does, and a board is only useful at a readable size.
    const activityByCompany = new Map();
    const meetingByCompany = new Map();
    if ((total ?? 0) <= 1000) {
      const { data: counts, error: countErr } = await supabase.rpc('company_engagement_counts', { ws: workspaceId });
      if (countErr) console.error('[GET /api/companies/list] counts:', countErr.message);
      for (const r of counts ?? []) {
        activityByCompany.set(r.company_id, Number(r.activity_count) || 0);
        meetingByCompany.set(r.company_id, Number(r.meeting_count) || 0);
      }
    }

    // Lifecycle override stage (the latest handoff event per company, computed above). Null
    // = the account is still pre-sale and its stage derives from the sales ladder client-side.
    const dealValues = await dealValueByCompany(supabase, pageIds);
    const enriched = visibleCompanies.map((co) => ({
      ...co,
      activity_count: activityByCompany.get(co.id) ?? 0,
      meeting_count: meetingByCompany.get(co.id) ?? 0,
      lifecycle_stage: lifecycleOverrides.get(co.id) ?? null,
      // Rolled up HERE, over all of the account's people, because the browser is given four
      // faces rather than a workspace's tens of thousands of contacts (GET-290).
      people: (peopleByCompany.get(co.id) ?? []).filter(f => f.name),
      people_count: peopleCount.get(co.id) ?? 0,
      // A CRM deal's amount comes with the deals payload. This is the OTHER kind: an account
      // whose deal only exists because the account does, whose amount was typed on the deal
      // page and lives on its primary contact.
      deal_value: dealValues.get(co.id) ?? null,
      best_icp_score: co.icp_score ?? null,
      last_activity_at: null,
      // The flattened rows carry these; a workspace that has none yet has no owner, market or
      // health bag projected anywhere, so the substrate path says null rather than guessing.
      // Owner scoping lives on those rows too: `scope` only ever empties this page (unplaced
      // "mine", answered above), it does not filter it.
      owner_name: null, country: null, customer_status: null, mrr: null,
    }));
    // `total` is the workspace's own count, not this page's length, so the header can say how
    // many accounts there are rather than how many arrived.
    return res.json({ companies: enriched, total: total ?? enriched.length, limit, offset, q: q || null, ...scopeFields(false) });
  } catch (err) {
    console.error('[GET /api/companies/list]', err?.message || err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/by-domain
companiesApiRouter.get('/by-domain', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { domain, workspaceId } = req.query;
    if (!domain || !workspaceId) return res.status(400).json({ error: 'domain and workspaceId required' });

    const normalized = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().trim();
    const { data: company } = await supabase.from('companies').select('*').eq('workspace_id', workspaceId).eq('domain', normalized).maybeSingle();
    if (!company) return res.json({ company: null });

    const { count } = await supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('company_id', company.id);
    return res.json({ company: { ...company, contactCount: count || 0 } });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Set an account's stage by moving its people (GET-263). closed_won is the existing "mark as
// client" path; everything else is planAccountStage. An account whose deals come from a CRM
// takes its stage from those deals, so a hand-set stage there would contradict the CRM — refused.
async function setAccountStage(supabase, req, companyId, raw) {
  const target = normalizeStage(raw);
  if (!target) return { status: 400, body: { error: 'invalid_pipeline_stage' } };
  const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', companyId).maybeSingle();
  if (!company || !(await isWorkspaceMember(supabase, company.workspace_id, req.internalUserId))) {
    return { status: 404, body: { error: 'not_found' } };
  }
  const workspaceId = company.workspace_id;

  const { data: dealRels } = await supabase.from('relationships').select('from_entity_id')
    .eq('workspace_id', workspaceId).eq('to_entity_id', companyId).eq('type', 'belongs_to').is('valid_to', null).limit(50);
  const relIds = (dealRels || []).map(r => r.from_entity_id);
  if (relIds.length) {
    const { count } = await supabase.from('entities').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('type', 'deal').in('id', relIds);
    if (count) return { status: 409, body: { error: 'stage_from_crm_deals', message: "This account's stage comes from its deals in the CRM." } };
  }

  if (target === 'closed_won') {
    await markCompanyClient(supabase, workspaceId, companyId);
    return { status: 200, body: { ok: true, stage: target, moved: null } };
  }

  // Primary first: the healthiest person, the same one the deal value writes to.
  const { data: people } = await supabase.from('contacts').select('id, pipeline_stage')
    .eq('workspace_id', workspaceId).eq('company_id', companyId)
    .order('deal_health_score', { ascending: false, nullsLast: true });
  if (!people?.length) return { status: 409, body: { error: 'no_people', message: 'Add a person to this account before setting its stage.' } };

  const moves = planAccountStage(people, target);
  for (const m of moves) {
    // The same write a person's own stage change makes; the view's trigger records the history.
    const { error } = await supabase.from('contacts').update({ pipeline_stage: m.to })
      .eq('id', m.id).eq('workspace_id', workspaceId);
    if (error) throw error;
  }
  return { status: 200, body: { ok: true, stage: accountStage(people.map(p => moves.find(m => m.id === p.id)?.to ?? p.pipeline_stage)), moved: moves.length } };
}

// PATCH /api/companies/:id
companiesApiRouter.patch('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });

    // The account's stage is not a company column: it is its furthest-along person (accountStage,
    // the board's rule). Setting it moves the people so it reads back as exactly what was chosen
    // (GET-263). This used to fall through to the allow-list below and 400 on every change.
    if (req.body.pipeline_stage !== undefined) {
      const out = await setAccountStage(supabase, req, id, req.body.pipeline_stage);
      return res.status(out.status).json(out.body);
    }

    const allowed = ['name', 'industry', 'employee_count', 'location', 'revenue_range', 'domain'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key] === '' ? null : req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_fields' });
    updates.updated_at = new Date().toISOString();

    // Resolve the company's workspace and confirm the caller belongs to it — this
    // route takes no workspaceId, so the middleware couldn't check membership.
    const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', id).single();
    if (!company) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, company.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }

    if (updates.employee_count != null) {
      const n = Number(String(updates.employee_count).replace(/[^0-9]/g, ''));
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'invalid_employee_count' });
      updates.employee_count = n;
    }
    if (typeof updates.name === 'string') {
      updates.name = updates.name.trim();
      if (!updates.name) return res.status(400).json({ error: 'name_required' });
    }
    if (typeof updates.domain === 'string') updates.domain = updates.domain.trim().toLowerCase() || null;

    const { data, error } = await supabase.from('companies').update(updates).eq('id', id).eq('workspace_id', company.workspace_id).select('*').single();
    if (error) return res.status(500).json({ error: error.message });

    // A manual edit is ground truth. The view trigger only files it as one more observation, which
    // the next enrichment or CRM sync can outvote, so pin each field as an asserted claim (the
    // contact route does the same). The domain is an identifier: make the edited one the single
    // active domain, or the view keeps showing the old one.
    const ws = company.workspace_id;
    if (req.body.domain !== undefined) {
      let retire = supabase.from('entity_identifiers').update({ status: 'retired' })
        .eq('workspace_id', ws).eq('entity_id', id).eq('kind', 'domain').eq('status', 'active');
      if (updates.domain) retire = retire.neq('value', updates.domain);
      await retire;
      if (updates.domain) await upsertIdentifier(supabase, ws, id, 'domain', updates.domain);
    }
    const assertValues = {};
    for (const k of ['name', 'industry', 'employee_count', 'location', 'revenue_range']) {
      if (k in updates) assertValues[k] = updates[k];
    }
    if (Object.keys(assertValues).length) {
      await assertClaims(supabase, ws, id, { values: assertValues, source: 'manual' });
    }
    const { data: fresh } = await supabase.from('companies').select('*').eq('id', id).maybeSingle();
    return res.json({ company: fresh || data });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/companies/:id/mark-client — mark the whole company, and everyone at it, a client.
companiesApiRouter.post('/:id/mark-client', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', id).single();
    if (!company) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, company.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    await markCompanyClient(supabase, company.workspace_id, id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/companies/:id/mark-client]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/companies/:id/personal — mark (or unmark) the company as personal/network,
// not a deal. Sets a sticky is_personal claim so deal-risk / going-dark logic skips it.
// Body: { personal?: boolean } (defaults to true). Mirrors the contact endpoint.
companiesApiRouter.post('/:id/personal', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const on = req.body?.personal !== false; // default true; { personal: false } unmarks
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', id).single();
    if (!company) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, company.workspace_id, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    await markEntityPersonal(supabase, company.workspace_id, id, on);
    return res.json({ ok: true, is_personal: on });
  } catch (err) {
    console.error('[POST /api/companies/:id/personal]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/companies/:id/owner — manually assign or revoke the account owner.
// Body: { user_id, action?: 'assign' | 'remove' } (default 'assign'). Assigning sets
// the sticky owner and grants that member read access; removing revokes it.
companiesApiRouter.post('/:id/owner', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { user_id, action = 'assign' } = req.body || {};
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_id' });
    if (!user_id || !UUID.test(String(user_id))) return res.status(400).json({ error: 'user_id_required' });
    const { data: company } = await supabase.from('companies').select('workspace_id').eq('id', id).single();
    if (!company) return res.status(404).json({ error: 'not_found' });
    const workspaceId = company.workspace_id;
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) return res.status(404).json({ error: 'not_found' });
    if (!(await isWorkspaceMember(supabase, workspaceId, user_id))) return res.status(400).json({ error: 'not_a_workspace_member' });

    const rel = action === 'remove'
      ? await removeRelationshipMember(supabase, workspaceId, id, user_id)
      : await assignRelationshipOwner(supabase, workspaceId, id, user_id);
    // Provenance for the workspace access log: who granted/revoked whom, on what.
    auditFromReq(req, {
      action: action === 'remove' ? 'ownership.removed' : 'ownership.assigned',
      target_type: 'account', target_id: id, target_workspace_id: workspaceId,
      metadata: { member_user_id: user_id, via: 'manual' },
    });
    const ownerUserId = effectiveOwnerUserId(rel);
    const prof = ownerUserId ? (await getWorkspaceMemberProfiles(supabase, workspaceId)).get(ownerUserId) : null;
    return res.json({ ok: true, action, owner_user_id: ownerUserId ?? null, owner_name: prof?.name ?? null, owner_avatar: prof?.avatar ?? null });
  } catch (err) {
    console.error('[POST /api/companies/:id/owner]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/companies/enrich
companiesApiRouter.post('/enrich', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { domain, workspaceId, companyId } = req.body;
    if (!domain || !workspaceId) return res.status(400).json({ error: 'domain and workspaceId required' });

    const company = await enrichCompany(supabase, workspaceId, domain);
    if (!company) return res.json({ enriched: false, message: 'No data found for this domain' });

    // If a companyId was passed, merge the enriched data back onto it
    if (companyId && UUID.test(companyId)) {
      const { data: merged } = await supabase
        .from('companies')
        .update({
          name: company.name, industry: company.industry,
          employee_count: company.employee_count, location: company.location,
          tech_stack: company.tech_stack, enrichment_status: 'complete',
          enriched_at: new Date().toISOString(),
        })
        .eq('id', companyId)
        .eq('workspace_id', workspaceId)
        .select('*')
        .single();
      return res.json({ enriched: true, company: merged || company });
    }

    return res.json({ enriched: true, company });
  } catch (err) {
    if (err.code === 'enrichment_not_configured') {
      return res.status(503).json({
        error: 'enrichment_not_configured',
        message: 'Company enrichment requires PROSPERO_API_KEY. Add it to enable this feature.',
      });
    }
    console.error('[POST /api/companies/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/activity-and-memory
companiesApiRouter.get('/:id/activity-and-memory', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    const { data: contacts } = await supabase.from('contacts').select('id').eq('workspace_id', workspaceId).eq('company_id', id);
    const contactIds = (contacts || []).map(c => c.id);

    let activities = [], memories = [];
    if (contactIds.length) {
      // Message content only for the people who were on it (GET-244): listActivities applies the
      // participant rule for a named viewer; facts pulled out of those messages follow them (GET-253).
      activities = await listActivities(supabase, { contactIds, limit: 50, workspaceId }, viewerReadContext(req, workspaceId));
      memories = await listNotes(supabase, workspaceId, { entityIds: contactIds, limit: 20 }, viewerReadContext(req, workspaceId));
    }

    return res.json({ activities, memories });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/graph
companiesApiRouter.get('/:id/graph', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    const { data: company } = await supabase.from('companies').select('id, name, domain, deal_health_score, icp_score, icp_fit').eq('id', id).eq('workspace_id', workspaceId).single();
    if (!company) return res.status(404).json({ error: 'not_found' });

    const { data: contacts } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title, seniority, pipeline_stage, deal_health_score, last_activity_at').eq('workspace_id', workspaceId).eq('company_id', id).order('deal_health_score', { ascending: false, nullsLast: true });

    const contactIds = (contacts || []).map(c => c.id);
    let signals = [], memories = [];
    if (contactIds.length) {
      const cutoff = new Date(Date.now() - 1095 * 86400000).toISOString();
      // The same participant rule as every timeline (GET-244) — otherwise the graph endpoint is a
      // way around it.
      const acts = await listActivities(supabase, { contactIds, since: cutoff, limit: contactIds.length * 4, workspaceId }, viewerReadContext(req, workspaceId));
      const counts = {};
      signals = acts.filter(a => { counts[a.contact_id] = (counts[a.contact_id] || 0) + 1; return counts[a.contact_id] <= 4; });

      // Latest 2 notes per contact — entity_id == contact_id in v2.
      const memResults = await Promise.all(contactIds.map(cid =>
        listNotes(supabase, workspaceId, { entityId: cid, limit: 2 }, viewerReadContext(req, workspaceId)),
      ));
      memories = memResults.flatMap((notes, i) =>
        notes.map(m => ({ ...m, contact_id: contactIds[i] })),
      );
    }

    return res.json({ company, contacts: contacts || [], signals, memories });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/detail — the account-record briefing for the company
// detail page. One call returns everything the page renders, so the frontend
// stops fetching contacts one-by-one:
//   company   — the v1 row with the v2 substrate overlaid (tech_stack, claims)
//   icp       — the latest ICP fit prediction for the account
//   stakeholders — contacts ranked by deal health, each with seniority, stage,
//                  ICP fit, and a recent-signal count (the stakeholder map)
//   edges     — workspace_graph_edges touching those contacts (how they relate)
//   activity  — the merged recent activity feed across all the company's contacts
//   facts     — the entity's claims with their epistemics (confidence, freshness,
//               observation_count, last_observed_at). companies.id IS the entity
//               id, so this is the same record get_account returns to an agent.
companiesApiRouter.get('/:id/detail', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });

    // NAMED COLUMNS, never `*` (GET-312). `companies` is a view over the claims table and its
    // `last_activity_at` is an aggregate over every activity of every person at the account:
    // measured on one customer account, the same row costs 146ms without that column and TIMES OUT
    // at 8s with it. `select *` asks for it, so opening an account returned nothing.
    //
    // The list's own last-activity comes from entity_list_rows, which is where the page reads it.
    const { data: companyRow, error: companyErr } = await supabase
      .from('companies')
      .select('id, workspace_id, created_at, domain, hubspot_company_id, apollo_account_id, pipedrive_org_id, attio_company_id, name, industry, employee_count, location, revenue_range, tech_stack, enrichment_status, enriched_at, icp_score, icp_fit, icp_reasoning, icp_scored_at, deal_health_score, deal_health_computed_at, apollo_raw, updated_at')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    // A failed read is not a missing account. Reporting the timeout above as 404 told the operator
    // the account did not exist while it sat in the list behind them.
    if (companyErr) {
      console.error('[GET /api/companies/:id/detail] load failed:', companyErr.message);
      return res.status(503).json({ error: 'account_unavailable', detail: companyErr.message });
    }
    if (!companyRow) return res.status(404).json({ error: 'not_found' });

    // Account-visibility gate: a member on a closed (owner-scoped) workspace may only open
    // accounts in their own book. 404 so we don't reveal the account exists. (getAccountRecord
    // below shares a visible account's claims by design, so the gate must be here.)
    const viewerId = req.internalUserId ?? req.memberUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'not_found' });
    }

    const { data: contactRows } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email, job_title, seniority, department, pipeline_stage, deal_health_score, deal_value, photo_url, last_activity_at')
      .eq('workspace_id', workspaceId)
      .eq('company_id', id)
      .order('deal_health_score', { ascending: false, nullsLast: true });
    const contacts = contactRows || [];
    const contactIds = contacts.map(c => c.id);

    // Overlays carry the v2 substrate: the company's claims/tech_stack and each
    // contact's latest ICP-fit prediction. One batched call for the whole set.
    const overlays = await fetchEntityOverlays(supabase, [id, ...contactIds]);
    const company = applyCompanyOverlay(companyRow, overlays.get(id));

    // Recent activity across every contact + a per-contact signal count (90d) so
    // the stakeholder map can flag who's engaged and who's gone quiet.
    let activity = [];
    const signalCount = {};
    // Resolved once, reused for owner attribution below.
    const memberProfiles = await getWorkspaceMemberProfiles(supabase, workspaceId);
    if (contactIds.length) {
      const cutoff = new Date(Date.now() - 1095 * 86400000).toISOString();
      // Message content only for the people who were on it (GET-244). A solo workspace needs no
      // exception: its one member's own mail is always theirs to read.
      activity = await listActivities(supabase, { contactIds, since: cutoff, limit: 100, workspaceId }, viewerReadContext(req, workspaceId));
      const nameById = Object.fromEntries(
        contacts.map(c => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email]),
      );
      for (const a of activity) {
        signalCount[a.contact_id] = (signalCount[a.contact_id] || 0) + 1;
        a.contactName = nameById[a.contact_id] || null;
      }
    }

    // Relationships between the company's people — how they relate to each other.
    let edges = [];
    if (contactIds.length) {
      const { data } = await supabase
        .from('workspace_graph_edges')
        .select('subject_type, subject_id, subject_label, relationship, object_type, object_id, object_label, confidence, source_memory_id, metadata')
        .eq('workspace_id', workspaceId)
        .in('subject_id', contactIds);
      // An edge carries the fact it was read out of (metadata.fact) — it follows that fact (GET-253).
      edges = await filterByCitedClaimsForViewer(supabase, workspaceId, data || [],
        await requestMessageViewer(supabase, req, workspaceId), (e) => [e.source_memory_id]);
    }

    // Committee role per person — from influence edges, then from what someone SAID about
    // their authority, then the job title. Surfaces on the org-chart card; `role_basis` says
    // which it was.
    const roleByContact = new Map();
    for (const e of edges) {
      const s = e.subject_id; if (!s) continue;
      const r = e.relationship === 'CHAMPIONS' ? 'champion'
        : e.relationship === 'BLOCKS' ? 'blocker'
        : (e.relationship === 'BUDGET_HOLDER_AT' || e.relationship === 'DEFERS_TO_BUDGET') ? 'economic_buyer'
        : e.relationship === 'DECISION_MAKER_AT' ? 'decision_maker' : null;
      if (!r) continue;
      const cur = roleByContact.get(s);
      if (!cur || COMMITTEE_ROLE_RANK[r] > COMMITTEE_ROLE_RANK[cur]) roleByContact.set(s, r);
    }

    // Per-stakeholder sentiment and authority for the org chart, in one batched query.
    // Sentiment: an OPEN objection leans detractor, a buying signal leans supporter.
    // Authority: the claim carries the role it stated, so a person saying "Avery signs off on
    // anything over 10k" beats a regex guessing from Avery's job title (GET-340).
    const sentimentByContact = new Map();
    const authorityByContact = new Map();
    if (contactIds.length) {
      const { data: stanceRows } = await supabase.from('claims')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
        .in('entity_id', contactIds)
        .or('value->>category.eq.objection,value->>category.eq.buying_signal,value->>category.eq.authority');
      const authorityRows = new Map();
      for (const r of stanceRows || []) {
        const cat = (r.value?.category || '').toLowerCase();
        if (cat === 'authority') {
          if (!authorityRows.has(r.entity_id)) authorityRows.set(r.entity_id, []);
          authorityRows.get(r.entity_id).push(r);
          continue;
        }
        const m = sentimentByContact.get(r.entity_id) || { obj: 0, buy: 0 };
        if (cat === 'objection' && (r.value?.metadata?.status || 'open') === 'open') m.obj++;
        else if (cat === 'buying_signal') m.buy++;
        sentimentByContact.set(r.entity_id, m);
      }
      for (const [id, rows] of authorityRows) {
        const role = roleFromAuthorityClaims(rows);   // one rule, shared with committee.ts
        if (role) authorityByContact.set(id, role);
      }
    }

    // Two evidence sources, ranked against each other rather than one silently shadowing the
    // other: a CHAMPIONS edge should outrank a decision_maker claim, and does.
    const evidenceRoleOf = (id) => {
      const fromEdge = roleByContact.get(id), fromClaim = authorityByContact.get(id);
      if (!fromEdge) return fromClaim ?? null;
      if (!fromClaim) return fromEdge;
      return COMMITTEE_ROLE_RANK[fromClaim] > COMMITTEE_ROLE_RANK[fromEdge] ? fromClaim : fromEdge;
    };
    const roleOf = (c) => evidenceRoleOf(c.id) || readTitle(c.job_title).role || 'contact';
    const roleBasis = (c) => evidenceRoleOf(c.id) ? 'evidence' : readTitle(c.job_title).role ? 'title' : null;
    const sentimentOf = (id) => {
      const m = sentimentByContact.get(id);
      // No objection and no buying signal on record is not "neutral", it is unknown: say nothing
      // rather than badge a person we have never heard from as a considered stance.
      if (!m) return null;
      if (m.buy > m.obj) return 'supporter';
      if (m.obj > m.buy) return 'detractor';
      return 'neutral';
    };

    const stakeholders = contacts.map(c => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
      title: c.job_title || null,
      seniority: c.seniority || null,
      department: c.department || null,
      pipeline_stage: c.pipeline_stage || 'identified',
      deal_health_score: c.deal_health_score ?? null,
      deal_value: c.deal_value ?? null,
      photo_url: c.photo_url || null,
      icp_score: overlays.get(c.id)?.prediction?.score ?? null,
      last_activity_at: c.last_activity_at || null,
      signal_count: signalCount[c.id] || 0,
      sentiment: sentimentOf(c.id),
      role: roleOf(c),
      role_basis: roleBasis(c),
      tier: readTitle(c.job_title).tier,
    }));

    const [account, icp] = await Promise.all([
      // ctx scopes recent_observations to the viewer (claims/facts stay shared).
      getAccountRecord(supabase, workspaceId, id, viewerReadContext(req, workspaceId)),
      icpFit(supabase, workspaceId, id),
    ]);

    // Buying signals — signal.* state claims on the company entity (signal-scan /
    // record_signal write these). Companies are entities too, so the same query
    // the contact endpoint uses works here. Signals are company-level by nature,
    // so they belong on the company record, not only the person.
    const { data: sigRows } = await supabase.from('claims')
      .select('property, value, computed_at')
      .eq('entity_id', id).like('property', 'signal.%')
      .is('invalid_at', null)
      .order('computed_at', { ascending: false });
    const signals = (sigRows || []).map(s => ({
      signal_class: (s.property || '').replace(/^signal\./, ''),
      detected:   s.value?.detected ?? null,
      implies:    s.value?.implies ?? null,
      score:      s.value?.score ?? null,
      approach:   s.value?.approach ?? null,
      angle:      s.value?.angle ?? null,
      updated_at: s.computed_at,
    }));

    // Notes/documents saved ON the company entity (signal-scan briefs, research,
    // meeting notes), plus the deal facts its people voiced (objections, budget,
    // timeline, …). Limit 200 on the company's own (not 50): rich accounts carry 100+
    // notes, and the chips + Deal Health read from this set.
    const notes = await listAccountNotes(supabase, workspaceId, id, contactIds, {}, viewerReadContext(req, workspaceId));
    // The same facts grouped into topics (stored; rebuilt in the background when new facts land).
    const intel_topics = await intelTopicsFor(supabase, workspaceId, id, notes || [],
      () => listAccountNotes(supabase, workspaceId, id, contactIds)).catch(() => null);

    // Owner — the rep carrying this account. Prefer the company entity's own owner;
    // else the primary owner of the healthiest contact, so the company shows who's
    // actually in contact even when the owner lives on the person (stakeholders are
    // already sorted by deal_health desc).
    const ownerMap = await getRelationshipOwners(supabase, workspaceId, [id, ...contactIds]);
    let ownerUserId = effectiveOwnerUserId(ownerMap.get(id));
    if (!ownerUserId) {
      for (const s of stakeholders) { const eff = effectiveOwnerUserId(ownerMap.get(s.id)); if (eff) { ownerUserId = eff; break; } }
    }
    if (ownerUserId) {
      const prof = memberProfiles.get(ownerUserId);
      company.owner_user_id = ownerUserId;
      company.owner_name = prof?.name ?? null;
      company.owner_avatar = prof?.avatar ?? null;
    }
    // Every owner, not only the first: two reps on one account is exactly what the record should
    // show (GET-268). The company's own owner first, then its people's.
    company.owners = accountOwnerIds([ownerMap.get(id), ...contactIds.map(cid => ownerMap.get(cid))])
      .map(uid => ({ user_id: uid, name: memberProfiles.get(uid)?.name ?? null, avatar: memberProfiles.get(uid)?.avatar ?? null }))
      .filter(o => o.name);
    // No teammate owns it, but the CRM names who does (GET-272): an imported portal's reps are
    // rarely all seats. Show the CRM deal owners by name, unlinked, instead of an empty owner.
    // A rep who later joins with the same name picks up their avatar through the same match.
    if (!company.owners.length) company.owners = await crmOwnersOfAccount(supabase, workspaceId, id, memberProfiles).catch(() => []);

    // Deal Health — computed here so the smart signals are authoritative + claim-driven,
    // and each references the claim ids (in `notes`) the UI expands as evidence.
    const nextSteps = await loadNextSteps(supabase, workspaceId, [id, ...contactIds]);
    const deal_health = computeDealHealth({ company, notes: notes || [], activity, stakeholders, nextSteps });
    // The trend behind the number: every score written for this account (the view's write
    // trigger has been recording them all along), so the card shows a line, not a dot.
    deal_health.history = await loadHealthHistory(supabase, workspaceId, id).catch(() => []);

    // Persist the contextual score back to the stored column (fire-and-forget, only when
    // it changed) so the Pipeline board — which reads the stored value — matches what the
    // record shows. Never blocks or fails the response.
    if (deal_health.score != null && deal_health.score !== company.deal_health_score) {
      supabase.from('companies')
        .update({ deal_health_score: deal_health.score, deal_health_computed_at: new Date().toISOString() })
        .eq('id', id).then(null, () => {});
    }

    // The account's own pages — its calls, briefs and plans, and those of its people.
    //
    // These used to live only in the Pages index, which is why they are arriving here: Pages is a
    // reports index, and nearly every document in it was about one account (GET-349). A call
    // summary is not something you browse to; you arrive at it from the account.
    //
    // Calls are kept apart from the rest because there are two orders of magnitude more of them,
    // and a brief buried under eighty call summaries is a brief nobody finds.
    let documents = [], calls = [];
    try {
      const docs = await listDocuments(supabase, workspaceId, {
        subjectEntityIds: [id, ...contactIds], limit: 300,
      });
      for (const d of docs) (d.kind === 'call' ? calls : documents).push(d);
    } catch (err) {
      // A page list failing must not take the account page down with it.
      console.warn('[GET /api/companies/:id/detail] documents failed', err.message);
    }

    // The CRM's own customer health for this account (status, MRR, its health score, the CS
    // owner): the same bag the Customers page reads, so the record and that page agree. HubSpot's
    // number, never ours, and null for an account the CRM does not treat as a customer.
    const csBag = (await csBagsFor(supabase, workspaceId, [id]).catch(() => new Map())).get(id) ?? null;
    // Active users vs ~30 days ago, from the daily snapshots (null until a month of history exists).
    const cs = csBag
      ? { ...csBag, active_users_trend: await activeUsersTrendFor(supabase, workspaceId, id, csBag.active_users_30d).catch(() => null) }
      : null;
    // Account health (GET-800): the account page reads the ACCOUNT, not a deal. Engagement trend,
    // decision makers covered, open blockers, risk signals, and adoption for a customer, from the
    // same facts and activity as above. Deal health stays in the payload for the deal surfaces.
    const isCustomer = String(cs?.status ?? '').toLowerCase() === 'client';
    // GET-804: the engagement windows read every activity row of the last 120 days on the company
    // and its people, not the feed's newest 100 above. A busy account fills 100 rows inside a month,
    // which left "the 30 before" at 0 on an account with a call and a thread in it. A call page is
    // dated by when the call happened (period_start), never by when it was written.
    const callPoints = calls.filter(c => c.period_start).map(c => ({ id: c.id, title: c.title, occurred_at: c.period_start }));
    const healthActivity = await loadEngagementActivity(supabase, workspaceId, [id, ...contactIds],
      { since: new Date(Date.now() - 120 * 86400000).toISOString() }).catch(() => activity);
    const account_health = computeAccountHealth({
      notes: notes || [], activity: healthActivity, calls: callPoints, stakeholders,
      customer: isCustomer ? { activeUsers: cs.active_users_30d, totalUsers: cs.total_users } : null,
    });
    // The latest follow-up agreed in the last two weeks, across calls, meetings and emails (GET-804).
    const next_step = selectNextStep({ activity: healthActivity, nextSteps, calls: callPoints });

    // Product usage from PostHog (GET-751): null unless the usage pull wrote it.
    const { data: usageRows } = await supabase.from('claims').select('property, value, computed_at')
      .eq('workspace_id', workspaceId).eq('entity_id', id).in('property', PRODUCT_USAGE_PROPERTIES).is('invalid_at', null);
    const product_usage = productUsageFromClaims(usageRows);

    // "Open in HubSpot": the portal + UI domain the sync learned, and the company's HubSpot id.
    const hsLink = await hubspotLinker(supabase, workspaceId).catch(() => null);
    const hubspotUrl = hsLink ? hsLink('company', company?.hubspot_company_id) : null;

    // Network (GET-1017): marked personal, or all its people are. The page drops the sales parts.
    const network = (await personalAccountIds(supabase, workspaceId, [id]).catch(() => new Set())).has(id);

    return res.json({
      company,
      network,
      icp: icp || null,
      stakeholders,
      edges,
      activity,
      facts: account ? Object.values(account.claims) : [],
      signals,
      notes: notes || [],
      intel_topics,
      deal_health,
      account_health,
      next_step,
      documents,
      calls,
      recent_observations: account?.recent_observations ?? [],
      cs,
      product_usage,
      // A deep link needs the portal id and its UI domain as well as the record id; null until the
      // sync has learned them (ensureHubspotPortal), rather than a link that lands on a login page.
      hubspot_url: hubspotUrl,
    });
  } catch (err) {
    console.error('[GET /api/companies/:id/detail]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// The account a deal request is for, behind the SAME gate as /detail: a member on a closed
// workspace only opens accounts in their own book, and a hidden account 404s so its deals
// don't reveal it exists. Returns the company row, or null after answering the request.
async function gatedCompany(supabase, req, res) {
  const { id } = req.params;
  const workspaceId = req.query.workspaceId;
  if (!UUID.test(id) || !workspaceId) { res.status(400).json({ error: 'invalid params' }); return null; }
  const { data: company } = await supabase.from('companies').select('*')
    .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
  const viewerId = req.internalUserId ?? req.memberUserId ?? null;
  if (!company || !(await entityVisibleToMember(supabase, workspaceId, viewerId, id, { isAdmin: req.viewerScope === 'admin' }))) {
    res.status(404).json({ error: 'not_found' }); return null;
  }
  return company;
}

// GET /api/companies/:id/deals?workspaceId= — the account's deals for the Deals tab (GET-262):
// open first, each with its people and its own health. An account with no CRM deal answers its
// implied deal (id 'account') so there is always one to open.
// GET /api/companies/:id/signals?workspaceId=&days=7 — what changed on the account (GET-686):
// objections, competitors, stakeholders, budget, missed or slipped next steps, expansion and churn,
// newest first. A next step agreed is a task, not a signal, so it is left out (GET-954).
companiesApiRouter.get('/:id/signals', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    const days = Number(req.query.days) || 7;
    return res.json({ days, signals: await listAccountSignals(supabase, req.query.workspaceId, company.id, { days, forPeople: true }) });
  } catch (err) {
    console.error('[GET /api/companies/:id/signals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/intel-timeline?workspaceId=&days=90|30|all — the account's facts on a time
// axis by when they were said, in topic lanes, with each retired fact linked to what replaced it
// (GET-794). Same gate as /detail; facts follow the viewer's privacy filter.
companiesApiRouter.get('/:id/intel-timeline', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    const workspaceId = req.query.workspaceId;
    return res.json(await loadIntelTimeline(supabase, workspaceId, company.id, timelineDays(req.query.days),
      viewerReadContext(req, workspaceId)));
  } catch (err) {
    console.error('[GET /api/companies/:id/intel-timeline]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/account-health?workspaceId= — a customer's health (GET-692): which list
// the Customers page puts it on and the reasons why, from the same classifier. `state` is null for
// an account that is not a customer, where the page shows deal health instead.
companiesApiRouter.get('/:id/account-health', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    return res.json(await buildAccountHealth(supabase, req.query.workspaceId, company.id));
  } catch (err) {
    console.error('[GET /api/companies/:id/account-health]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/account-health-trend?workspaceId= — the Nous account health over time
// (GET-804): weekly points backfilled over 60 days by scoring the account as of each date (activity
// up to it, claims valid on it), the stored daily snapshots, and today's score, one point a day.
// Reading it stores today's snapshot (an `account_health_score` state observation, once a day), so
// the line fills in with measured points as the account is worked. Team-readable inputs only: the
// trend, like the stored score, is shown to everyone.
companiesApiRouter.get('/:id/account-health-trend', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const workspaceId = req.query.workspaceId;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });
    // Named column only: `companies.*` carries an aggregate that times out on a busy account (GET-312).
    const { data: company } = await supabase.from('companies').select('id')
      .eq('id', id).eq('workspace_id', workspaceId).maybeSingle();
    const viewerId = req.internalUserId ?? req.memberUserId ?? null;
    if (!company || !(await entityVisibleToMember(supabase, workspaceId, viewerId, id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json(await loadAccountHealthTrend(supabase, workspaceId, id));
  } catch (err) {
    console.error('[GET /api/companies/:id/account-health-trend]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

companiesApiRouter.get('/:id/deals', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    const out = await listAccountDeals(supabase, req, req.query.workspaceId, company);
    // An account has a handful of deals, so each gets its "Open in HubSpot" link here.
    return res.json({ ...out, deals: await withDealLinks(supabase, req.query.workspaceId, out.deals ?? []) });
  } catch (err) {
    console.error('[GET /api/companies/:id/deals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/companies/:id/deals/:dealId?workspaceId= — one deal in full for the deal page: the
// deal, its stage movement, its people, the conversations filed to it, and its health.
companiesApiRouter.get('/:id/deals/:dealId', verifySupabaseAuth, async (req, res) => {
  try {
    const { dealId } = req.params;
    if (dealId !== ACCOUNT_DEAL_ID && !UUID.test(dealId)) return res.status(400).json({ error: 'invalid params' });
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    const out = await getAccountDeal(supabase, req, req.query.workspaceId, company, dealId);
    if (!out) return res.status(404).json({ error: 'not_found' });
    const [linked, overview] = await Promise.all([
      out.deal ? withDealLinks(supabase, req.query.workspaceId, [out.deal]).then(r => r[0]) : null,
      dealOverviewOf(supabase, req.query.workspaceId, dealId === ACCOUNT_DEAL_ID ? company.id : dealId),
    ]);
    return res.json({ ...(linked ? { ...out, deal: linked } : out), overview });
  } catch (err) {
    console.error('[GET /api/companies/:id/deals/:dealId]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * The deal's "How to win this deal" as last written (GET-793): on the deal entity, or on the
 * company for the account's own deal. Null when none was written yet; the page asks for one.
 */
async function dealOverviewOf(supabase, workspaceId, entityId) {
  const { data, error } = await supabase.from('claims').select('property, value')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).is('invalid_at', null)
    .in('property', ['deal_overview', 'deal_overview_at']);
  if (error) throw error;
  const by = Object.fromEntries((data ?? []).map(r => [r.property, r.value && typeof r.value === 'object' && 'value' in r.value ? r.value.value : r.value]));
  return by.deal_overview ? { text: String(by.deal_overview), at: by.deal_overview_at ? String(by.deal_overview_at) : null } : null;
}

// POST /api/companies/:id/deals/:dealId/overview?workspaceId= — write the deal's "How to win
// this deal" now (GET-793). Like the account summary: the model call is the worker's.
companiesApiRouter.post('/:id/deals/:dealId/overview', verifySupabaseAuth, async (req, res) => {
  try {
    const { dealId } = req.params;
    if (dealId !== ACCOUNT_DEAL_ID && !UUID.test(dealId)) return res.status(400).json({ error: 'invalid params' });
    const supabase = getSupabaseClient();
    const company = await gatedCompany(supabase, req, res);
    if (!company) return;
    const workerUrl = process.env.NOUS_WORKER_URL;
    if (!workerUrl || !process.env.WORKER_SECRET) return res.status(503).json({ error: 'overview_unavailable' });
    const r = await fetch(`${workerUrl.replace(/\/+$/, '')}/internal/deal-overview`, {
      method: 'POST',
      headers: { 'x-worker-secret': process.env.WORKER_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: req.query.workspaceId, companyId: company.id, dealId }),
      signal: AbortSignal.timeout(270_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: body.error || 'overview_failed' });
    return res.json(body);
  } catch (err) {
    console.error('[POST /api/companies/:id/deals/:dealId/overview]', err);
    return res.status(502).json({ error: 'overview_failed' });
  }
});

// POST /api/companies/:id/summary?workspaceId= — rewrite the account summary now (the refresh
// button on AI Overview). The model call lives in the worker; this forwards over the compose
// network and returns the new text (GET-223).
companiesApiRouter.post('/:id/summary', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const workspaceId = req.query.workspaceId || req.body?.workspaceId;
    if (!UUID.test(id) || !workspaceId) return res.status(400).json({ error: 'invalid params' });
    if (!(await isWorkspaceMember(supabase, workspaceId, req.internalUserId))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const viewerId = req.internalUserId ?? req.memberUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'not_found' });
    }
    const workerUrl = process.env.NOUS_WORKER_URL;
    if (!workerUrl || !process.env.WORKER_SECRET) return res.status(503).json({ error: 'summary_unavailable' });

    const r = await fetch(`${workerUrl.replace(/\/+$/, '')}/internal/company-summary`, {
      method: 'POST',
      headers: { 'x-worker-secret': process.env.WORKER_SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, companyId: id }),
      // The worker's model call can time out once and fall back to a second model.
      signal: AbortSignal.timeout(270_000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: body.error || 'summary_failed' });
    return res.json(body);
  } catch (err) {
    console.error('[POST /api/companies/:id/summary]', err);
    return res.status(502).json({ error: 'summary_failed' });
  }
});

// GET /api/companies/graph-edges — all workspace_graph_edges for the Mind view
companiesApiRouter.get('/graph-edges', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: edges } = await supabase
      .from('workspace_graph_edges')
      .select('subject_type, subject_id, subject_label, relationship, object_type, object_id, object_label, confidence')
      .eq('workspace_id', workspaceId)
      .limit(2000);
    return res.json({ edges: edges ?? [] });
  } catch (err) {
    console.error('[GET /api/companies/graph-edges]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /api/companies/:id
companiesApiRouter.delete('/:id', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { id } = req.params;
    const { workspaceId } = req.query;
    if (!UUID.test(id)) return res.status(400).json({ error: 'invalid_company_id' });
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });
    const { data: company } = await supabase.from('companies').select('id').eq('id', id).eq('workspace_id', workspaceId).single();
    if (!company) return res.status(404).json({ error: 'company_not_found' });
    // Dropping an account drops its people too — an auto-created lead that turned out
    // not to be real shouldn't leave its contacts orphaned in the People list.
    const { data: people } = await supabase.from('contacts').select('id').eq('workspace_id', workspaceId).eq('company_id', id);
    const peopleIds = (people || []).map((p) => p.id);
    if (peopleIds.length) {
      await supabase.from('entities').update({ merged_into: null }).in('merged_into', peopleIds);
      await supabase.from('entities').delete().in('id', peopleIds);
    }
    await supabase.from('companies').delete().eq('id', id);
    return res.json({ success: true, deleted_people: peopleIds.length });
  } catch (err) {
    console.error('[DELETE /api/companies/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/contact-graph
companiesApiRouter.get('/contact-graph', verifySupabaseAuth, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { ids, workspaceId, companyName } = req.query;
    if (!ids || !workspaceId) return res.status(400).json({ error: 'ids and workspaceId required' });

    const contactIds = String(ids).split(',').filter(id => UUID.test(id.trim())).map(id => id.trim());
    if (!contactIds.length) return res.status(400).json({ error: 'no valid ids' });

    const { data: contacts } = await supabase.from('contacts').select('id, first_name, last_name, email, job_title, pipeline_stage, deal_health_score, last_activity_at').eq('workspace_id', workspaceId).in('id', contactIds);

    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    // Only this workspace's people (the ids come from the client), and message content only for
    // the people who were on it (GET-244). This route returned full email bodies for any contact
    // id, to anyone signed in.
    const inWorkspace = (contacts || []).map(c => c.id);
    const acts = inWorkspace.length
      ? await listActivities(supabase, { contactIds: inWorkspace, since: cutoff, limit: inWorkspace.length * 4, workspaceId }, viewerReadContext(req, workspaceId))
      : [];
    const counts = {};
    const signals = acts.filter(a => { counts[a.contact_id] = (counts[a.contact_id] || 0) + 1; return counts[a.contact_id] <= 4; });

    const synthetic = { id: 'synthetic', name: companyName || 'Company', deal_health_score: null };
    return res.json({ company: synthetic, contacts: contacts || [], signals, memories: [] });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});
