// The public API's read layer for accounts, deals and pipelines (/v2/accounts, /v2/deals,
// /v2/pipelines, and the deal focus of /v2/context).
//
// Nothing here is a second way of reading the data. Lists come off the same flattened rows the
// app's lists read (listRows / listDealRows), one deal comes from the deal page's own reader
// (getAccountDeal), a deal's outcome is crmDealState, an account's stage is accountStage, and the
// win odds are the deal outlook (runDealOutlook) the forecast and the `deals` tool use. What lives
// here is the public SHAPE (snake_case, one deal shape for every route), parameter handling, and
// the joins between those readers.
//
// Implied deals. An account with no CRM deal still has a deal — the one the app opens as
// "<Account> deal" (accountDeals.mjs, id 'account' in the app). The public API names it
// `implied:<account entity id>` so the id is globally unique and says what it is; it is listed
// with `implied: true`, never pretends to be a CRM record, and resolves through GET /v2/deals/:id
// and the `focus` of POST /v2/context like any other deal.

import {
  getEntity, crmDealState, accountStage, mapToCanonical, getWorkspaceStages, runDealOutlook,
  STAGE_LABEL, TERMINAL_STAGES, roleFromAuthorityClaims,
} from '@nous/core';
import { hasListRows, listRows, listDealRows, personStagesForAccounts, dealValueByCompany } from './listRows.mjs';
import { listWorkspaceDeals } from './workspaceDeals.mjs';
import { getAccountDeal, withDealPipelines, readPrimaryPipelineRef, ACCOUNT_DEAL_ID, impliedDealName } from './accountDeals.mjs';
import { getVisibilityScope, memberVisibleAccounts, entityVisibleToMember } from './visibility.mjs';
import { ownerByEmail } from './ownerScope.mjs';
import { shapeHealth } from './dealOutlook.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const IMPLIED_PREFIX = 'implied:';

// ─── Parameters ──────────────────────────────────────────────────────────────

/** A 400 body for query params the route does not honour, or null. Fail loudly, never ignore. */
export function unknownParams(query, allowed) {
  const unknown = Object.keys(query ?? {}).filter((k) => !allowed.has(k));
  if (!unknown.length) return null;
  return {
    error: 'unknown_query_param',
    detail: `unsupported query param(s): ${unknown.join(', ')}`,
    supported: [...allowed],
  };
}

/** `limit` (default 50, capped at `max`) and `offset` (>= 0). Garbage reads as the default. */
export function parsePaging(query, { max = MAX_LIMIT } = {}) {
  const l = parseInt(query?.limit, 10);
  const o = parseInt(query?.offset, 10);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, max) : Math.min(DEFAULT_LIMIT, max),
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

