// Settings > Workspace > API & MCP activity (GET-898): when, how often and about what the
// workspace's API and MCP were called. Reads api_request_log (written per API-key call by
// lib/apiRequestLog.mjs, GET-623), scoped to one workspace, for its owners and admins only.
//
// Two reads:
//   loadActivity  the header stats, the calls-over-time series and the top lists. Aggregated in SQL
//                 (api_request_log_activity, supabase/migrations/2026_10_15_api_request_log_activity.sql):
//                 PostgREST caps a plain select at 1000 rows with no error, so counting here would be
//                 silently wrong. This file fills empty buckets, names keys, and resolves targets.
//   loadCalls     the call list, newest first, filtered, keyset-paged on (at, id).
//
// Never returns ip_prefix or anything secret: a key appears by its name and id, never its hash.
// Every Supabase call checks `error`: a failed read is an error, never a quiet zero.

import { isUUID } from '@nous/core';
import { parseCursor, afterCursorFilter, nextCursor, BIGINT_ID } from './keysetCursor.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The windows the page offers. 24h is hourly; the rest are UTC calendar days, today included. */
export const ACTIVITY_WINDOWS = {
  '24h': { bucket: 'hour', count: 24 },
  '7d': { bucket: 'day', count: 7 },
  '30d': { bucket: 'day', count: 30 },
  '90d': { bucket: 'day', count: 90 }, // the retention window: older rows are gone
};
export const DEFAULT_WINDOW = '7d';
export const TOP_LIMIT = 10;
export const CALLS_DEFAULT_LIMIT = 50;
export const CALLS_MAX_LIMIT = 200;
const SEARCH_MAX = 120;

export class ActivityReadError extends Error {
  constructor(what, error) {
    super(`${what}: ${error?.message ?? error}`);
    this.code = 'activity_read_failed';
    this.cause = error;
  }
}

/** The activity function is not in the database yet (the migration is applied by hand). */
export class ActivityUnavailableError extends Error {
  constructor(error) {
    super(`api_request_log_activity is missing: ${error?.message ?? error}`);
    this.code = 'activity_unavailable';
    this.cause = error;
  }
}

const must = (what, { data, error }) => {
  if (error) throw new ActivityReadError(what, error);
  return data;
};

const isMissingFunction = (e) => /PGRST202|42883|Could not find the function|does not exist/i
  .test(`${e?.message ?? ''} ${e?.code ?? ''}`);

/** '24h' | '7d' | '30d' | '90d'; anything else is the default. */
export function parseWindow(v) {
  return typeof v === 'string' && Object.hasOwn(ACTIVITY_WINDOWS, v) ? v : DEFAULT_WINDOW;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms) => `${new Date(ms).toISOString().slice(0, 13)}:00:00Z`;

/** Every bucket key of the window, oldest first: 24 UTC hours (this one included) or N UTC days. */
export function windowBuckets(window, now) {
  const { bucket, count } = ACTIVITY_WINDOWS[parseWindow(window)];
  const out = [];
  if (bucket === 'hour') {
    const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (let i = count - 1; i >= 0; i--) out.push(utcHour(thisHour - i * HOUR_MS));
  } else {
    const today = Date.parse(utcDay(now));
    for (let i = count - 1; i >= 0; i--) out.push(utcDay(today - i * DAY_MS));
  }
  return out;
}

/** The window's start, as an ISO timestamp: the first bucket's first instant. */
export function windowSince(window, now) {
  const first = windowBuckets(window, now)[0];
  return new Date(first.length === 10 ? `${first}T00:00:00Z` : first).toISOString();
}

/** The SQL series with every bucket of the window present (zeros where the log has none). */
export function fillSeries(rows, window, now) {
  const by = new Map((rows ?? []).map((r) => [String(r.bucket), r]));
  return windowBuckets(window, now).map((bucket) => {
    const r = by.get(bucket);
    return {
      bucket,
      calls: Number(r?.calls ?? 0),
      mcp: Number(r?.mcp ?? 0),
      rest: Number(r?.rest ?? 0),
      errors: Number(r?.errors ?? 0),
    };
  });
}

const n = (v) => Number(v ?? 0);
const msOrNull = (v) => (v == null ? null : Number(v));
/** errors / calls, 0..1, null when there were no calls. */
export const errorRate = (errors, calls) => (n(calls) > 0 ? n(errors) / n(calls) : null);

/** The header numbers from the SQL totals. */
export function shapeTotals(t = {}) {
  const calls = n(t?.calls);
  return {
    calls,
    mcp: n(t?.mcp),
    rest: n(t?.rest),
    errors: n(t?.errors),
    error_rate: errorRate(t?.errors, calls),
    p50_ms: calls ? msOrNull(t?.p50_ms) : null,
    p95_ms: calls ? msOrNull(t?.p95_ms) : null,
    keys: n(t?.keys),
    clients: n(t?.clients),
    targets: n(t?.targets),
  };
}

