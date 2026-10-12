import { Router } from 'express';
import { requireEnrichmentQuota } from '../../lib/access.mjs';
import { enrichCompanyEntity } from '../../services/companyEnrich.mjs';
import {
  getSupabaseClient, getAccountRecord, resolveFocus, mergeEntities, unmergeEntities, readContextFromReq,
  compressAccount, budgetForIntent, getLatestScorecard, accountStage, ALL_PIPELINE_STAGES, getEntity, listAccountSignals } from '@nous/core';
import { icpFit, fetchIcpByEntity } from '../../lib/icpFit.mjs';
import { entityVisibleToMember, viewerVisibleAccountSet } from '../../lib/visibility.mjs';
import { hasListRows, listRows, hasOwnershipColumns, personStagesForAccounts } from '../../lib/listRows.mjs';
import { listAccountDeals } from '../../lib/accountDeals.mjs';
import { dealOutlookList, dealOutlookForAccount } from '../../lib/dealOutlook.mjs';
import { collectWindow } from './insights.mjs';
import {
  unknownParams, parsePaging, parseBool, parseDuration, resolveOwnerParam, viewerBook, loadWinOdds,
  shapeAccountDeals,
} from '../../lib/publicApi.mjs';

export const accountsV2Router = Router();

// ─── GET /v2/accounts — the account list ─────────────────────────────────────
// The app's Accounts list over the API: the same flattened rows (entity_list_rows via listRows),
// the same window (an account shows when it holds a deal the lists show, or answered us in the
// last 45 days — `include=all` drops the window), and the same visibility (a member key on a
// closed workspace lists only its own book).
//
//   ?search=            name, domain or email contains
//   ?stage=             canonical account stage (accountStage over its people)
//   ?icp_fit=true|false icp_score >= 70 (the fit line the ICP model draws) or not
//   ?min_icp_score=0-100
//   ?owner=             CRM owner email (or name)
//   ?country=           exact country
//   ?has_open_deal=true|false
//   ?last_activity_before=30d  ?last_activity_after=7d   (same syntax as /v2/people)
//   ?include=all        skip the list window
//   ?sort=last_activity (default) | icp_score | pipeline_value | health | win_chance
//   ?limit (default 50, max 200; max 50 with sort=win_chance)  ?offset
//
// sort=win_chance ranks by the deal outlook (most likely to be won within 30 days first, the
// order GET /v2/accounts/outlook uses). The outlook only scores accounts with an open deal, so
// this sort lists ONLY those accounts, ignores the list window, carries `win_probability` and
// `close_within_30d` on each row, and caps limit at 50: one full outlook run per request.
export const ACCOUNT_LIST_PARAMS = new Set([
  'search', 'stage', 'icp_fit', 'min_icp_score', 'owner', 'country', 'has_open_deal',
  'last_activity_before', 'last_activity_after', 'include', 'sort', 'limit', 'offset',
]);
const ACCOUNT_SORTS = {
  last_activity:  { col: 'last_activity_at', ascending: false },
  icp_score:      { col: 'icp_score',        ascending: false },
  pipeline_value: { col: 'pipeline_value',   ascending: false },
  health:         { col: 'deal_health',      ascending: false },
  win_chance:     null,
};
const ICP_FIT_LINE = 70;
const WIN_CHANCE_MAX_LIMIT = 50;

function shapeAccount(r, { stage, icp }) {
  return {
    entity_id: r.entity_id,
    name: r.name ?? null,
    domain: r.domain ?? null,
    industry: r.industry ?? null,
    country: r.country ?? null,
    icp_score: r.icp_score ?? null,
    icp_tier: icp?.tier ?? null,
    icp_fit: r.icp_score == null ? null : r.icp_score >= ICP_FIT_LINE,
    health: r.deal_health ?? null,
    stage: stage ?? null,
    people_count: r.people_count ?? 0,
    open_deals: r.open_deals ?? 0,
    pipeline_value: r.pipeline_value == null ? null : Number(r.pipeline_value),
    won_value: r.won_value == null ? null : Number(r.won_value),
    owner: r.owner_name || r.owner_email ? { name: r.owner_name ?? null, email: r.owner_email ?? null } : null,
    last_activity_at: r.last_activity_at ?? null,
    last_inbound_at: r.last_inbound_at ?? null,
  };
}

accountsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const qp = req.query;
    const bad = unknownParams(qp, ACCOUNT_LIST_PARAMS);
    if (bad) return res.status(400).json(bad);

    const sortKey = qp.sort != null && String(qp.sort).trim() !== '' ? String(qp.sort) : 'last_activity';
    if (!(sortKey in ACCOUNT_SORTS)) {
      return res.status(400).json({ error: 'unknown_sort', detail: `unsupported sort '${sortKey}'`, supported: Object.keys(ACCOUNT_SORTS) });
    }
    const stage = qp.stage ? String(qp.stage) : null;
    if (stage && !ALL_PIPELINE_STAGES.includes(stage)) {
      return res.status(400).json({ error: 'invalid_stage', detail: `unknown stage '${stage}'`, supported: [...ALL_PIPELINE_STAGES] });
    }
    const icpFitQ = parseBool(qp.icp_fit);
    const hasOpen = parseBool(qp.has_open_deal);
    if (icpFitQ === null) return res.status(400).json({ error: 'invalid_icp_fit', detail: 'icp_fit must be true or false' });
    if (hasOpen === null) return res.status(400).json({ error: 'invalid_has_open_deal', detail: 'has_open_deal must be true or false' });
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
      durations[k] = new Date(Date.now() - ms).toISOString();
    }
    if (qp.include != null && qp.include !== 'all') {
      return res.status(400).json({ error: 'invalid_include', detail: "include supports only 'all'" });
    }
    const windowed = qp.include !== 'all';
    const { limit, offset } = parsePaging(qp, { max: sortKey === 'win_chance' ? WIN_CHANCE_MAX_LIMIT : undefined });

    let owner = null;
    if (qp.owner) {
      if (!(await hasOwnershipColumns(supabase))) {
        return res.status(400).json({ error: 'filter_unavailable', detail: 'the owner filter needs account ownership, which this workspace does not have yet' });
      }
      owner = await resolveOwnerParam(supabase, workspaceId, qp.owner);
    }

    if (!(await hasListRows(supabase, workspaceId, 'account'))) {
      // The list is built by a scheduled refresh; a workspace it has not reached has no rows yet.
      return res.json({ accounts: [], limit, offset, has_more: false });
    }

    const book = await viewerBook(supabase, workspaceId, req);
    const refine = (extraIds) => (query) => {
      let q = query;
      if (icpFitQ === true) q = q.gte('icp_score', ICP_FIT_LINE);
      if (icpFitQ === false) q = q.or(`icp_score.lt.${ICP_FIT_LINE},icp_score.is.null`);
      if (minIcp != null) q = q.gte('icp_score', minIcp);
      if (hasOpen === true) q = q.gt('open_deals', 0);
      if (hasOpen === false) q = q.eq('open_deals', 0);
      // "gone quiet for N": never had activity, or the last one is older than the cutoff.
      if (durations.last_activity_before) q = q.or(`last_activity_at.is.null,last_activity_at.lt.${durations.last_activity_before}`);
      if (durations.last_activity_after) q = q.gte('last_activity_at', durations.last_activity_after);
      if (extraIds) q = q.in('entity_id', extraIds);
      return q;
    };
    const base = {
      q: qp.search ? String(qp.search).trim() : '', country: qp.country ? String(qp.country) : null,
      focusCountry: null, owner, detail: true,
    };
    const stagesOf = async (rows) => {
      const map = await personStagesForAccounts(supabase, workspaceId, rows.map((r) => r.entity_id));
      for (const r of rows) r._stage = accountStage(map.get(r.entity_id) ?? []);
      return rows;
    };
    const keep = (r) => (!book.restrict || book.companyIds.has(r.entity_id)) && (!stage || r._stage === stage);

    let page; let has_more; let odds = null;
    if (sortKey === 'win_chance') {
      odds = await loadWinOdds(supabase, workspaceId);
      if (odds.failed) return res.status(503).json({ error: 'win_model_unavailable', detail: 'the deal outlook could not be computed; retry, or sort by another key' });
      const ranked = odds.ranked.filter((id) => !book.restrict || book.companyIds.has(id));
      const byId = new Map();
      for (let i = 0; i < ranked.length; i += 100) {
        const { rows } = await listRows(supabase, workspaceId, 'account', { ...base, windowed: false, limit: 1000, refine: refine(ranked.slice(i, i + 100)) });
        for (const r of rows) byId.set(r.entity_id, r);
      }
      let ordered = ranked.map((id) => byId.get(id)).filter(Boolean);
      if (stage) ordered = (await stagesOf(ordered)).filter(keep);
      page = ordered.slice(offset, offset + limit);
      has_more = ordered.length > offset + limit;
    } else if (stage || book.restrict) {
      // Filters the rows cannot answer in SQL (the account's stage lives on its people; a member's
      // book is a set of ids): walk the list in pages and keep what passes, so paging stays exact.
      const w = await collectWindow(async (from, to) => {
        const { rows } = await listRows(supabase, workspaceId, 'account', { ...base, windowed, offset: from, limit: to - from + 1, refine: refine(null), orderBy: ACCOUNT_SORTS[sortKey] });
        return stage ? stagesOf(rows) : rows;
      }, keep, { offset, limit, pageSize: 500 });
      page = w.rows; has_more = w.has_more;
    } else {
      const { rows, total } = await listRows(supabase, workspaceId, 'account', { ...base, windowed, offset, limit, refine: refine(null), orderBy: ACCOUNT_SORTS[sortKey] });
      page = rows; has_more = offset + rows.length < total;
    }

    if (page.some((r) => r._stage === undefined)) await stagesOf(page.filter((r) => r._stage === undefined));
    const icp = await fetchIcpByEntity(supabase, workspaceId, page.map((r) => r.entity_id));
    const accounts = page.map((r) => {
      const a = shapeAccount(r, { stage: r._stage, icp: icp.get(r.entity_id) });
      if (odds) Object.assign(a, odds.byAccount.get(r.entity_id) ?? { win_probability: null, close_within_30d: null, win_rank: null, win_rank_of: null, odds_basis: null });
      return a;
    });
    return res.json({ accounts, limit, offset, has_more });
  } catch (err) {
    console.error('[GET /v2/accounts]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ─── The account-ranked deal outlook ─────────────────────────────────────────
// These two answered GET /v2/deals and GET /v2/deals/:id until the deal endpoints became real
// deal reads. They are the per-ACCOUNT outlook (health + how likely the account's deal is to close,
// and why), unchanged; the MCP `deals` tool calls them here. Mounted before /:id.

/** GET /v2/accounts/outlook?within_days=30&limit=10 — the open book ranked by chance to close within N days. */
export async function sendOutlookList(req, res) {
  try {
    const supabase = getSupabaseClient();
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    const visible = await viewerVisibleAccountSet(supabase, req.workspaceId, viewerId, {
      isAdmin: req.viewerScope === 'admin',
    });
    const out = await dealOutlookList(supabase, req.workspaceId, {
      withinDays: req.query.within_days,
      limit: req.query.limit,
      visible,
    });
    return res.json(out);
  } catch (err) {
    console.error('[GET /v2/accounts/outlook]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

/** GET /v2/accounts/:id/outlook?within_days=30 — one account (email, domain, LinkedIn URL, UUID or name). */
export async function sendAccountOutlook(req, res, idString) {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const resolution = await resolveFocus(supabase, workspaceId, idString);
    if (resolution.status === 'not_found') return res.status(404).json({ error: 'entity_not_found' });
    if (resolution.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: resolution.candidates });

    // 404, not 403, so a closed book doesn't leak that the account exists.
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, resolution.entity_id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'entity_not_found' });
    }

    const out = await dealOutlookForAccount(supabase, workspaceId, resolution.entity_id, {
      withinDays: req.query.within_days,
    });
    return res.json(out);
  } catch (err) {
    console.error('[GET /v2/accounts/:id/outlook]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

accountsV2Router.get('/outlook', (req, res) => sendOutlookList(req, res));
accountsV2Router.get('/:id/outlook', (req, res) => sendAccountOutlook(req, res, req.params.id));

// POST /v2/accounts/merge — fold a duplicate person into a survivor.
// Body: { keep, drop } — each an entity UUID, email, LinkedIn URL, domain, or name.
// Agent-only dedup. Lossless (drop's identifiers re-attach to keep) + reversible
// (drop becomes a merged tombstone). A name that matches several people returns
// candidates instead of merging — the agent confirms which, then re-calls.
accountsV2Router.post('/merge', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { keep, drop } = req.body || {};
    if (!keep || !drop) return res.status(400).json({ error: 'keep_and_drop_required' });

    for (const [which, value] of [['keep', keep], ['drop', drop]]) {
      const r = await resolveFocus(supabase, workspaceId, String(value));
      if (r.status === 'not_found') return res.status(404).json({ error: 'entity_not_found', which, value });
      if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', which, candidates: r.candidates });
      if (which === 'keep') req._keepId = r.entity_id; else req._dropId = r.entity_id;
    }
    if (req._keepId === req._dropId) return res.status(400).json({ error: 'same_entity' });

    const summary = await mergeEntities(supabase, workspaceId, req._keepId, req._dropId);
    return res.json({ status: 'merged', ...summary });
  } catch (err) {
    const msg = err?.message || 'internal_error';
    const client = /not found|already merged|type mismatch|itself/.test(msg);
    if (!client) console.error('[POST /v2/accounts/merge]', err);
    return res.status(client ? 400 : 500).json({ error: msg });
  }
});

// POST /v2/accounts/unmerge — reverse a merge, forward-only (needs the provenance
// recorded at merge time). Identify the merge to undo either by `drop_id` (the tombstone's
// UUID, straight from the merge result) or by `keep` (a resolvable identifier for the
// survivor — undoes the MOST RECENT un-reversed merge into it). A merge done before
// provenance tracking has no log and returns not_reversible.
accountsV2Router.post('/unmerge', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { drop_id, keep } = req.body || {};

    let dropId = drop_id;
    if (!dropId && keep) {
      // Resolve the survivor, then find its latest un-reversed merge.
      const r = await resolveFocus(supabase, workspaceId, String(keep));
      if (r.status === 'not_found') return res.status(404).json({ error: 'entity_not_found', which: 'keep', value: keep });
      if (r.status === 'ambiguous') return res.json({ status: 'ambiguous', which: 'keep', candidates: r.candidates });
      const { data: latest } = await supabase.from('entity_merge_log')
        .select('drop_id').eq('workspace_id', workspaceId).eq('keep_id', r.entity_id).is('unmerged_at', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!latest) return res.status(404).json({ error: 'no_reversible_merge', detail: 'No un-reversed merge on that entity.' });
      dropId = latest.drop_id;
    }
    if (!dropId) return res.status(400).json({ error: 'drop_id_or_keep_required' });

    const summary = await unmergeEntities(supabase, workspaceId, String(dropId));
    return res.json({ status: 'unmerged', ...summary });
  } catch (err) {
    const msg = err?.message || 'internal_error';
    const client = /not_reversible|not found|not a merged tombstone/.test(msg);
    if (!client) console.error('[POST /v2/accounts/unmerge]', err);
    return res.status(client ? 400 : 500).json({ error: msg });
  }
});