/** 'true' / 'false' → boolean; absent → undefined; anything else → null (the caller 400s). */
export function parseBool(v) {
  if (v == null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return null;
}

/** '2d' | '7d' | '30d' | '6h' | '90m' → ms; null when unparseable. Same syntax as /v2/people. */
export function parseDuration(input) {
  if (input == null) return null;
  const m = String(input).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * ms;
}

/** An `owner=` value as the owner filter wants it: an email resolves to its CRM owner; anything else is a name. */
export async function resolveOwnerParam(supabase, workspaceId, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (v.includes('@')) {
    const mapped = await ownerByEmail(supabase, workspaceId, v);
    // An email no account row carries is still a filter: it matches nothing, never everything.
    return mapped ?? { names: [], emails: [v.toLowerCase()] };
  }
  return { names: [v], emails: [] };
}

/** In-memory owner test against a record's CRM owner name / email (both case-insensitive). */
export function matchesOwner(owner, name, email) {
  if (!owner) return true;
  const set = new Set([...(owner.names ?? []), ...(owner.emails ?? [])].map((s) => String(s).toLowerCase()));
  return [name, email].some((v) => v != null && set.has(String(v).toLowerCase()));
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/**
 * The caller's book, resolved once: `{ restrict: false }` for an admin key, an open workspace or
 * a workspace-scoped key; otherwise the company and person ids a member key may see. Same dial
 * as the app's lists (visibility.mjs).
 */
export async function viewerBook(supabase, workspaceId, req) {
  const vis = await getVisibilityScope(supabase, workspaceId, req);
  if (!vis.restrict) return { restrict: false };
  const { companyIds, contactIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
  return { restrict: true, companyIds, contactIds };
}

/** One entity, the single-record gate: 404 (not 403) for anything outside the caller's book. */
export function visibleTo(req, supabase, workspaceId, entityId) {
  const viewerId = req.memberUserId ?? req.internalUserId ?? null;
  return entityVisibleToMember(supabase, workspaceId, viewerId, entityId, { isAdmin: req.viewerScope === 'admin' });
}

// ─── Win odds ────────────────────────────────────────────────────────────────
//
// runDealOutlook scores the workspace's open book in ONE pass (it is the forecast's assembly), so
// it is read once per request and looked up per deal. The outlook is per ACCOUNT: every open deal
// on an account carries that account's odds. A closed deal carries none.

const defaultOutlook = (supabase, workspaceId) => runDealOutlook(supabase, workspaceId, { horizons: [30] });
let outlookRunner = defaultOutlook;
/** Test seam: replace the outlook engine (null restores it). */
export function __setOutlookRunnerForTests(fn) { outlookRunner = fn ?? defaultOutlook; }

const round3 = (p) => (p == null || !Number.isFinite(p) ? null : Math.round(p * 1000) / 1000);

/**
 * { byAccount: Map<accountId, { win_probability, close_within_30d, win_rank, win_rank_of, odds_basis }>, ranked: accountId[], failed }
 * `ranked` is the outlook's own order: most likely to be won within 30 days first.
 * `odds_basis` is 'rank' until the win model is fitted on this workspace's own closed deals
 * (GET-832): the probabilities still order the book, but they are not a number to show a user,
 * so a surface shows `win_rank` of `win_rank_of` instead.
 */
export async function loadWinOdds(supabase, workspaceId) {
  try {
    const out = await outlookRunner(supabase, workspaceId);
    const byAccount = new Map();
    const ranked = [];
    const all = out?.deals ?? [];
    const odds_basis = out?.winModel?.basis === 'fitted' ? 'percent' : 'rank';
    all.forEach((d, i) => {
      byAccount.set(d.entityId, {
        win_probability: round3(d.pWin), close_within_30d: round3(d.pWinWithin?.[30] ?? null),
        win_rank: i + 1, win_rank_of: all.length, odds_basis,
      });
      ranked.push(d.entityId);
    });
    return { byAccount, ranked, failed: false };
  } catch (err) {
    console.warn('[publicApi] deal outlook unavailable:', err?.message);
    return { byAccount: new Map(), ranked: [], failed: true };
  }
}

// ─── Stages ──────────────────────────────────────────────────────────────────

const normLabel = (s) => String(s ?? '').trim().toLowerCase();
const TERMINAL = new Set(TERMINAL_STAGES);

/**
 * CRM stage label → canonical ladder stage, through the workspace's own stage vocabulary
 * (workspace_stages, one ladder per CRM pipeline; the primary's is the workspace's own). A label
 * no ladder names falls back to mapToCanonical, the heuristic the CRM import itself uses. The
 * deal's outcome wins over its label: a won deal is closed_won whatever its stage is called.
 */
export async function stageResolver(supabase, workspaceId, primaryRef, pipelineIds = []) {
  const refs = [...new Set(pipelineIds.filter((id) => id && id !== primaryRef))];
  const [own, ...others] = await Promise.all([
    getWorkspaceStages(supabase, workspaceId),
    ...refs.map((ref) => getWorkspaceStages(supabase, workspaceId, { pipelineRef: ref })),
  ]);
  const index = (stages) => {
    const m = new Map();
    for (const s of stages ?? []) {
      if (s.label) m.set(normLabel(s.label), s.canonical);
      if (s.external_ref) m.set(normLabel(s.external_ref), s.canonical);
    }
    return m;
  };
  const ownMap = index(own);
  const byRef = new Map(refs.map((ref, i) => [ref, index(others[i])]));
  return {
    ladder: own ?? [],
    canonical(label, pipelineId, status) {
      const k = normLabel(label);
      let c = null;
      if (k) c = (pipelineId && byRef.get(pipelineId)?.get(k)) || ownMap.get(k) || mapToCanonical(String(label));
      if (status === 'won') return 'closed_won';
      if (status === 'lost') return c && TERMINAL.has(c) ? c : 'closed_lost';
      return c;
    },
    /** What the workspace calls a canonical stage (its own ladder's label), else the standard name. */
    labelFor(canonical) {
      if (!canonical) return null;
      return (own ?? []).find((s) => s.canonical === canonical)?.label ?? STAGE_LABEL[canonical] ?? canonical;
    },
  };
}

// ─── Deal ids ────────────────────────────────────────────────────────────────

export const impliedDealId = (accountId) => `${IMPLIED_PREFIX}${accountId}`;

/** `implied:<uuid>` → the account id; anything else → null. */
export function parseImpliedId(id) {
  const s = String(id ?? '');
  if (!s.startsWith(IMPLIED_PREFIX)) return null;
  const acc = s.slice(IMPLIED_PREFIX.length);
  return UUID.test(acc) ? acc : null;
}

// ─── The list deal shape ─────────────────────────────────────────────────────

const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const str = (v) => { const u = unwrap(v); return u == null || u === '' ? null : String(u); };

/** The one deal shape every public route returns. `d` is the internal row built below. */
export function shapeListDeal(d) {
  return {
    id: d.implied ? impliedDealId(d.company_id) : d.id,
    name: d.name,
    account: d.company_id ? { entity_id: d.company_id, name: d.company_name ?? null, domain: d.company_domain ?? null } : null,
    stage: d.stage ?? null,
    canonical_stage: d.canonical_stage ?? null,
    status: d.status,
    amount: d.amount ?? null,
    currency: d.currency ?? null,
    close_date: d.close_date ?? null,
    owner: d.owner_name || d.owner_email ? { name: d.owner_name ?? null, email: d.owner_email ?? null } : null,
    pipeline: d.pipeline_id || d.pipeline ? { id: d.pipeline_id ?? null, name: d.pipeline ? String(d.pipeline).trim() : null } : null,
    health: d.health ?? null,
    win_probability: d.win_probability ?? null,
    close_within_30d: d.close_within_30d ?? null,
    win_rank: d.win_rank ?? null,
    win_rank_of: d.win_rank_of ?? null,
    odds_basis: d.odds_basis ?? null,
    last_activity_at: d.last_activity_at ?? null,
    implied: !!d.implied,
  };
}

/** Every CRM deal in the workspace, from the flattened rows when they exist (the app's board path). */
async function collectCrmDeals(supabase, workspaceId) {
  if (await hasListRows(supabase, workspaceId, 'deal')) {
    const rows = await listDealRows(supabase, workspaceId, {});
    return rows.map((r) => ({
      id: r.id, name: r.name || 'Untitled deal', company_id: r.company_id, company_name: r.company_name,
      company_domain: r.company_domain, stage: r.stage, status: crmDealState({ status: r.status, stage: r.stage }),
      amount: r.value == null ? null : Number(r.value), currency: null, close_date: r.close_date ?? null,
      owner_name: r.owner_name ?? null, owner_email: null, pipeline_id: r.pipeline_id ?? null, pipeline: r.pipeline ?? null,
      last_activity_at: r.last_activity_at ?? null, implied: false,
    }));
  }
  // No flattened rows yet (a fresh or small workspace): the claims path the app falls back to.
  const deals = await withDealPipelines(supabase, workspaceId, await listWorkspaceDeals(supabase, workspaceId, { status: 'all' }));
  return deals.map((d) => ({
    id: d.id, name: d.name, company_id: d.company_id, company_name: d.company_name, company_domain: d.company_domain,
    stage: d.stage, status: d.status, amount: d.value ?? null, currency: d.currency ?? null, close_date: d.close_date ?? null,
    // listWorkspaceDeals falls back to the owner's email when the CRM sent no name.
    owner_name: d.owner_name ?? null, owner_email: null, pipeline_id: d.pipeline_id ?? null, pipeline: d.pipeline ?? null,
    last_activity_at: null, implied: false,
  }));
}

/**
 * The implied deals: accounts the app's account list shows (same window) that hold no CRM deal.
 * Their stage is the account's (accountStage over its people), their amount what was typed on the
 * deal page (dealValueByCompany), their health and owner the account's.
 */
async function collectImpliedDeals(supabase, workspaceId, companiesWithDeals, { accountId = null } = {}) {
  if (!(await hasListRows(supabase, workspaceId, 'account'))) return [];
  const accounts = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const { rows } = await listRows(supabase, workspaceId, 'account', {
      limit: 1000, offset, detail: true,
      // A named account is shown whatever the window says: the caller asked for it.
      windowed: !accountId,
      refine: accountId ? (q) => q.eq('entity_id', accountId) : null,
    });
    accounts.push(...rows);
    if (rows.length < 1000) break;
  }
  const bare = accounts.filter((a) => !companiesWithDeals.has(a.entity_id));
  if (!bare.length) return [];
  const ids = bare.map((a) => a.entity_id);
  const [stages, values] = await Promise.all([
    personStagesForAccounts(supabase, workspaceId, ids),
    dealValueByCompany(supabase, ids),
  ]);
  return bare.map((a) => {
    // The same reading as accountDeals.mjs impliedDeal().
    const canonical = accountStage(stages.get(a.entity_id) ?? []) || 'identified';
    const status = canonical === 'closed_won' ? 'won' : TERMINAL.has(canonical) ? 'lost' : 'open';
    return {
      id: impliedDealId(a.entity_id), implied: true, name: impliedDealName(a.name),
      company_id: a.entity_id, company_name: a.name ?? null, company_domain: a.domain ?? null,
      stage: null, canonical_stage: canonical, status, amount: values.get(a.entity_id) ?? null, currency: null,
      close_date: null, owner_name: a.owner_name ?? null, owner_email: a.owner_email ?? null,
      pipeline_id: null, pipeline: null, health: a.deal_health ?? null, last_activity_at: a.last_activity_at ?? null,
    };
  });
}

/**
 * Every deal the caller may see that passes the filters, unpaginated and unsorted. Rows are the
 * internal shape (see shapeListDeal), with canonical_stage set and win odds NOT yet attached.
 *
 * filters: { accountId, pipeline, status, stage, owner, closingWithinDays, minAmount, implied }
 */
export async function listPublicDeals(supabase, req, workspaceId, f = {}) {
  const [book, primaryRef, all] = await Promise.all([
    viewerBook(supabase, workspaceId, req),
    readPrimaryPipelineRef(supabase, workspaceId),
    collectCrmDeals(supabase, workspaceId),
  ]);
  // A deal that hangs off no account cannot be opened from one (the deal reader lives under it).
  let crm = all.filter((d) => d.company_id);
  const companiesWithDeals = new Set(crm.map((d) => d.company_id));
  if (f.accountId) crm = crm.filter((d) => d.company_id === f.accountId);
  if (f.implied === true) crm = [];

  // Implied deals have no pipeline and no close date, so a filter on either excludes them.
  const wantImplied = f.implied !== false && !f.pipeline && !f.closingWithinDays;
  const implied = wantImplied ? await collectImpliedDeals(supabase, workspaceId, companiesWithDeals, { accountId: f.accountId }) : [];

  const resolver = await stageResolver(supabase, workspaceId, primaryRef, crm.map((d) => d.pipeline_id));
  for (const d of crm) d.canonical_stage = resolver.canonical(d.stage, d.pipeline_id, d.status);
  for (const d of implied) d.stage = resolver.labelFor(d.canonical_stage);

  const now = Date.now();
  const horizon = f.closingWithinDays ? now + f.closingWithinDays * 86_400_000 : null;
  const startOfToday = new Date(new Date(now).toISOString().slice(0, 10)).getTime();
  const deals = [...crm, ...implied].filter((d) => {
    if (book.restrict && !book.companyIds.has(d.company_id)) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.stage && d.canonical_stage !== f.stage) return false;
    if (f.pipeline && d.pipeline_id !== f.pipeline) return false;
    if (f.owner && !matchesOwner(f.owner, d.owner_name, d.owner_email)) return false;
    if (f.minAmount != null && !(d.amount != null && d.amount >= f.minAmount)) return false;
    if (horizon != null) {
      const t = d.close_date ? Date.parse(d.close_date) : NaN;
      if (d.status !== 'open' || !Number.isFinite(t) || t < startOfToday || t > horizon) return false;
    }
    return true;
  });
  return { deals, primaryRef, resolver };
}

/** Attach win odds to open deals (closed deals carry none). */
export function attachOdds(deals, odds) {
  for (const d of deals) {
    const o = d.status === 'open' ? odds.byAccount.get(d.company_id) : null;
    d.win_probability = o?.win_probability ?? null;
    d.close_within_30d = o?.close_within_30d ?? null;
    d.win_rank = o?.win_rank ?? null;
    d.win_rank_of = o?.win_rank_of ?? null;
    d.odds_basis = o?.odds_basis ?? null;
  }
}

/**
 * What only the page needs, read for the page: each CRM deal's account health (the stored
 * deal_health of its account — a list never recomputes health per deal; GET /v2/deals/:id does),
 * and its currency and owner email (claims the flattened deal row does not carry).
 */
export async function enrichDealPage(supabase, workspaceId, deals) {
  const crm = deals.filter((d) => !d.implied);
  if (!crm.length) return deals;
  const companyIds = [...new Set(crm.map((d) => d.company_id))];
  const dealIds = crm.map((d) => d.id);
  const health = new Map();
  const extra = new Map();
  for (let i = 0; i < companyIds.length; i += 100) {
    const { data } = await supabase.from('entity_list_rows').select('entity_id, deal_health')
      .eq('workspace_id', workspaceId).eq('kind', 'account').in('entity_id', companyIds.slice(i, i + 100));
    for (const r of data ?? []) health.set(r.entity_id, r.deal_health ?? null);
  }
  for (let i = 0; i < dealIds.length; i += 100) {
    const { data } = await supabase.from('claims').select('entity_id, property, value')
      .eq('workspace_id', workspaceId).in('entity_id', dealIds.slice(i, i + 100))
      .in('property', ['currency', 'owner_email']).is('invalid_at', null);
    for (const r of data ?? []) {
      const e = extra.get(r.entity_id) ?? {};
      e[r.property] = str(r.value);
      extra.set(r.entity_id, e);
    }
  }
  for (const d of crm) {
    if (d.health == null) d.health = health.get(d.company_id) ?? null;
    const e = extra.get(d.id) ?? {};
    if (!d.currency) d.currency = e.currency ?? null;
    if (!d.owner_email) d.owner_email = e.owner_email ?? null;
  }
  return deals;
}

export const DEAL_SORTS = {
  last_activity: (a, b) => cmpDesc(a.last_activity_at, b.last_activity_at),
  close_date: (a, b) => cmpAsc(a.close_date, b.close_date),
  amount: (a, b) => cmpDesc(a.amount, b.amount),
  win_probability: (a, b) => cmpDesc(a.win_probability, b.win_probability),
};
// Nulls last in both directions; the deal id breaks ties so offset paging is stable.
function cmpDesc(a, b) { if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; return a < b ? 1 : a > b ? -1 : 0; }
function cmpAsc(a, b) { if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; return a < b ? -1 : a > b ? 1 : 0; }
export function sortDeals(deals, sortKey) {
  const by = DEAL_SORTS[sortKey];
  return [...deals].sort((a, b) => by(a, b) || String(a.id).localeCompare(String(b.id)));
}

// ─── One deal ────────────────────────────────────────────────────────────────

/**
 * Resolve a deal reference: a CRM deal entity UUID or `implied:<account id>`.
 *   { status: 'not_a_deal', entity? }  — the id is not a deal (a company, a person, an email…)
 *   { status: 'not_found' }            — a deal id that does not exist, is not visible, or an
 *                                        implied id on an account that has CRM deals
 *   { status: 'ok', company, dealId, implied }
 */
export async function resolveDealRef(supabase, req, workspaceId, ref) {
  const s = String(ref ?? '').trim();
  const impliedAccount = parseImpliedId(s);
  let companyId; let dealId; let implied = false;
  if (s.startsWith(IMPLIED_PREFIX)) {
    if (!impliedAccount) return { status: 'not_found' };
    companyId = impliedAccount; dealId = ACCOUNT_DEAL_ID; implied = true;
  } else if (UUID.test(s)) {
    const entity = await getEntity(supabase, workspaceId, s);
    if (!entity) return { status: 'not_found' };
    if (entity.type !== 'deal') return { status: 'not_a_deal', entity };
    if (entity.status && entity.status !== 'active') return { status: 'not_found' };
    const { data: link } = await supabase.from('relationships').select('to_entity_id')
      .eq('workspace_id', workspaceId).eq('from_entity_id', s).eq('type', 'belongs_to').is('valid_to', null)
      .limit(1);
    companyId = link?.[0]?.to_entity_id ?? null;
    if (!companyId) return { status: 'not_found' };
    dealId = s;
  } else {
    return { status: 'not_a_deal' };
  }

  const { data: company } = await supabase.from('companies').select('*')
    .eq('workspace_id', workspaceId).eq('id', companyId).maybeSingle();
  if (!company) return { status: 'not_found' };
  if (!(await visibleTo(req, supabase, workspaceId, company.id))) return { status: 'not_found' };
  if (implied) {
    // An account with a CRM deal has no implied deal: the CRM's deals are its deals.
    const { data: crm } = await supabase.from('relationships').select('from_entity_id')
      .eq('workspace_id', workspaceId).eq('to_entity_id', companyId).eq('type', 'belongs_to').is('valid_to', null)
      .limit(1);
    if (crm?.length) return { status: 'not_found', detail: 'this account has CRM deals; open one of those' };
  }
  return { status: 'ok', company, dealId, implied };
}

const DEAL_CLAIM_GROUPS = { objection: 'objections', competitor: 'competitors', budget: 'budget', timeline: 'timeline' };
const ACTIVITY_CAP = 50;
const trunc = (s, n) => (s == null ? null : String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/**
 * One deal in full, in the public shape. Reads through getAccountDeal (the deal page's reader).
 * `withOdds` runs the deal outlook (one workspace-wide pass) for an OPEN deal's win odds; without
 * it win_probability is null.
 */
export async function loadPublicDeal(supabase, req, workspaceId, resolved, { withOdds = false } = {}) {
  const { company, dealId, implied } = resolved;
  const full = await getAccountDeal(supabase, req, workspaceId, company, dealId);
  if (!full) return null;
  const d = full.deal;
  const primaryRef = full.primary_pipeline_ref ?? await readPrimaryPipelineRef(supabase, workspaceId);
  const resolver = await stageResolver(supabase, workspaceId, primaryRef, [d.pipeline_id]);

  const canonical = implied ? d.stage : resolver.canonical(d.stage, d.pipeline_id, d.status);
  const o = d.status === 'open' && withOdds ? (await loadWinOdds(supabase, workspaceId)).byAccount.get(company.id) : null;
  const health = shapeHealth(full.health, { full: true });

  // Who decides, from what was SAID about them (the committee's one rule, roleFromAuthorityClaims).
  const notes = full.notes ?? [];
  const authority = new Map();
  for (const n of notes) {
    if (n.category !== 'authority') continue;
    const who = n.metadata?.voiced_by_contact_id ?? n.entity_id;
    if (!authority.has(who)) authority.set(who, []);
    authority.get(who).push({ value: { metadata: n.metadata } });
  }

  // Objections, competitors, budget and timeline FILED to this deal (claimFiledToDeal, GET-404).
  // The implied deal IS the account, so its claims are the account's.
  const claims = Object.fromEntries(Object.values(DEAL_CLAIM_GROUPS).map((k) => [k, []]));
  for (const n of notes) {
    const group = DEAL_CLAIM_GROUPS[n.category];
    if (!group || n.is_active === false) continue;
    if (!implied && !n.filed_to_deal) continue;
    claims[group].push({
      id: n.id, content: n.content, label: n.label ?? null,
      voiced_by: n.metadata?.voiced_by_contact_id ?? n.entity_id ?? null,
      at: n.created_at ?? null, filed_to_deal: !!n.filed_to_deal,
    });
  }

  const activity = (full.activity ?? []).slice(0, ACTIVITY_CAP).map((a) => ({
    id: a.id, type: a.activity_type, occurred_at: a.occurred_at, source: a.source ?? null,
    person: a.contact_id && a.contact_id !== company.id ? { entity_id: a.contact_id, name: a.contactName ?? null } : null,
    summary: trunc(a.summary || a.description, 500),
    filed_to_deal: !!a.filed_to_deal,
  }));

  const list = shapeListDeal({
    id: dealId, implied, name: d.name, company_id: company.id, company_name: company.name ?? null,
    company_domain: company.domain ?? null,
    stage: implied ? resolver.labelFor(canonical) : d.stage, canonical_stage: canonical, status: d.status,
    amount: d.value ?? null, currency: d.currency ?? null, close_date: d.close_date ?? null,
    owner_name: d.owner_name ?? d.owners?.[0]?.name ?? null, owner_email: d.owner_email ?? null,
    pipeline_id: d.pipeline_id ?? null, pipeline: d.pipeline ?? null,
    health: full.health?.score ?? null,
    win_probability: o?.win_probability ?? null, close_within_30d: o?.close_within_30d ?? null,
    win_rank: o?.win_rank ?? null, win_rank_of: o?.win_rank_of ?? null, odds_basis: o?.odds_basis ?? null,
    last_activity_at: full.activity?.[0]?.occurred_at ?? null,
  });

  return {
    ...list,
    health_detail: health,
    opened_date: d.opened_date ?? null,
    days_in_stage: d.days_in_stage ?? null,
    products: d.products ?? [],
    roster_known: !!d.roster_known,
    stakeholders: (full.people ?? []).map((p) => ({
      entity_id: p.id, name: p.name, title: p.title ?? null,
      role: roleFromAuthorityClaims(authority.get(p.id) ?? []),
      conversations: p.conversations ?? null,
    })),
    stage_history: (full.stages ?? []).map((s) => ({
      stage: s.label, canonical_stage: resolver.canonical(s.label, d.pipeline_id, s.status === 'open' ? null : s.status),
      entered_at: s.entered_at, days: s.days, current: !!s.current,
    })),
    activity,
    claims,
    close_record: full.close_record ?? null,
    line_items: full.line_items ?? [],
    attributed_count: full.attributed_count ?? 0,
  };
}

/** The deal block POST /v2/context puts first: the list shape, the people on it, its filed claims. */
export function contextDealBlock(detail) {
  const { health_detail, stage_history, activity, line_items, close_record, products, attributed_count, opened_date, ...rest } = detail;
  return rest;
}

/** The deals on one account in the list shape, from listAccountDeals (the account page's Deals tab). */
export async function shapeAccountDeals(supabase, workspaceId, company, out) {
  const primaryRef = out.primary_pipeline_ref ?? null;
  const resolver = await stageResolver(supabase, workspaceId, primaryRef, (out.deals ?? []).map((d) => d.pipeline_id));
  const crmIds = (out.deals ?? []).filter((d) => !d.implied).map((d) => d.id);
  const activityById = new Map();
  if (crmIds.length) {
    const { data } = await supabase.from('entity_list_rows').select('entity_id, last_activity_at')
      .eq('workspace_id', workspaceId).eq('kind', 'deal').in('entity_id', crmIds.slice(0, 100));
    for (const r of data ?? []) activityById.set(r.entity_id, r.last_activity_at ?? null);
  }
  return (out.deals ?? []).map((d) => {
    const canonical = d.implied ? d.stage : resolver.canonical(d.stage, d.pipeline_id, d.status);
    return shapeListDeal({
      id: d.id, implied: !!d.implied, name: d.name, company_id: company.id, company_name: company.name ?? null,
      company_domain: company.domain ?? null,
      stage: d.implied ? resolver.labelFor(canonical) : d.stage, canonical_stage: canonical, status: d.status,
      amount: d.value ?? null, currency: d.currency ?? null, close_date: d.close_date ?? null,
      owner_name: d.owner_name ?? d.owners?.[0]?.name ?? null, owner_email: d.owner_email ?? null,
      pipeline_id: d.pipeline_id ?? null, pipeline: d.pipeline ?? null,
      health: d.health?.score ?? null,
      last_activity_at: d.implied ? null : (activityById.get(d.id) ?? null),
    });
  });
}
