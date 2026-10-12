import { Router } from 'express';
import { getVisibilityScope, memberVisibleAccounts, entityVisibleToMember } from '../../lib/visibility.mjs';
import { requireEnrichmentQuota } from '../../lib/access.mjs';
import { hasListRows, listRows } from '../../lib/listRows.mjs';
import { viewerReadContext } from '../../lib/messagePrivacy.mjs';
import { icpFit } from '../../lib/icpFit.mjs';
import { parseDuration, parsePaging } from '../../lib/publicApi.mjs';
import { collectWindow } from './insights.mjs';
import {
  enrichContact,
  getApolloEnrichmentKey,
  getFindymailEnrichmentKey,
  getProspeoEnrichmentKey,
} from '../../services/enrichment.mjs';
import {
  getSupabaseClient,
  getOrCreateEntity,
  attachIdentifiers,
  resolveFocus,
  assertClaims,
  fetchEntityOverlays,
  applyContactOverlay,
  normaliseLinkedInUrl,
  getInternalEntityIds,
  getPersonalEntityIds,
  getProductUserEntityIds,
  recomputeClaim,
  ENRICHMENT_ATTRIBUTES,
  listSignals,
  rescoreEntityFromClaims,
  scoreAndStake,
  detectIdentifier,
  getEntity,
  listActivities,
  normalizeStage,
  crmDealState,
} from '@nous/core';

// LinkedIn URL variants (with/without trailing slash, with/without www) so
// the linkedin_url= exact filter matches historical rows that were stored raw
// before normaliseIdentifier started normalising on write.
function linkedInVariants(url) {
  const out = new Set();
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return [];
  const canonical = normaliseLinkedInUrl(trimmed);
  if (canonical) {
    const noWww = canonical.replace('https://www.', 'https://');
    for (const base of [canonical, noWww]) { out.add(base); out.add(base + '/'); }
  }
  out.add(trimmed);
  out.add(trimmed.toLowerCase());
  return Array.from(out);
}

export const peopleV2Router = Router();

// ─── /v2/people — the deterministic surface for People (humans) ─────────────
// REST shape that workflow runtimes (n8n, Make, custom backends) call when
// they already know the parameters. Agents reading context should still use
// /v2/context or /v2/accounts/:id (intent-shaped, epistemics-tagged).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 1000;

// The only query params GET /v2/people honours. Anything else is rejected
// rather than silently ignored — a filter the API doesn't support must fail
// loudly, or a workflow believes it filtered when it didn't (e.g. icp_fit and
// sort=icp_score used to be dropped silently, returning the full unfiltered set).
const ALLOWED_PARAMS = new Set([
  'search', 'pipeline_stage', 'source', 'status',
  'has_email', 'has_linkedin', 'linkedin_url', 'email',
  'icp_fit', 'min_icp_score',
  'last_activity_before', 'last_activity_after',
  'account', 'include',
  'sort', 'limit', 'offset', 'page',
]);

// ?include=all reads the flattened person rows (entity_list_rows) instead of the `contacts` view.
// The view lists only people someone has engaged with; the rows hold everyone — cold leads and
// people we have only ever written to — which is what the app's People list reads. These are the
// params that path can answer; the rest 400 rather than being silently dropped.
const INCLUDE_ALL_PARAMS = new Set([
  'search', 'pipeline_stage', 'email', 'has_email', 'icp_fit', 'min_icp_score',
  'last_activity_before', 'last_activity_after', 'account', 'include', 'sort', 'limit', 'offset', 'page',
]);
const INCLUDE_ALL_SORTS = {
  last_activity:     { col: 'last_activity_at', ascending: false },
  last_activity_asc: { col: 'last_activity_at', ascending: true  },
  icp_score:         { col: 'icp_score',        ascending: false },
  icp_score_asc:     { col: 'icp_score',        ascending: true  },
};

// Whitelisted sort keys → (column, direction). Unknown sort values 400 rather
// than silently falling back to the default order.
const SORTS = {
  last_activity:     { col: 'last_activity_at', ascending: false },
  last_activity_asc: { col: 'last_activity_at', ascending: true  },
  icp_score:         { col: 'icp_score',        ascending: false },
  icp_score_asc:     { col: 'icp_score',        ascending: true  },
  recently_added:    { col: 'first_seen_at',    ascending: false },
};