// ── What a call was about ────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/** How a raw target can be looked up: an entity id, an email, a domain, or nothing. Pure. */
export function targetKind(target) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!t) return null;
  if (isUUID(t)) return 'entity_id';
  if (EMAIL.test(t)) return 'email';
  if (!t.includes(' ') && DOMAIN.test(t)) return 'domain';
  return null;
}

/**
 * Raw targets → Map(target → { id, type, name }) for the ones that are this workspace's people,
 * companies or deals. Everything is workspace-scoped; a target that resolves to nothing (a document
 * id, a name, an entity of another workspace) is simply absent, and the page shows it raw. A failed
 * read is logged and costs only the names: the activity still loads.
 */
export async function resolveTargets(supabase, workspaceId, targets) {
  const out = new Map();
  const ids = new Set(), emails = new Set(), domains = new Set();
  for (const raw of new Set((targets ?? []).filter(Boolean))) {
    const kind = targetKind(raw);
    if (kind === 'entity_id') ids.add(raw.trim().toLowerCase());
    else if (kind === 'email') emails.add(raw.trim().toLowerCase());
    else if (kind === 'domain') domains.add(raw.trim().toLowerCase());
  }
  if (!ids.size && !emails.size && !domains.size) return out;
  try {
    // Identifier → entity, for emails and domains.
    const viaIdent = new Map(); // lowercased identifier value → entity id
    const identKinds = [['email', emails], ['domain', domains]].filter(([, s]) => s.size);
    for (const [kind, set] of identKinds) {
      const rows = must('identifiers', await supabase.from('entity_identifiers')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId)
        .eq('kind', kind)
        .eq('status', 'active')
        .in('value', [...set])) ?? [];
      for (const r of rows) {
        const v = String(r.value).toLowerCase();
        if (!viaIdent.has(v)) viaIdent.set(v, r.entity_id);
      }
    }
    const entityIds = [...new Set([...ids, ...viaIdent.values()])];
    if (!entityIds.length) return out;
    const [entRes, nameRes] = await Promise.all([
      supabase.from('entities').select('id, type, merged_into').eq('workspace_id', workspaceId).in('id', entityIds),
      supabase.from('claims').select('entity_id, value')
        .eq('workspace_id', workspaceId).eq('property', 'name').is('invalid_at', null)
        .in('entity_id', entityIds),
    ]);
    const ents = new Map((must('entities', entRes) ?? []).map((e) => [e.id, e]));
    const names = new Map();
    for (const c of must('names', nameRes) ?? []) {
      if (typeof c.value === 'string' && c.value.trim() && !names.has(c.entity_id)) names.set(c.entity_id, c.value.trim());
    }
    const about = (id) => {
      const e = ents.get(id);
      if (!e || !['person', 'company', 'deal'].includes(e.type)) return null;
      return { id, type: e.type, name: names.get(id) ?? null };
    };
    for (const raw of new Set((targets ?? []).filter(Boolean))) {
      const key = raw.trim().toLowerCase();
      const id = ids.has(key) ? key : viaIdent.get(key);
      const a = id ? about(id) : null;
      if (a) out.set(raw, a);
    }
  } catch (err) {
    console.warn('[apiActivity] target names failed:', err?.message || err);
  }
  return out;
}

/** api_keys of the workspace → Map(id → { name, revoked }). Names only: never the hash. */
async function keyNames(supabase, workspaceId) {
  const rows = must('keys', await supabase.from('api_keys')
    .select('id, name, revoked_at')
    .eq('workspace_id', workspaceId)) ?? [];
  return new Map(rows.map((k) => [k.id, { name: k.name ?? null, revoked: !!k.revoked_at }]));
}

/**
 * GET /api/usage/activity?window=7d. Throws ActivityUnavailableError when the SQL function is not
 * there yet, ActivityReadError on any other failed read.
 */