// GET /v2/accounts/:id — the full account-record projection:
// entity + claims-with-epistemics + recent observation timeline.
// :id may be an entity UUID, email, domain, LinkedIn URL, or a name.
//
// ?intent=meeting_prep|call_prep|account_review|follow_up|draft_email
//   Ranks the timeline by how much each interaction actually TELLS you, and keeps
//   the number a question of that shape needs. The result rides alongside the raw
//   record as `key_activity` + `activity_summary`.
//
// ?compress=1
//   Drops the raw `recent_observations` and returns only the ranked view.
//
// Both are opt-in, and that is deliberate. compressAccount replaces the timeline
// rather than reordering it, so making it the default would silently break every
// consumer already reading `recent_observations` — a shape we published. New
// callers ask for the good context; old ones keep what they were promised.
// POST /v2/accounts/:id/enrich { force? } — enrich one company on the workspace's OWN Apollo or
// Prospeo (GET-669): industry, size, location, keywords, description, tech stack. Nous supplies no
// data: with neither connected it answers 409 no_enrichment_provider. :id is the account's entity id
// or its domain. A company enriched in the last 90 days comes back from what we already hold.
accountsV2Router.post('/:id/enrich', requireEnrichmentQuota, async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status !== 'resolved') return res.status(404).json({ error: 'account_not_found' });
    const entity = await getEntity(supabase, workspaceId, resolution.entity_id);
    if (!entity || entity.type !== 'company') {
      return res.status(404).json({ error: 'account_not_found', detail: 'enrich a person with POST /v2/people/:id/enrich' });
    }
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, entity.id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'account_not_found' });
    }

    const out = await enrichCompanyEntity(supabase, workspaceId, entity.id, { force: req.body?.force === true });
    if (out.status === 'no_enrichment_provider') {
      return res.status(409).json({
        error: 'no_enrichment_provider',
        detail: 'connect Apollo (with "use for enrichment" on) or Prospeo to enrich: it runs on your keys, Nous adds no data of its own',
      });
    }
    if (out.status === 'no_domain') return res.status(422).json({ error: 'no_domain', detail: 'the account has no domain to look up' });
    if (out.status === 'cached') {
      return res.json({ account_id: entity.id, enriched: false, cached: true, provider: out.provider, last_enriched_at: out.last_enriched_at, fields_added: [] });
    }
    if (out.status === 'no_match') return res.json({ account_id: entity.id, enriched: false, provider: out.provider, fields_added: [] });
    return res.json({ account_id: entity.id, enriched: true, provider: out.provider, fields_added: out.fields_added, rescored_people: out.rescored });
  } catch (err) {
    if (err?.code === 'provider_rate_limited' || err?.code === 'provider_error') {
      return res.status(502).json({ error: err.code, detail: err.message });
    }
    console.error('[POST /v2/accounts/:id/enrich]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /v2/accounts/:id/signals?days=7 — what changed on the account (GET-686): its signals,
// newest first, each with the quote, who said it and where. Same visibility as the record.
accountsV2Router.get('/:id/signals', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status === 'not_found') return res.status(404).json({ error: 'entity_not_found' });
    if (resolution.status === 'ambiguous') return res.json({ status: 'ambiguous', candidates: resolution.candidates });
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, resolution.entity_id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'entity_not_found' });
    }
    const days = Math.max(1, Math.min(Number(req.query.days) || 7, 365));
    return res.json({ account_id: resolution.entity_id, days, signals: await listAccountSignals(supabase, workspaceId, resolution.entity_id, { days }) });
  } catch (err) {
    console.error('[GET /v2/accounts/:id/signals]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

accountsV2Router.get('/:id', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;

    const resolution = await resolveFocus(supabase, workspaceId, req.params.id);
    if (resolution.status === 'not_found') {
      return res.status(404).json({ error: 'entity_not_found' });
    }
    if (resolution.status === 'ambiguous') {
      return res.json({ status: 'ambiguous', candidates: resolution.candidates });
    }

    // Account-visibility gate: on a closed (owner-scoped) workspace a member may only open
    // accounts in their own book. 404 (not 403) so we don't reveal that the account exists.
    // getAccountRecord shares a visible account's CLAIMS by design, so the gate must live here.
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    if (!(await entityVisibleToMember(supabase, workspaceId, viewerId, resolution.entity_id, { isAdmin: req.viewerScope === 'admin' }))) {
      return res.status(404).json({ error: 'entity_not_found' });
    }

    const record = await getAccountRecord(supabase, workspaceId, resolution.entity_id, readContextFromReq(req));
    if (!record) return res.status(404).json({ error: 'entity_not_found' });
    const icp = await icpFit(supabase, workspaceId, resolution.entity_id);
    // Coaching v2 (GET-84): the latest call scorecard for this account, so the after-call skill can
    // write the coaching review out of what the app already scored rather than re-scoring.
    const scorecard = await getLatestScorecard(supabase, workspaceId, resolution.entity_id).catch(() => null);

    const intent   = req.query.intent ? String(req.query.intent) : null;
    const compress = req.query.compress === '1' || req.query.compress === 'true';

    // Who works here and what is being sold to them, in the list shapes (/v2/people, /v2/deals).
    const { people, people_count, deals } = await accountPeopleAndDeals(supabase, req, workspaceId, resolution.entity_id);

    let out = { ...record, ...(icp ? { icp } : {}), ...(scorecard ? { scorecard } : {}), people, people_count, deals };

    if (intent || compress) {
      const { key_activity, activity_summary } = compressAccount(record, budgetForIntent(intent));
      out = { ...out, key_activity, activity_summary };
      // Only drop the raw timeline when explicitly asked. Ranked AND raw is a
      // legitimate thing to want; ranked INSTEAD OF raw has to be a choice.
      if (compress) delete out.recent_observations;
    }

    return res.json(out);
  } catch (err) {
    console.error('[GET /v2/accounts/:id]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const ACCOUNT_PEOPLE_CAP = 50;

/**
 * The people at an account (works_at, off the flattened person rows the People list reads) and its
 * deals (listAccountDeals — the account page's Deals tab, implied deal included when there is no
 * CRM deal). A person-shaped account (someone with no company on record) has neither.
 */
async function accountPeopleAndDeals(supabase, req, workspaceId, entityId) {
  const entity = await getEntity(supabase, workspaceId, entityId);
  if (entity?.type !== 'company') return { people: [], people_count: 0, deals: [] };

  let people = []; let people_count = 0;
  if (await hasListRows(supabase, workspaceId, 'person')) {
    const { rows, total } = await listRows(supabase, workspaceId, 'person', { companyId: entityId, limit: ACCOUNT_PEOPLE_CAP });
    people = rows.map((r) => ({ entity_id: r.entity_id, name: r.name ?? null, title: r.job_title ?? null, email: r.email ?? null, stage: r.stage ?? null }));
    people_count = total;
  } else {
    const { data, count } = await supabase.from('contacts')
      .select('id, first_name, last_name, email, job_title, pipeline_stage', { count: 'exact' })
      .eq('workspace_id', workspaceId).eq('company_id', entityId)
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .range(0, ACCOUNT_PEOPLE_CAP - 1);
    people = (data ?? []).map((c) => ({
      entity_id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || null,
      title: c.job_title ?? null, email: c.email ?? null, stage: c.pipeline_stage ?? null,
    }));
    people_count = count ?? people.length;
  }

  const { data: company } = await supabase.from('companies').select('*')
    .eq('workspace_id', workspaceId).eq('id', entityId).maybeSingle();
  if (!company) return { people, people_count, deals: [] };
  const out = await listAccountDeals(supabase, req, workspaceId, company);
  return { people, people_count, deals: await shapeAccountDeals(supabase, workspaceId, company, out) };
}