// Properties that live in entity_identifiers, not in claims. Splitting these
// out keeps the PATCH/POST surface unsurprising — `email` works.
const IDENTIFIER_KIND_BY_FIELD = {
  email:              'email',
  linkedin_url:       'linkedin_url',
  linkedin_member_id: 'linkedin_member_id',
  hubspot_id:         'hubspot',
  pipedrive_id:       'pipedrive',
  apollo_id:          'apollo',
  attio_id:           'attio',
};

// Fields (besides `email`) that carry an additional email for the same person.
// Each becomes its own `email` identifier so resolution matches on any of them.
const EXTRA_EMAIL_FIELDS = ['emails', 'personal_email', 'work_email', 'secondary_email', 'other_email'];

function splitBody(body) {
  // identifiers → entity_identifiers via attachIdentifiers
  // everything else → claims via assertClaims
  const identifiers = [];
  const claimValues = {};
  const seenEmail = new Set();
  const addEmail = (v) => {
    for (const raw of Array.isArray(v) ? v : [v]) {
      const s = typeof raw === 'string' ? raw.trim() : (raw ? String(raw) : '');
      if (!s) continue;
      const key = s.toLowerCase();
      if (seenEmail.has(key)) continue;
      seenEmail.add(key);
      identifiers.push({ kind: 'email', value: s });
    }
  };
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k === 'email') {
      addEmail(v);                                   // string OR array of emails
    } else if (EXTRA_EMAIL_FIELDS.includes(k)) {
      addEmail(v);                                   // secondary email fields → more email identifiers
    } else if (k in IDENTIFIER_KIND_BY_FIELD) {
      if (v) identifiers.push({ kind: IDENTIFIER_KIND_BY_FIELD[k], value: String(v) });
    } else {
      claimValues[k] = v;
    }
  }
  return { identifiers, claimValues };
}

async function projectPerson(supabase, entityId) {
  // Reuse the same overlay the contacts view + /v2/accounts use, so n8n and
  // the agent see the same person.
  const overlays = await fetchEntityOverlays(supabase, [entityId]);
  const row = applyContactOverlay({ id: entityId }, overlays.get(entityId));
  return { entity_id: entityId, ...row };
}

