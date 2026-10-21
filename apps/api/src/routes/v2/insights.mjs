import { Router } from 'express';
import {
  getSupabaseClient, getInsight, appendInsights, prepareAgentInsights, insightReadiness,
  BOARD_LANES, INSIGHT_SUBTYPES, laneOfSubtype, boardTaxonomy, loadBusinessType,
  listInsightTags, companyNames, loadInternalSpeakers, isInternalSpeaker,
  detectIdentifier, resolveFocus, getEntity,
} from '@nous/core';
import { entityVisibleToMember, viewerVisibleAccountSet } from '../../lib/visibility.mjs';
import { sendTopic } from '../../lib/linearSend.mjs';

// Agent-facing insights (what Nous LEARNED about us from calls). Auth is the pk_
// API key (verifyApiKey sets req.workspaceId), so MCP tools and Claude Code can
// read AND write them. In the revenue-plugin model the insight EXTRACTION runs on
// the operator's own agent/tokens (reading the transcript from their git), and the
// distilled insights are POSTed here — so this is the write door that used to be
// reachable only by the server-side worker.
//
// GET /v2/insights reads the Insights BOARD (the same placed items the app's Insights page
// shows: packages/core/src/db/insightBoard.ts). GET /v2/insights?category= keeps the old
// behaviour — the per-category insight doc — for callers that already use it.
export const insightsV2Router = Router();

export const INSIGHTS_DEFAULT_LIMIT = 50;
export const INSIGHTS_MAX_LIMIT = 200;
const ALLOWED_PARAMS = new Set(['lane', 'subtype', 'focus', 'since', 'limit', 'offset', 'category']);
const LANE_KEYS = new Set(BOARD_LANES.map((l) => l.key));
const SUBTYPE_KEYS = new Set(INSIGHT_SUBTYPES.map((s) => s.key));

const one = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => { const s = one(v); return typeof s === 'string' && s.trim() !== '' ? s.trim() : null; };

/**
 * Validate the board query. Returns { error, detail?, supported? } on a bad request, else the
 * parsed params. Pure, for the tests.
 */
export function parseInsightsQuery(query = {}) {
  const unknown = Object.keys(query).filter((k) => !ALLOWED_PARAMS.has(k));
  if (unknown.length) {
    return { error: 'unknown_query_param', detail: `unsupported query param(s): ${unknown.join(', ')}`, supported: [...ALLOWED_PARAMS] };
  }
  const lane = str(query.lane);
  const subtype = str(query.subtype);
  if (lane && !LANE_KEYS.has(lane)) return { error: 'invalid_lane', supported: [...LANE_KEYS] };
  if (subtype && !SUBTYPE_KEYS.has(subtype)) return { error: 'invalid_subtype', supported: [...SUBTYPE_KEYS] };
  if (lane && subtype && laneOfSubtype(subtype) !== lane) {
    return { error: 'subtype_not_in_lane', detail: `'${subtype}' belongs to the '${laneOfSubtype(subtype)}' lane, not '${lane}'` };
  }
  const sinceRaw = str(query.since);
  let since = null;
  if (sinceRaw) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t)) return { error: 'invalid_since', detail: 'since must be an ISO date, e.g. 2026-09-01' };
    since = new Date(t).toISOString();
  }
  const limRaw = parseInt(one(query.limit), 10);
  const limit = Number.isNaN(limRaw) ? INSIGHTS_DEFAULT_LIMIT : Math.min(Math.max(limRaw, 1), INSIGHTS_MAX_LIMIT);
  const offRaw = parseInt(one(query.offset), 10);
  const offset = Number.isNaN(offRaw) ? 0 : Math.max(offRaw, 0);
  return { lane, subtype, focus: str(query.focus), since, limit, offset };
}

/** One board item in the public shape. `tagName` / `companyName` are id → name maps. */
export function shapeInsight(item, tagName, companyName) {
  return {
    id: item.id,
    lane: item.lane ?? laneOfSubtype(item.subtype),
    subtype: item.subtype,
    content: item.statement,
    quote: item.quote ?? null,
    speaker: item.speaker ?? null,
    account: item.company_id ? { entity_id: item.company_id, name: companyName.get(item.company_id) ?? null } : null,
    source_ref: item.source_ref ?? null,
    occurred_at: item.occurred_at ?? null,
    // Main tag first, as the board stores them; a retired tag has no name and drops out.
    tags: (item.tag_ids ?? []).map((id) => tagName.get(id)).filter(Boolean),
    // The board row (topic) it sits on: subtype × main tag. What POST /topics/:key/linear takes.
    topic_key: item.subtype ? `${item.subtype}|${item.tag_ids?.[0] ?? 'none'}` : null,
  };
}

