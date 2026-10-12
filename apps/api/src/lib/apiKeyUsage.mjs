// The per-key usage dashboard's reads (API plan C1, GET-623), over api_request_log.
//
// Aggregation happens in SQL (the api_request_log_* functions in
// supabase/migrations/2026_10_03_api_request_log.sql): PostgREST returns at most 1000 rows and no
// error past that, so counting a busy key's calls in JS would be silently wrong. This file asks
// for the aggregates, fills the gaps (days with no calls) and shapes the response. Every Supabase
// call checks `error`: a failed read is an error, never a quiet zero.

import { conversationCreditsByKey } from '@nous/core';
import { parseCursor, afterCursorFilter, nextCursor, BIGINT_ID } from './keysetCursor.mjs';

const DAY_MS = 86_400_000;
export const PER_DAY_DAYS = 14;
export const TOTALS_DAYS = 7;
export const BY_ROUTE_LIMIT = 10;
export const REQUESTS_DEFAULT_LIMIT = 50;
export const REQUESTS_MAX_LIMIT = 200;
export const BY_KEY_DEFAULT_DAYS = 30;
export const BY_KEY_MAX_DAYS = 90; // the retention window: older rows are gone

export class UsageReadError extends Error {
  constructor(what, error) {
    super(`${what}: ${error?.message ?? error}`);
    this.code = 'usage_read_failed';
    this.cause = error;
  }
}

const must = (what, { data, error }) => {
  if (error) throw new UsageReadError(what, error);
  return data;
};

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Midnight UTC, `days - 1` days before `now`: the start of a window of `days` calendar days. */
export function windowStart(now, days) {
  const today = Date.parse(utcDay(now));
  return new Date(today - (days - 1) * DAY_MS).toISOString();
}

/**
 * Every day of the window, oldest first, with its calls (0 when the log has none). `rows` are
 * { day, calls, errors } from api_request_log_per_day.
 */
export function fillPerDay(rows, now, days = PER_DAY_DAYS) {
  const byDay = new Map((rows ?? []).map((r) => [String(r.day).slice(0, 10), r]));
  const today = Date.parse(utcDay(now));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(today - i * DAY_MS);
    const r = byDay.get(day);
    out.push({ day, calls: Number(r?.calls ?? 0), errors: Number(r?.errors ?? 0) });
  }
  return out;
}

/** calls_7d / errors_7d: the last seven calendar days (UTC), today included. */
export function totalsFrom(perDay, days = TOTALS_DAYS) {
  const last = perDay.slice(-days);
  return {
    calls_7d: last.reduce((n, d) => n + d.calls, 0),
    errors_7d: last.reduce((n, d) => n + d.errors, 0),
  };
}

// ── Who may see a key ────────────────────────────────────────────────────────

export const isWorkspaceAdmin = (req) => req.workspaceRole === 'owner' || req.workspaceRole === 'admin';

/**
 * Owners/admins see every key in the workspace. Anyone else sees the keys that act as them or
 * that they minted. (The key list itself is workspace-wide today; usage is narrower on purpose,
 * since it shows what someone's agent has been doing.)
 */
export function canSeeKey(req, key) {
  if (!key) return false;
  if (isWorkspaceAdmin(req)) return true;
  const me = req.internalUserId;
  return !!me && (key.owner_user_id === me || key.created_by_user_id === me);
}

/** The key row, workspace-scoped. select('*') so a missing key_prefix column cannot fail it. */
export async function loadKey(supabase, workspaceId, keyId) {
  return must('api key', await supabase
    .from('api_keys')
    .select('*')
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .maybeSingle());
}

export function keySummary(key, lastClient) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.key_prefix ?? null,
    access: key.capability || 'read_write',
    scope: key.owner_user_id ? (key.scope || 'member') : 'admin',
    created_at: key.created_at,
    created_by: key.created_by_user_id ?? null,
    last_used_at: key.last_used_at ?? null,
    last_client: lastClient ?? null,
    expires_at: key.expires_at ?? null,
    revoked_at: key.revoked_at ?? null,
  };
}

// ── Rotation history ─────────────────────────────────────────────────────────

export const ROTATION_CHAIN_MAX = 10;