// ─── GET /v2/people/coverage — attribute coverage estimate ──────────────────
// "How many <agency founders> do we already have, and how fresh?" — the planning
// question you ask BEFORE building a list elsewhere, without pasting identifiers.
// Buckets matching people by enrichment freshness so you know how much is already
// covered vs needs (re-)enrichment vs needs acquiring.
//   ?title=founder  ?keyword=agency  ?stale_days=90  ?limit=25
peopleV2Router.get('/coverage', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'workspace_required' });
    const { title, keyword, stale_days, limit } = req.query;
    const { data, error } = await supabase.rpc('people_coverage', {
      p_workspace: workspaceId,
      p_title: (typeof title === 'string' && title.trim()) || null,
      p_keyword: (typeof keyword === 'string' && keyword.trim()) || null,
      p_stale_days: stale_days ? Math.max(1, parseInt(stale_days, 10) || 90) : 90,
      p_limit: limit ? Math.min(100, Math.max(1, parseInt(limit, 10) || 25)) : 25,
    });
    if (error) throw error;
    return res.json(data || { total: 0, never_enriched: 0, stale: 0, fresh_verified: 0, needs_enrichment: 0, sample: [] });
  } catch (err) {
    console.error('[GET /v2/people/coverage]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── GET /v2/people — filtered list ─────────────────────────────────────────
// Reads the `contacts` view (v2-substrate-backed) for stability. Filters map
// directly to columns the view exposes; n8n discovers them via the docs.
peopleV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const {
      search,
      pipeline_stage,
      source,
      status,
      has_email,
      has_linkedin,
      linkedin_url,
      email,
      icp_fit,
      min_icp_score,
      last_activity_before,
      last_activity_after,
      sort,
      limit,
      offset,
      page,
    } = req.query;

    // Fail loudly on unsupported params instead of returning an unfiltered set.
    const unknown = Object.keys(req.query).filter(k => !ALLOWED_PARAMS.has(k));
    if (unknown.length) {
      return res.status(400).json({
        error: 'unknown_query_param',
        detail: `unsupported query param(s): ${unknown.join(', ')}`,
        supported: Array.from(ALLOWED_PARAMS),
      });
    }

    // ?account= — the people at one company (entity UUID, domain, or name).
    let accountId = null;
    if (req.query.account) {
      const r = await resolveFocus(supabase, workspaceId, String(req.query.account));
      const ent = r.status === 'resolved' ? await getEntity(supabase, workspaceId, r.entity_id) : null;
      if (!ent || ent.type !== 'company') return res.status(404).json({ error: 'account_not_found' });
      const viewerId = req.memberUserId ?? req.internalUserId ?? null;
      if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, ent.id, { isAdmin: req.viewerScope === 'admin' }))) {
        return res.status(404).json({ error: 'account_not_found' });
      }
      accountId = ent.id;
    }

    if (req.query.include != null && req.query.include !== 'all') {
      return res.status(400).json({ error: 'invalid_include', detail: "include supports only 'all'" });
    }
    if (req.query.include === 'all') return listAllPeople(req, res, supabase, workspaceId, accountId);

    let q = supabase.from('contacts').select('*').eq('workspace_id', workspaceId);
    if (accountId) q = q.eq('company_id', accountId);
    if (pipeline_stage) q = q.eq('pipeline_stage', pipeline_stage);
    if (status)         q = q.eq('status', status);
    if (source)         q = q.eq('source', source);
    if (has_email === 'true')     q = q.not('email', 'is', null);
    if (has_email === 'false')    q = q.is('email', null);
    if (has_linkedin === 'true')  q = q.not('linkedin_url', 'is', null);
    if (has_linkedin === 'false') q = q.is('linkedin_url', null);
    if (icp_fit === 'true')  q = q.eq('icp_fit', true);
    if (icp_fit === 'false') q = q.eq('icp_fit', false);
    if (min_icp_score != null && String(min_icp_score).trim() !== '') {
      const n = parseInt(min_icp_score, 10);
      if (!Number.isNaN(n)) q = q.gte('icp_score', n);
    }

    // Exact-match lookups by identifier — the shape workflow runtimes use
    // when they already have the value. linkedin_url= tries variant forms
    // (with/without trailing slash, with/without www) so old rows match too.
    if (email) q = q.eq('email', String(email).toLowerCase().trim());
    if (linkedin_url) q = q.in('linkedin_url', linkedInVariants(linkedin_url));

    const beforeMs = parseDuration(last_activity_before);
    if (beforeMs != null) {
      const cutoff = new Date(Date.now() - beforeMs).toISOString();
      // "gone quiet for N" — either never had activity, or last activity is before cutoff.
      q = q.or(`last_activity_at.is.null,last_activity_at.lt.${cutoff}`);
    }
    const afterMs = parseDuration(last_activity_after);
    if (afterMs != null) {
      const cutoff = new Date(Date.now() - afterMs).toISOString();
      q = q.gte('last_activity_at', cutoff);
    }

    if (search && String(search).trim()) {
      const t = `%${String(search).trim()}%`;
      q = q.or(`email.ilike.${t},first_name.ilike.${t},last_name.ilike.${t},company.ilike.${t},linkedin_url.ilike.${t}`);
    }

    // Account visibility: in a restricted workspace the agent inherits its operator's
    // book — it lists only the people that member owns / is in touch with. The same
    // toggle that gates the People page gates the agent, so an API key never sees more
    // than its owner. Owners+admins and open workspaces fall through to the normal
    // prospect exclusion below.
    const vis = await getVisibilityScope(supabase, workspaceId, req);
    if (vis.restrict) {
      const { contactIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
      const ids = [...contactIds].slice(0, 500);
      // Empty book => a sentinel that matches nothing, so a restricted member with no
      // accounts gets an empty list rather than the whole workspace.
      q = q.in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    } else {
      // Teammates, personal contacts, and product signups are not prospects. Without
      // this an agent listing people (e.g. min_icp_score=80) gets a co-founder back as
      // a lead. Internal + personal are the privacy-critical set and always small, so
      // they go first and are never dropped; product-user ids fill the rest up to a
      // URL-safe cap. Mirrors query()/attention's excludeInternal.
      const excludeIds = await notProspectIds(supabase, workspaceId);
      if (excludeIds.length) q = q.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const sortKey = sort != null && String(sort).trim() !== '' ? String(sort) : 'last_activity';
    const sortSpec = SORTS[sortKey];
    if (!sortSpec) {
      return res.status(400).json({
        error: 'unknown_sort',
        detail: `unsupported sort '${sortKey}'`,
        supported: Object.keys(SORTS),
      });
    }
    q = q.order(sortSpec.col, { ascending: sortSpec.ascending, nullsFirst: false });

    const lim = Math.min(parseInt(limit, 10) || 100, MAX_LIMIT);
    // offset wins if given; otherwise derive it from the documented `page` (1-based).
    let off = parseInt(offset, 10) || 0;
    if ((offset == null || String(offset).trim() === '') && page != null) {
      const p = parseInt(page, 10);
      if (!Number.isNaN(p) && p > 0) off = (p - 1) * lim;
    }
    // Fetch one extra row to compute has_more without a second count query.
    q = q.range(off, off + lim);

    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    const has_more = rows.length > lim;
    const people = has_more ? rows.slice(0, lim) : rows;
    return res.json({ people, limit: lim, offset: off, has_more });
  } catch (err) {
    console.error('[GET /v2/people]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Teammates, personal contacts and product signups: never prospects. Internal + personal first
// (privacy-critical, always small), product users fill the rest up to a URL-safe cap.
async function notProspectIds(supabase, workspaceId) {
  const [internalIds, personalIds, productIds] = await Promise.all([
    getInternalEntityIds(supabase, workspaceId),
    getPersonalEntityIds(supabase, workspaceId),
    getProductUserEntityIds(supabase, workspaceId),
  ]);
  return [...new Set([...internalIds, ...personalIds, ...productIds])].slice(0, 300);
}

// The most ids a member's book sends as one `.in()` filter: ~36 chars each keeps the URL ~18KB.
const VISIBLE_IN_QUERY_MAX = 500;

// GET /v2/people?include=all — everyone, engaged or not, off the flattened person rows.
async function listAllPeople(req, res, supabase, workspaceId, accountId) {
  const qp = req.query;
  const unsupported = Object.keys(qp).filter((k) => !INCLUDE_ALL_PARAMS.has(k));
  if (unsupported.length) {
    return res.status(400).json({
      error: 'unknown_query_param',
      detail: `not supported with include=all: ${unsupported.join(', ')}`,
      supported: [...INCLUDE_ALL_PARAMS],
    });
  }
  const sortKey = qp.sort != null && String(qp.sort).trim() !== '' ? String(qp.sort) : 'last_activity';
  if (!INCLUDE_ALL_SORTS[sortKey]) {
    return res.status(400).json({ error: 'unknown_sort', detail: `unsupported sort '${sortKey}' with include=all`, supported: Object.keys(INCLUDE_ALL_SORTS) });
  }
  const { limit } = parsePaging(qp);
  let offset = parseInt(qp.offset, 10) || 0;
  if ((qp.offset == null || String(qp.offset).trim() === '') && qp.page != null) {
    const p = parseInt(qp.page, 10);
    if (!Number.isNaN(p) && p > 0) offset = (p - 1) * limit;
  }
  offset = Math.max(0, offset);
  // Fail loudly, as /v2/accounts does: a filter we can't read must not quietly widen the list.
  let minIcp = null;
  if (qp.min_icp_score != null && String(qp.min_icp_score).trim() !== '') {
    minIcp = Number(qp.min_icp_score);
    if (!Number.isFinite(minIcp)) return res.status(400).json({ error: 'invalid_min_icp_score', detail: 'min_icp_score must be a number 0-100' });
  }
  const durations = {};
  for (const k of ['last_activity_before', 'last_activity_after']) {
    if (qp[k] == null || String(qp[k]).trim() === '') continue;
    const ms = parseDuration(qp[k]);
    if (ms == null) return res.status(400).json({ error: 'invalid_duration', detail: `${k} must look like 30d, 12h or 90m` });
    durations[k] = ms;
  }
  if (!(await hasListRows(supabase, workspaceId, 'person'))) return res.json({ people: [], limit, offset, has_more: false });

  const vis = await getVisibilityScope(supabase, workspaceId, req);
  let visible = null; let excludeIds = [];
  if (vis.restrict) {
    const { contactIds } = await memberVisibleAccounts(supabase, workspaceId, vis.viewerUserId);
    visible = contactIds;
    if (!visible.size) return res.json({ people: [], limit, offset, has_more: false });
  } else {
    excludeIds = await notProspectIds(supabase, workspaceId);
  }
  // A member's book goes into the query as an id list while the URL can carry it; past that it is
  // matched in JS while walking the list, so nobody beyond the first few hundred goes missing.
  const inlineVisible = visible && visible.size <= VISIBLE_IN_QUERY_MAX ? [...visible] : null;
  const before = durations.last_activity_before ?? null;
  const after = durations.last_activity_after ?? null;
  const refine = (query) => {
    let q = query;
    if (qp.pipeline_stage) q = q.eq('stage', String(qp.pipeline_stage));
    if (qp.email) q = q.eq('email', String(qp.email).toLowerCase().trim());
    if (qp.has_email === 'true') q = q.not('email', 'is', null);
    if (qp.has_email === 'false') q = q.is('email', null);
    if (qp.icp_fit === 'true') q = q.gte('icp_score', 70);
    if (qp.icp_fit === 'false') q = q.or('icp_score.lt.70,icp_score.is.null');
    if (minIcp != null) q = q.gte('icp_score', minIcp);
    if (before != null) q = q.or(`last_activity_at.is.null,last_activity_at.lt.${new Date(Date.now() - before).toISOString()}`);
    if (after != null) q = q.gte('last_activity_at', new Date(Date.now() - after).toISOString());
    if (inlineVisible) q = q.in('entity_id', inlineVisible);
    if (excludeIds.length) q = q.not('entity_id', 'in', `(${excludeIds.join(',')})`);
    return q;
  };
  const listOpts = {
    q: qp.search ? String(qp.search).trim() : '', companyId: accountId, detail: true,
    refine, orderBy: INCLUDE_ALL_SORTS[sortKey],
  };
  let rows; let has_more;
  if (visible && !inlineVisible) {
    const w = await collectWindow(async (from, to) => {
      const r = await listRows(supabase, workspaceId, 'person', { ...listOpts, offset: from, limit: to - from + 1 });
      return r.rows;
    }, (r) => visible.has(r.entity_id), { offset, limit, pageSize: 500 });
    rows = w.rows; has_more = w.has_more;
  } else {
    const r = await listRows(supabase, workspaceId, 'person', { ...listOpts, offset, limit });
    rows = r.rows; has_more = offset + r.rows.length < r.total;
  }
  const people = rows.map((r) => {
    const parts = String(r.name ?? '').split(' ');
    return {
      id: r.entity_id, email: r.email ?? null,
      first_name: parts[0] || null, last_name: parts.slice(1).join(' ') || null, name: r.name ?? null,
      job_title: r.job_title ?? null, company_id: r.company_id ?? null, company: r.company_name ?? null,
      country: r.country ?? null, pipeline_stage: r.stage ?? null, icp_score: r.icp_score ?? null,
      icp_fit: r.icp_score == null ? null : r.icp_score >= 70,
      last_activity_at: r.last_activity_at ?? null, last_inbound_at: r.last_inbound_at ?? null,
    };
  });
  return res.json({ people, limit, offset, has_more });
}

// ─── GET /v2/people/:id — one person ────────────────────────────────────────
// :id is a person entity UUID, an email, or a LinkedIn URL (a name is not an id: use the list's
// ?search=). Identity, title, the account they work at, stage, ICP, the latest activity (a
// summary per row, never the message body), and the deals they are a stakeholder on.
const RECENT_ACTIVITY = 10;
const STAKEHOLDER_CAP = 50;

peopleV2Router.get('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const raw = String(req.params.id ?? '').trim();
    const ident = detectIdentifier(raw);
    if (!ident || ident.kind === 'domain') {
      return res.status(400).json({ error: 'invalid_id', detail: ':id must be a person entity UUID, an email, or a LinkedIn URL' });
    }
    const resolution = await resolveFocus(supabase, workspaceId, raw);
    if (resolution.status !== 'resolved') return res.status(404).json({ error: 'person_not_found' });
    const entityId = resolution.entity_id;
    const entity = await getEntity(supabase, workspaceId, entityId);
    if (!entity || entity.type !== 'person' || (entity.status && entity.status !== 'active')) {
      return res.status(404).json({ error: 'person_not_found' });
    }
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, entityId, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'person_not_found' });
    }

    const row = await loadPersonRow(supabase, workspaceId, entityId);
    const [icp, activity, account, stakeholderOf] = await Promise.all([
      icpFit(supabase, workspaceId, entityId),
      listActivities(supabase, { contactId: entityId, limit: RECENT_ACTIVITY, workspaceId }, viewerReadContext(req, workspaceId)),
      row.company_id
        ? supabase.from('companies').select('id, name, domain').eq('workspace_id', workspaceId).eq('id', row.company_id).maybeSingle().then((r) => r.data)
        : null,
      stakeholderDeals(supabase, workspaceId, entityId),
    ]);
    const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;
    const summary = (s) => (s == null ? null : String(s).length > 280 ? `${String(s).slice(0, 279)}…` : String(s));
    return res.json({
      person: {
        entity_id: entityId,
        name,
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        email: row.email ?? null,
        linkedin_url: row.linkedin_url ?? null,
        title: row.job_title ?? null,
        seniority: row.seniority ?? null,
        account: account
          ? { entity_id: account.id, name: account.name ?? null, domain: account.domain ?? null }
          : (row.company_id ? { entity_id: row.company_id, name: row.company ?? null, domain: null } : null),
        stage: normalizeStage(row.pipeline_stage) ?? null,
        icp: icp ? { score: icp.score, fit: icp.fit ?? (icp.score >= 70), tier: icp.tier ?? null } : null,
        last_activity_at: row.last_activity_at ?? activity[0]?.occurred_at ?? null,
        recent_activity: activity.map((a) => ({
          id: a.id, type: a.activity_type, occurred_at: a.occurred_at, source: a.source ?? null,
          summary: summary(a.summary || a.description),
        })),
        stakeholder_of: stakeholderOf,
      },
    });
  } catch (err) {
    console.error('[GET /v2/people/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

/** The deals a person is on (`stakeholder_of`), each as its id, name, stage, status, amount and close date. */
async function stakeholderDeals(supabase, workspaceId, personId) {
  const { data: rels } = await supabase.from('relationships').select('to_entity_id')
    .eq('workspace_id', workspaceId).eq('from_entity_id', personId).eq('type', 'stakeholder_of').is('valid_to', null)
    .limit(STAKEHOLDER_CAP);
  const ids = [...new Set((rels ?? []).map((r) => r.to_entity_id))];
  if (!ids.length) return [];
  const { data: claims } = await supabase.from('claims').select('entity_id, property, value')
    .eq('workspace_id', workspaceId).in('entity_id', ids).is('invalid_at', null)
    .in('property', ['name', 'stage', 'status', 'value', 'close_date']);
  const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const byId = new Map(ids.map((id) => [id, {}]));
  for (const c of claims ?? []) { const d = byId.get(c.entity_id); if (d) d[c.property] = plain(c.value); }
  return ids.map((id) => {
    const d = byId.get(id);
    const amount = d.value == null || d.value === '' ? null : Number(d.value);
    return {
      deal_id: id, name: d.name ?? 'Untitled deal', stage: d.stage ?? null,
      status: crmDealState({ status: d.status ?? null, stage: d.stage ?? null }),
      amount: Number.isFinite(amount) ? amount : null, close_date: d.close_date ?? null,
    };
  });
}

// ─── POST /v2/people — create or upsert by identifier ────────────────────────
// Kept for existing callers, but no longer part of the documented public API (the documented
// people surface is read-only: GET /v2/people, GET /v2/people/:id). Same for PATCH below.
// Body: { email?, linkedin_url?, ... + any claim properties }
// If an entity with one of the identifiers already exists, returns it and
// asserts any new claim values onto it (safe to call from a form intake hook
// that fires repeatedly).
peopleV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { identifiers, claimValues } = splitBody(req.body);

    if (identifiers.length === 0) {
      return res.status(400).json({
        error: 'identifier_required',
        detail: 'pass at least one of: email, linkedin_url, linkedin_member_id, hubspot_id, pipedrive_id, apollo_id, attio_id',
      });
    }

    // Pass the incoming name as a resolution hint so the name-fallback tier can
    // attach to an existing same-person record instead of forking a duplicate.
    // Without this the name only becomes a claim AFTER creation (below), too late
    // to prevent the fork — the root cause of same-batch LinkedIn import dupes.
    const nameHint = (claimValues.first_name || claimValues.last_name)
      ? { first_name: claimValues.first_name ?? null, last_name: claimValues.last_name ?? null }
      : undefined;
    const entityId = await getOrCreateEntity(supabase, workspaceId, 'person', identifiers, { nameHint });
    if (Object.keys(claimValues).length > 0) {
      await assertClaims(supabase, workspaceId, entityId, { values: claimValues });
    }
    const person = await projectPerson(supabase, entityId);
    return res.status(201).json({ person });
  } catch (err) {
    console.error('[POST /v2/people]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── POST /v2/people/:id/enrich — run the enrichment waterfall for ONE person ─
// The key-auth twin of POST /api/contacts/:id/enrich, with the lead-list enrich's
// reuse gate: same waterfall (enrichContact: Apollo / Findymail / Prospeo on the
// workspace's own keys), same quota gate, same enrichment_run op-log row.
//   :id    person entity UUID
//   body   { force?: boolean }  re-enrich even inside the reuse window
// After the run the enrichment claims are recomputed and the person is re-scored against the
// live ICP model the same way POST /v2/observations does it (rescoreEntityFromClaims, or
// scoreAndStake when no open prediction exists) — deterministic, no model call — so the
// returned person already carries the fresh icp_score.

// Same window the lead-list enrich uses: an enrichment younger than this is reused, not re-bought.
export const ENRICH_REUSE_DAYS = 90;

// The person fields a provider can fill. `fields_added` is the subset that was empty before the
// run and holds a value after it. Bookkeeping (enrichment_status, enriched_at) and derived scores
// are not "fields added".
export const ENRICH_FIELDS = [
  'email', 'linkedin_url', 'first_name', 'last_name', 'job_title', 'seniority', 'department',
  'company', 'company_id', 'domain', 'phone', 'city', 'country', 'photo_url',
];

const ENRICH_PROVIDERS = new Set(['apollo', 'prospeo', 'findymail']);

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');

/** Fields that were empty on `before` and hold a value on `after`. */
export function enrichmentFieldsAdded(before, after) {
  const out = [];
  for (const f of ENRICH_FIELDS) if (isBlank(before?.[f]) && !isBlank(after?.[f])) out.push(f);
  return out;
}

/** Was this person enriched inside the reuse window? `lastAt` is an ISO string or null. */
export function isRecentlyEnriched(lastAt, now = Date.now()) {
  if (!lastAt) return false;
  const t = new Date(lastAt).getTime();
  return Number.isFinite(t) && t >= now - ENRICH_REUSE_DAYS * 86400000;
}

/** The provider name, or null when it is not one of the three enrichment rungs. */
export function normaliseEnrichProvider(p) {
  const v = typeof p === 'string' ? p.trim().toLowerCase() : '';
  return ENRICH_PROVIDERS.has(v) ? v : null;
}

const ms = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : null; };

// The person as GET /v2/people returns it (a `contacts` view row). A person who has not
// graduated onto People (a cold lead) has no view row; for them we project the same overlay
// POST/PATCH return, plus the two fields the waterfall keys on (workspace_id, domain).
async function loadPersonRow(supabase, workspaceId, entityId) {
  const { data } = await supabase.from('contacts').select('*')
    .eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();
  if (data) return data;
  const overlays = await fetchEntityOverlays(supabase, [entityId]);
  const ov = overlays.get(entityId);
  const row = applyContactOverlay({ id: entityId, workspace_id: workspaceId }, ov);
  const email = typeof row.email === 'string' ? row.email : null;
  const domain = ov?.claims?.domain ?? (email && email.includes('@') ? email.split('@')[1].toLowerCase() : null);
  return { ...row, domain: domain ?? null };
}

// Newest enrichment for this entity: the append-only enrichment observations (what the
// lead-list reuse gate reads) or the row's enriched_at claim, whichever is later.
async function lastEnrichment(supabase, workspaceId, entityId, row) {
  const { data } = await supabase.from('observations').select('observed_at, source')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('method', 'enrichment')
    .order('observed_at', { ascending: false }).limit(1);
  const obs = data?.[0];
  const rowAt = row?.enriched_at ?? null;
  if (obs && (ms(rowAt) == null || ms(obs.observed_at) >= ms(rowAt))) {
    return { at: obs.observed_at, provider: normaliseEnrichProvider(obs.source) };
  }
  return rowAt ? { at: rowAt, provider: normaliseEnrichProvider(row?.enrichment_source) } : null;
}

peopleV2Router.post('/:id/enrich', requireEnrichmentQuota, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const entityId = req.params.id;
    if (!UUID.test(entityId)) return res.status(400).json({ error: 'invalid_id', detail: ':id must be a person entity UUID' });
    const force = req.body?.force === true;

    const { data: entity } = await supabase.from('entities').select('id, type, status')
      .eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();
    if (!entity || entity.type !== 'person' || entity.status !== 'active') {
      return res.status(404).json({ error: 'person_not_found' });
    }
    // Same governance as GET /v2/accounts/:id: on a closed workspace a member key only reaches
    // its own book, and 404 (not 403) so the call does not confirm the person exists.
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, entityId, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'person_not_found' });
    }

    // BYOK only: the waterfall spends the workspace's own Apollo / Findymail / Prospeo credits.
    const [apolloK, findymailK, prospeoK] = await Promise.all([
      getApolloEnrichmentKey(supabase, workspaceId),
      getFindymailEnrichmentKey(supabase, workspaceId),
      getProspeoEnrichmentKey(supabase, workspaceId),
    ]);
    if (!apolloK && !findymailK && !prospeoK) {
      return res.status(409).json({
        error: 'no_enrichment_provider',
        detail: 'connect an Apollo (with "use for enrichment" on), Findymail or Prospeo key to enrich',
      });
    }

    const before = await loadPersonRow(supabase, workspaceId, entityId);
    const last = await lastEnrichment(supabase, workspaceId, entityId, before);
    if (!force && isRecentlyEnriched(last?.at)) {
      // Reuse, never re-pay: the result we already hold, no provider called, nothing spent.
      return res.json({
        person: before, enriched: false, provider: null, fields_added: [],
        cached: true, last_enriched_at: last.at, last_provider: last.provider,
      });
    }

    const contact = { ...before, id: entityId, workspace_id: workspaceId };
    const hasUsableKey = Boolean(contact.email || contact.linkedin_url || (contact.first_name && contact.last_name && contact.domain));
    if (!hasUsableKey) {
      return res.status(422).json({
        error: 'no_usable_identifier',
        detail: 'enrichment needs an email, a LinkedIn URL, or a full name plus a company domain',
      });
    }

    const startedAt = Date.now() - 1000;
    const hit = await enrichContact(supabase, contact);

    // Enrichment lands as observations; a worker would materialise the claims later. Recompute the
    // enrichment attributes now so the person we return already shows them (same as the /api twin).
    try {
      await Promise.all(ENRICHMENT_ATTRIBUTES.map((prop) => recomputeClaim(supabase, workspaceId, entityId, prop)));
    } catch (e) {
      console.warn('[POST /v2/people/:id/enrich] claim recompute failed:', e.message);
    }
    // Re-score on the fresh claims. The claim-engine worker would get there later; doing it here
    // is cheap (reads + one prediction write) and means the response is not a stale score.
    try {
      const signals = await listSignals(supabase, workspaceId);
      if (signals.some((sg) => sg.active)) {
        const r = await rescoreEntityFromClaims(supabase, workspaceId, entityId, { signals });
        if (r.status === 'no_open_prediction') await scoreAndStake(supabase, workspaceId, entityId, signals);
      }
    } catch (e) {
      console.warn('[POST /v2/people/:id/enrich] icp rescore failed:', e.message);
    }

    const after = await loadPersonRow(supabase, workspaceId, entityId);
    const fields_added = enrichmentFieldsAdded(before, after);
    const latest = await lastEnrichment(supabase, workspaceId, entityId, after);
    const ranNow = latest && (ms(latest.at) ?? 0) >= startedAt;
    const enriched = Boolean(hit) || fields_added.length > 0;
    const provider = enriched && ranNow ? latest.provider : null;

    if (enriched) {
      // The enrichment allowance counts these rows (getTeamEnrichmentUsage). billable_ops 0: an
      // enrichment is its own metered unit; the request itself is already metered by logV2Op.
      await supabase.from('workspace_system_log').insert({
        workspace_id: workspaceId, source: 'enrichment', event_type: 'enrichment_run',
        summary: `Enriched ${after.first_name || after.email || 'person'}`, contact_id: entityId,
        metadata: { provider, from: 'v2_people', fields_added }, billable_ops: 0,
        occurred_at: new Date().toISOString(),
      }).then(() => {}, () => {});
    }

    return res.json({ person: after, enriched, provider, fields_added, cached: false });
  } catch (err) {
    console.error('[POST /v2/people/:id/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── PATCH /v2/people/:id — assert claim values + attach identifiers ─────────
// `:id` may be an entity UUID, email, domain, or LinkedIn URL. Asserted claims
// are sticky — derivation from observations will not overwrite them.
peopleV2Router.patch('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status === 'not_found')  return res.status(404).json({ error: 'entity_not_found' });
    if (resolution.status === 'ambiguous')  return res.json({ status: 'ambiguous', candidates: resolution.candidates });

    const entityId = resolution.entity_id;
    const { identifiers, claimValues } = splitBody(req.body);

    if (identifiers.length > 0) {
      await attachIdentifiers(supabase, workspaceId, entityId, identifiers);
    }
    let writtenCount = 0;
    if (Object.keys(claimValues).length > 0) {
      const result = await assertClaims(supabase, workspaceId, entityId, { values: claimValues });
      writtenCount = result.written.length + result.invalidated.length;
    }

    const person = await projectPerson(supabase, entityId);
    return res.json({ person, claims_written: writtenCount });
  } catch (err) {
    console.error('[PATCH /v2/people/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