export async function loadActivity(supabase, { workspaceId, window: w, now = Date.now(), limit = TOP_LIMIT }) {
  const window = parseWindow(w);
  const since = windowSince(window, now);
  const [aggRes, keys] = await Promise.all([
    supabase.rpc('api_request_log_activity', {
      p_workspace_id: workspaceId, p_since: since, p_bucket: ACTIVITY_WINDOWS[window].bucket, p_limit: limit,
    }),
    keyNames(supabase, workspaceId),
  ]);
  if (aggRes.error && isMissingFunction(aggRes.error)) throw new ActivityUnavailableError(aggRes.error);
  const agg = must('activity', aggRes) ?? {};
  const byTarget = agg.by_target ?? [];
  const about = await resolveTargets(supabase, workspaceId, byTarget.map((r) => r.target));
  const withRate = (r) => ({ calls: n(r.calls), errors: n(r.errors), error_rate: errorRate(r.errors, r.calls), last_at: r.last_at ?? null });
  return {
    window,
    since,
    bucket: ACTIVITY_WINDOWS[window].bucket,
    totals: shapeTotals(agg.totals),
    series: fillSeries(agg.series, window, now),
    by_route: (agg.by_route ?? []).map((r) => ({ surface: r.surface, route: r.route, ...withRate(r), p95_ms: msOrNull(r.p95_ms) })),
    by_target: byTarget.map((r) => ({ target: r.target, about: about.get(r.target) ?? null, ...withRate(r) })),
    by_key: (agg.by_key ?? []).map((r) => ({
      api_key_id: r.api_key_id,
      name: keys.get(r.api_key_id)?.name ?? null,
      revoked: keys.get(r.api_key_id)?.revoked ?? false,
      ...withRate(r),
    })).sort((a, b) => b.calls - a.calls || String(a.name).localeCompare(String(b.name))),
    by_client: (agg.by_client ?? []).map((r) => ({ client: r.client || null, ...withRate(r) })),
  };
}

// ── The call list ────────────────────────────────────────────────────────────

const ROUTE_MAX = 200;

/**
 * The list's query string → { window, limit, before, beforeId, surface, route, status, keyId, q }
 * | { error }. Unknown values of a closed set are an error, not ignored, so a typo does not silently
 * show everything.
 */
export function parseCallsQuery(q = {}) {
  const window = parseWindow(q.window);
  const lim = Number.parseInt(q.limit, 10);
  const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, CALLS_MAX_LIMIT) : CALLS_DEFAULT_LIMIT;
  const c = parseCursor(q.before, { idPattern: BIGINT_ID });
  if (c.error) return { error: c.error };
  const surface = q.surface ? String(q.surface) : null;
  if (surface && surface !== 'mcp' && surface !== 'rest') return { error: 'invalid_surface' };
  const status = q.status ? String(q.status) : null;
  if (status && status !== 'ok' && status !== 'error') return { error: 'invalid_status' };
  const keyId = q.key ? String(q.key) : null;
  if (keyId && !isUUID(keyId)) return { error: 'invalid_key' };
  const route = typeof q.route === 'string' && q.route.trim() ? q.route.trim().slice(0, ROUTE_MAX) : null;
  const search = typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, SEARCH_MAX) : null;
  return { window, limit, before: c.at, beforeId: c.id, surface, route, status, keyId, q: search };
}

/**
 * A user's search as a literal ILIKE pattern: %, _ and \ match themselves. PostgREST also reads
 * `*` as a wildcard and has no escape for it, so a `*` is dropped.
 */
export function ilikeContains(s) {
  return `%${String(s).replace(/\*/g, '').replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * GET /api/usage/activity/calls: newest first, keyset-paged on (at, id), inside the window.
 * next_before is `<at>|<id>` on a full page, null on a short one.
 */
export async function loadCalls(supabase, {
  workspaceId, window, limit = CALLS_DEFAULT_LIMIT, before = null, beforeId = null,
  surface = null, route = null, status = null, keyId = null, q: search = null, now = Date.now(),
}) {
  let q = supabase.from('api_request_log')
    .select('id, at, surface, route, target, status, latency_ms, client, api_key_id')
    .eq('workspace_id', workspaceId)
    .gte('at', windowSince(window, now));
  if (surface) q = q.eq('surface', surface);
  if (route) q = q.eq('route', route);
  if (status === 'ok') q = q.lt('status', 400);
  if (status === 'error') q = q.gte('status', 400);
  if (keyId) q = q.eq('api_key_id', keyId);
  if (search) q = q.ilike('target', ilikeContains(search));
  if (before && beforeId) q = q.or(afterCursorFilter('at', before, beforeId));
  else if (before) q = q.lt('at', before);
  const [rowsRes, keys] = await Promise.all([
    q.order('at', { ascending: false }).order('id', { ascending: false }).limit(limit),
    keyNames(supabase, workspaceId),
  ]);
  const rows = must('calls', rowsRes) ?? [];
  const about = await resolveTargets(supabase, workspaceId, rows.map((r) => r.target));
  return {
    calls: rows.map((r) => ({
      id: String(r.id),
      at: r.at,
      surface: r.surface,
      route: r.route,
      target: r.target ?? null,
      about: r.target ? about.get(r.target) ?? null : null,
      status: r.status,
      latency_ms: r.latency_ms,
      client: r.client ?? null,
      key: { id: r.api_key_id, name: keys.get(r.api_key_id)?.name ?? null },
    })),
    next_before: nextCursor(rows, limit, 'at'),
  };
}