/**
 * Walk a filtered, ordered source page by page and return the window [offset, offset+limit) of
 * the rows `keep` accepts, plus whether more follow. The keep filter runs in JS (who said it is
 * not a column), so the window is computed after it. `fetchPage(from, to)` → rows. Pure, for the tests.
 */
export async function collectWindow(fetchPage, keep, { offset, limit, pageSize = 500, maxRows = 20000 }) {
  const want = offset + limit + 1;
  const kept = [];
  for (let from = 0; from < maxRows && kept.length < want; from += pageSize) {
    const rows = (await fetchPage(from, from + pageSize - 1)) ?? [];
    for (const r of rows) if (keep(r)) kept.push(r);
    if (rows.length < pageSize) break;
  }
  return { rows: kept.slice(offset, offset + limit), has_more: kept.length > offset + limit };
}

const BOARD_COLS = 'id, statement, quote, speaker, speaker_id, contact_id, occurred_at, source_ref, lane, subtype, tag_ids, company_id';

// GET /v2/insights — the Insights board over the API.
//   ?lane=product|sales|success|market   ?subtype=bug|friction|…   (validated against the taxonomy)
//   ?focus=<entity UUID | email | domain | LinkedIn URL>  only insights tied to that account
//   ?since=<ISO date>   ?limit (default 50, max 200)   ?offset
// Same membership as the app's board: placed external insights, tied to an account, never a line
// one of our own people said. Newest first. `taxonomy` carries the labels in this workspace's own
// terms (a service business sees Delivery → Missed results, not Product → Bug). `readiness` says
// whether extraction runs at all (no ICP: it doesn't, and says where to set one up).
insightsV2Router.get('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const workspaceId = req.workspaceId;
    const { category } = req.query;
    // Backward compatible: ?category= is the old per-category doc read, unchanged.
    if (category) {
      const insight = await getInsight(supabase, workspaceId, category);
      return res.json({ insights: insight ? [insight] : [] });
    }

    const q = parseInsightsQuery(req.query);
    if (q.error) return res.status(400).json(q);

    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    const isAdmin = req.viewerScope === 'admin';

    // focus → one account. Identifiers only (no bare names), and never minted by a read.
    let focusEntity = null;
    if (q.focus) {
      if (!detectIdentifier(q.focus)) {
        return res.status(400).json({ error: 'invalid_focus', detail: 'provide an entity id, email, LinkedIn URL, or domain — not a bare name' });
      }
      const r = await resolveFocus(supabase, workspaceId, q.focus);
      const entity = r.status === 'resolved' ? await getEntity(supabase, workspaceId, r.entity_id) : null;
      if (!entity || !(await entityVisibleToMember(supabase, workspaceId, viewerId, entity.id, { isAdmin }))) {
        return res.status(404).json({ error: 'focus_not_found' });
      }
      focusEntity = entity;
    }

    let internal, tags, bt, visible, readiness;
    try {
      [internal, tags, bt, visible, readiness] = await Promise.all([
        loadInternalSpeakers(supabase, workspaceId),
        listInsightTags(supabase, workspaceId),
        loadBusinessType(supabase, workspaceId),
        viewerVisibleAccountSet(supabase, workspaceId, viewerId, { isAdmin }),
        insightReadiness(supabase, workspaceId),
      ]);
    } catch (e) {
      if (/insight_tags/.test(String(e?.message))) return res.status(503).json({ error: 'insights_board_not_ready' });
      throw e;
    }

    const fetchPage = async (from, to) => {
      let qb = supabase.from('insight_items').select(BOARD_COLS)
        .eq('workspace_id', workspaceId).eq('source', 'external')
        .not('subtype', 'is', null).not('company_id', 'is', null);
      if (q.subtype) qb = qb.eq('subtype', q.subtype);
      else if (q.lane) qb = qb.in('subtype', INSIGHT_SUBTYPES.filter((s) => s.lane === q.lane).map((s) => s.key));
      if (q.since) qb = qb.gte('occurred_at', q.since);
      if (focusEntity?.type === 'company') qb = qb.eq('company_id', focusEntity.id);
      else if (focusEntity) qb = qb.or(`contact_id.eq.${focusEntity.id},speaker_id.eq.${focusEntity.id}`);
      const { data, error } = await qb
        .order('occurred_at', { ascending: false, nullsFirst: false }).order('id').range(from, to);
      if (error) throw error;
      return data;
    };
    const keep = (i) => !isInternalSpeaker(i, internal) && (visible.unrestricted || visible.ids.has(i.company_id));

    let window;
    try {
      window = await collectWindow(fetchPage, keep, { offset: q.offset, limit: q.limit });
    } catch (e) {
      // The board migration is applied by hand. Until it is, say so rather than 500.
      if (/subtype|tag_ids|company_id|lane|sorted_at/.test(String(e?.message))) {
        return res.status(503).json({ error: 'insights_board_not_ready' });
      }
      throw e;
    }

    const names = await companyNames(supabase, workspaceId, window.rows.map((i) => i.company_id));
    const tagName = new Map(tags.map((t) => [t.id, t.name]));
    const tax = boardTaxonomy(bt);
    return res.json({
      insights: window.rows.map((i) => shapeInsight(i, tagName, names)),
      limit: q.limit,
      offset: q.offset,
      has_more: window.has_more,
      // Why there may be nothing here: extraction waits for an ICP. A page shows the fix, not a blank.
      readiness,
      taxonomy: {
        lanes: tax.lanes.map(({ key, label }) => ({ key, label })),
        subtypes: tax.subtypes.map(({ key, lane, label, definition }) => ({ key, lane, label, definition })),
      },
    });
  } catch (err) {
    console.error('[GET /v2/insights]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/insights — record insights the agent extracted from a call/email about
// OUR product / positioning / market / buyer. Body: {
//   insights: [ { category:'product'|'positioning'|'market'|'buyer', content, quote?, speaker?, focus? } ],
//   focus,            who said it or the account it is about (email · domain · LinkedIn URL · entity id)
//   source_ref?,      where it was said, e.g. the interaction's source_ref from record
//   source_label?, occurred_at?
// }
// Every insight is tied to an account through its focus (GET-970): without one, GET /v2/insights,
// which lists account-tied insights only, never returned what the agent wrote. No focus is a 400,
// an identifier nothing has (or the key can't see) a 404, a person with no single company a 422,
// one of our own a 400 focus_is_internal; in each case nothing is written.
insightsV2Router.post('/', async (req, res) => {
  try {
    const supabase = getSupabaseClient();
    const { insights, focus, source_ref, source_label, occurred_at } = req.body ?? {};
    if (!Array.isArray(insights) || insights.length === 0) {
      return res.status(400).json({ error: 'insights_required' });
    }
    // A member key writes only onto accounts it can see, as it reads (GET above).
    const viewerId = req.memberUserId ?? req.internalUserId ?? null;
    const canSee = (id) => entityVisibleToMember(supabase, req.workspaceId, viewerId, id, { isAdmin: req.viewerScope === 'admin' });
    const p = await prepareAgentInsights(supabase, req.workspaceId, { insights, focus, source_ref }, { canSee });
    if (!p.ok) return res.status(p.status).json({ error: p.error, detail: p.detail, ...(p.focus ? { focus: p.focus } : {}) });
    const written = await appendInsights(supabase, req.workspaceId, p.items, {
      sourceLabel: source_label ?? null,
      occurredAt: occurred_at ?? null,
      sourceRef: p.sourceRef,
      sourceSystem: p.sourceSystem,
    });
    const accounts = [...new Set(p.items.map((i) => i.companyId).filter(Boolean))];
    return res.status(201).json({ written, submitted: p.items.length, accounts });
  } catch (err) {
    console.error('[POST /v2/insights]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /v2/insights/topics/:key/linear  { team_id? }
// Send one Insights topic to the workspace's Linear (GET-825): one issue per topic, the accounts
// behind it as customer requests, and the send mirrored back into the graph. The same function
// as the app's button, so the API plan (no insights pages) can send from an agent or a skill.
// :key is the topic_key get_insights returns, URL-encoded ('feature|<tag id>' → 'feature%7C<tag id>').
// 201 a new issue, 200 an existing one updated, 409 Linear not connected or no team picked.
insightsV2Router.post('/topics/:key/linear', async (req, res) => {
  try {
    const { status, body } = await sendTopic({
      supabase: getSupabaseClient(), workspaceId: req.workspaceId, topicKey: req.params.key,
      teamId: typeof req.body?.team_id === 'string' ? req.body.team_id : null, userId: null,
      viewerId: req.memberUserId ?? req.internalUserId ?? null, isAdmin: req.viewerScope === 'admin',
    });
    return res.status(status).json(body);
  } catch (err) {
    console.error('[POST /v2/insights/topics/:key/linear]', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});