/**
 * The keys this key replaced by rotation, newest first. Rotation mints a new api_keys row, so a
 * key's request log would start empty on every rotate; the link back is the 'apikey.rotated'
 * audit row (target_id = the new key, metadata.replaced = the old one). The audit write is
 * fire-and-forget, so a missing row only shortens the history; a failed read is logged and the
 * chain stops there (the key's own usage still loads). Bounded at ROTATION_CHAIN_MAX hops.
 */
export async function rotatedFrom(supabase, workspaceId, keyId, max = ROTATION_CHAIN_MAX) {
  const out = [];
  let cur = keyId;
  for (let i = 0; i < max; i++) {
    const { data, error } = await supabase.from('audit_log')
      .select('metadata')
      .eq('action', 'apikey.rotated')
      .eq('target_type', 'api_key')
      .eq('target_id', cur)
      .eq('target_workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) { console.warn('[apiKeyUsage] rotation history read failed:', error.message); break; }
    const prev = data?.[0]?.metadata?.replaced;
    if (typeof prev !== 'string' || !prev || prev === keyId || out.includes(prev)) break;
    out.push(prev);
    cur = prev;
  }
  return out;
}

/** eq for one key, in for a rotation chain. */
const forKeys = (q, keyIds) => (keyIds.length === 1 ? q.eq('api_key_id', keyIds[0]) : q.in('api_key_id', keyIds));

/** Sum per-day rows of several keys into one series. */
function mergePerDay(rowSets) {
  const m = new Map();
  for (const rows of rowSets) {
    for (const r of rows ?? []) {
      const day = String(r.day).slice(0, 10);
      const cur = m.get(day) ?? { day, calls: 0, errors: 0 };
      cur.calls += Number(r.calls ?? 0);
      cur.errors += Number(r.errors ?? 0);
      m.set(day, cur);
    }
  }
  return [...m.values()];
}

/** Sum by-route rows of several keys, top `limit` by calls. */
function mergeByRoute(rowSets, limit) {
  const m = new Map();
  for (const rows of rowSets) {
    for (const r of rows ?? []) {
      const k = `${r.surface}\u0000${r.route}`;
      const cur = m.get(k) ?? { route: r.route, surface: r.surface, calls: 0 };
      cur.calls += Number(r.calls ?? 0);
      m.set(k, cur);
    }
  }
  return [...m.values()].sort((a, b) => b.calls - a.calls).slice(0, limit);
}

/**
 * GET /api/keys/:id/usage, for a key already loaded and authorised. `priorKeyIds` (from
 * rotatedFrom) folds the keys it replaced into the history, so a rotate does not reset the chart.
 */
export async function loadKeyUsage(supabase, { workspaceId, key, priorKeyIds = [], now = Date.now() }) {
  const since = windowStart(now, PER_DAY_DAYS);
  const keyIds = [key.id, ...priorKeyIds];
  // Each key's top routes, wider than the final cut when there are several, so the merged top 10
  // is not just the union of each key's own top 10.
  const routeLimit = keyIds.length === 1 ? BY_ROUTE_LIMIT : BY_ROUTE_LIMIT * 5;
  const [perDayRes, byRouteRes, lastRes] = await Promise.all([
    Promise.all(keyIds.map((id) => supabase.rpc('api_request_log_per_day', {
      p_workspace_id: workspaceId, p_api_key_id: id, p_since: since,
    }))),
    Promise.all(keyIds.map((id) => supabase.rpc('api_request_log_by_route', {
      p_workspace_id: workspaceId, p_api_key_id: id, p_since: since, p_limit: routeLimit,
    }))),
    forKeys(supabase.from('api_request_log')
      .select('client')
      .eq('workspace_id', workspaceId), keyIds)
      .order('at', { ascending: false })
      .limit(1),
  ]);
  const perDayFull = fillPerDay(mergePerDay(perDayRes.map((r) => must('per day', r))), now, PER_DAY_DAYS);
  const byRoute = mergeByRoute(byRouteRes.map((r) => must('by route', r)), BY_ROUTE_LIMIT);
  const last = must('last client', lastRes);
  return {
    key: keySummary(key, last?.[0]?.client ?? null),
    per_day: perDayFull.map(({ day, calls }) => ({ day, calls })),
    by_route: byRoute,
    totals: totalsFrom(perDayFull),
    rotated_from: priorKeyIds,
  };
}

/**
 * limit / before from a query string. `before` is the opaque `<at>|<id>` cursor a previous page
 * returned, or (the old form) a bare timestamp. → { limit, before, beforeId } | { error }.
 */
export function parseRequestsQuery(q = {}) {
  const n = Number.parseInt(q.limit, 10);
  const limit = Number.isFinite(n) && n > 0 ? Math.min(n, REQUESTS_MAX_LIMIT) : REQUESTS_DEFAULT_LIMIT;
  const c = parseCursor(q.before, { idPattern: BIGINT_ID });
  if (c.error) return { error: c.error };
  return { limit, before: c.at, beforeId: c.id };
}

/**
 * GET /api/keys/:id/requests: newest first, keyset-paged on (at, id). `keyIds` adds a rotation
 * chain. next_before is `<at>|<id>` on a full page, null on a short one.
 */
export async function loadKeyRequests(supabase, { workspaceId, keyId, keyIds = [keyId], limit, before, beforeId = null }) {
  let q = forKeys(supabase.from('api_request_log')
    .select('id, at, surface, route, target, status, latency_ms, client')
    .eq('workspace_id', workspaceId), keyIds);
  if (before && beforeId) q = q.or(afterCursorFilter('at', before, beforeId));
  else if (before) q = q.lt('at', before);
  const rows = must('requests', await q
    .order('at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)) ?? [];
  return {
    requests: rows.map(({ id: _id, ...r }) => r),
    next_before: nextCursor(rows, limit, 'at'),
  };
}

export function parseDays(v, dflt = BY_KEY_DEFAULT_DAYS) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(n, BY_KEY_MAX_DAYS);
}

/**
 * A key's credits from the read ledger's per-key sum (API plan E6). The ledger knows a key's
 * credits only for reads written since it stamped keys; when the window also holds reads from
 * before that (`unknown`), a key with nothing on record may still have spent some, so it reads
 * null ("cannot tell"), never 0. Null too when the sum could not be read at all.
 */
export function keyCredits(sum, keyId) {
  if (!sum) return null;
  const n = sum.byKey.get(keyId);
  if (n != null) return n;
  return sum.unknown > 0 ? null : 0;
}

/**
 * GET /api/usage/by-key: calls and credits per key over the last `days`. Every visible active key
 * appears (0 calls when idle); a revoked key appears only if it was used or spent credits in the
 * window. Non-admins see only their own keys.
 *
 * Calls come from api_request_log. Credits do NOT (its `credits` column is per request, and a
 * credit is spent later, in the worker, when Nous reads a conversation a key's write cited): they
 * come from the read ledger, per key (conversationCreditsByKey). Credits from sources connected
 * over OAuth (Gmail, note-takers, the CRM) belong to no key. `credits_complete` is false when the
 * window holds reads whose key is not on record, or the credit sum failed: a number shown is then
 * what is on record, and a key with nothing on record is null.
 */
export async function loadUsageByKey(supabase, {
  req, workspaceId, days, now = Date.now(), creditsByKey = conversationCreditsByKey,
}) {
  const since = windowStart(now, days);
  const [aggRes, keysRes, creditSum] = await Promise.all([
    supabase.rpc('api_request_log_by_key', { p_workspace_id: workspaceId, p_since: since }),
    supabase.from('api_keys')
      .select('id, name, revoked_at, owner_user_id, created_by_user_id')
      .eq('workspace_id', workspaceId),
    // A failed credit read costs the Credits column, not the table: calls still show.
    Promise.resolve()
      .then(() => creditsByKey(supabase, workspaceId, since))
      .catch((err) => { console.warn('[apiKeyUsage] credits by key failed:', err?.message || err); return null; }),
  ]);
  const agg = new Map((must('by key', aggRes) ?? []).map((r) => [r.api_key_id, r]));
  const keys = (must('keys', keysRes) ?? []).filter((k) => canSeeKey(req, k));
  const rows = keys
    .map((k) => ({
      api_key_id: k.id,
      name: k.name,
      revoked: !!k.revoked_at,
      calls: Number(agg.get(k.id)?.calls ?? 0),
      credits: keyCredits(creditSum, k.id),
    }))
    .filter((r) => !r.revoked || agg.has(r.api_key_id) || (r.credits ?? 0) > 0)
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  return { keys: rows, credits_complete: !!creditSum && creditSum.unknown === 0 };
}
