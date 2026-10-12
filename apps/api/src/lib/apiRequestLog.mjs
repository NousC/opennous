// Per-key request log (API plan C1, GET-623).
//
// Every authenticated API-key call (REST /v2 and MCP, which reaches the API as /v2 calls) writes
// one row to api_request_log after its response has finished, so Settings can show a dashboard per
// key. verifyApiKey is the single choke point for key auth, so it is the one caller of
// trackApiKeyRequest(); a session (browser) call never gets here and is never logged.
//
// Never in the request path: rows go into an in-memory buffer flushed every 2s or at 100 rows,
// and every failure (an insert error, a missing table, a throw) is logged and swallowed. A lost
// log row is acceptable; a 500 on an agent call because of logging is not.
//
// The workspace op log (middleware/opLogger.mjs) is a separate stream with a different job: a
// human-readable trail of what the agent did. This one is per key, structured, and aggregated.

import { isIP } from 'node:net';
import { getSupabaseClient } from '@nous/core';

const FLUSH_MS = 2_000;
const FLUSH_ROWS = 100;
// A ceiling on what we hold if the database is down: past it the oldest rows are dropped.
const MAX_BUFFERED = 5_000;
const TARGET_MAX = 120;
const CLIENT_MAX = 80;

// ── Client detection ─────────────────────────────────────────────────────────

// Order matters: the first match wins, and a Cursor or Codex UA can mention other names.
const KNOWN_CLIENTS = [
  [/claude[-_ ]?code|claude-cli/i, 'Claude Code'],
  [/cursor/i, 'Cursor'],
  [/codex/i, 'Codex'],
  [/\bn8n\b/i, 'n8n'],
  [/zapier/i, 'Zapier'],
  [/^curl\//i, 'curl'],
];

/**
 * A readable client name from a User-Agent, or from the end client's name that the MCP server
 * forwards (X-Nous-Agent: its MCP clientInfo name in stdio, the caller's User-Agent when hosted).
 * The forwarded name wins: for an MCP call the API's own User-Agent is the MCP process's fetch.
 * Unknown → the raw string cut to 80 characters; nothing → null.
 */
export function detectClient(userAgent, agentHint = null) {
  for (const raw of [agentHint, userAgent]) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) continue;
    for (const [re, name] of KNOWN_CLIENTS) if (re.test(s)) return name;
  }
  const fallback = [agentHint, userAgent].map((v) => (typeof v === 'string' ? v.trim() : '')).find(Boolean);
  return fallback ? fallback.slice(0, CLIENT_MAX) : null;
}

// ── IP prefix ────────────────────────────────────────────────────────────────

function expandIpv6(ip) {
  // Drop a zone id ("fe80::1%eth0") and an embedded IPv4 tail ("::ffff:1.2.3.4" handled above).
  const addr = ip.split('%')[0];
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  if (addr.includes('::')) {
    const missing = 8 - h.length - t.length;
    if (missing < 0) return null;
    return [...h, ...Array(missing).fill('0'), ...t];
  }
  return h.length === 8 ? h : null;
}

/**
 * The first two octets of an IPv4 address ("203.0") or the first three groups of an IPv6 one
 * ("2001:db8:85a3"). Never the full address: that is the whole point of the column.
 * Anything that is not a valid IP → null.
 */
export function ipPrefix(ip) {
  if (typeof ip !== 'string') return null;
  let addr = ip.trim();
  // IPv4-mapped IPv6 ("::ffff:203.0.113.9") is an IPv4 client behind a dual-stack socket.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const v = isIP(addr.split('%')[0]);
  if (v === 4) return addr.split('.').slice(0, 2).join('.');
  if (v === 6) {
    if (/\d+\.\d+\.\d+\.\d+$/.test(addr)) return null; // other embedded-IPv4 forms: not worth the risk
    const groups = expandIpv6(addr);
    if (!groups) return null;
    return groups.slice(0, 3).map((g) => (g.replace(/^0+(?=.)/, '') || '0').toLowerCase()).join(':');
  }
  return null;
}

// ── Row shape ────────────────────────────────────────────────────────────────

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The REST route PATTERN ("/v2/accounts/:id"), so no ids or search terms are stored as the route. */
export function routePattern(req) {
  const tail = req.route?.path && req.route.path !== '/' ? req.route.path : '';
  const pattern = (req.baseUrl || '') + (typeof tail === 'string' ? tail : '');
  if (pattern) return pattern;
  // No route matched (a 404 inside a router): the mount point, never the raw path's ids.
  return (req.originalUrl || req.url || '').split('?')[0].split('/').slice(0, 3).join('/') || '/';
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, TARGET_MAX) : null;
}

/** What the call was about, when that is cheap to read off the request. Null otherwise. */
export function targetOf(req) {
  const p = req.params || {};
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const q = req.query || {};
  return str(p.id) ?? str(b.focus) ?? str(b.domain) ?? str(q.domain) ?? str(q.account) ?? str(q.focus) ?? null;
}

function header(req, name) {
  if (typeof req.get === 'function') return req.get(name) ?? null;
  return req.headers?.[name.toLowerCase()] ?? null;
}

/** One api_request_log row for a finished request. */
export function buildRow(req, res, latencyMs) {
  const isMcp = String(header(req, 'X-Nous-Client') || '').toLowerCase() === 'mcp';
  const tool = String(header(req, 'X-Nous-Tool') || '').trim();
  const credits = Number(res.locals?.apiCredits);
  return {
    workspace_id: req.apiKeyWorkspaceId ?? req.workspaceId,
    api_key_id: req.apiKeyId,
    at: new Date().toISOString(),
    surface: isMcp ? 'mcp' : 'rest',
    route: isMcp && TOOL_NAME.test(tool) ? tool : routePattern(req),
    target: targetOf(req),
    status: res.statusCode,
    latency_ms: Math.max(0, Math.round(latencyMs)),
    client: detectClient(header(req, 'User-Agent'), header(req, 'X-Nous-Agent')),
    ip_prefix: ipPrefix(req.ip),
    credits: Number.isFinite(credits) && credits > 0 ? Math.round(credits) : 0,
  };
}

// ── The buffer ───────────────────────────────────────────────────────────────

const isMissingTable = (e) => /42P01|PGRST20[45]|does not exist|Could not find the/i
  .test(`${e?.message ?? e} ${e?.code ?? ''}`);

/**
 * A batching writer. `insert(rows)` must resolve to `{ error }` like a Supabase insert. Every
 * failure is logged and the batch dropped; nothing here ever throws to a caller.
 */
export function createRequestLogBuffer({
  insert,
  flushMs = FLUSH_MS,
  flushRows = FLUSH_ROWS,
  maxBuffered = MAX_BUFFERED,
  logger = console,
} = {}) {
  let rows = [];
  let timer = null;
  let lastMissingWarn = 0;

  const report = (msg) => {
    // A table the hand-applied migration has not created yet would otherwise log every 2s.
    if (isMissingTable(msg)) {
      if (Date.now() - lastMissingWarn < 10 * 60_000) return;
      lastMissingWarn = Date.now();
    }
    logger.error('[apiRequestLog] insert failed:', msg?.message ?? msg);
  };

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!rows.length) return 0;
    const batch = rows;
    rows = [];
    try {
      const result = await insert(batch);
      if (result?.error) { report(result.error); return 0; }
      return batch.length;
    } catch (err) {
      report(err);
      return 0;
    }
  }

  function enqueue(row) {
    try {
      rows.push(row);
      if (rows.length > maxBuffered) rows.splice(0, rows.length - maxBuffered);
      if (rows.length >= flushRows) { void flush(); return; }
      if (!timer) {
        timer = setTimeout(() => { void flush(); }, flushMs);
        timer.unref?.();
      }
    } catch (err) {
      logger.error('[apiRequestLog] enqueue failed:', err?.message ?? err);
    }
  }

  return { enqueue, flush, size: () => rows.length };
}

let defaultBuffer = null;
function getDefaultBuffer() {
  if (!defaultBuffer) {
    defaultBuffer = createRequestLogBuffer({
      insert: (batch) => getSupabaseClient().from('api_request_log').insert(batch),
    });
  }
  return defaultBuffer;
}

/** Flush what is buffered (tests, and a graceful shutdown if one is ever wired). */
export function flushApiRequestLog() {
  return defaultBuffer ? defaultBuffer.flush() : Promise.resolve(0);
}

/**
 * Called by verifyApiKey once a key is identified. Registers a finish listener that enqueues one
 * row. Skips a request with no api key (session auth) and a request already being tracked (a
 * route that runs key auth twice). Never throws.
 */
export function trackApiKeyRequest(req, res, { enqueue, now = () => performance.now() } = {}) {
  try {
    if (!req?.apiKeyId || req._apiRequestLogTracked) return false;
    req._apiRequestLogTracked = true;
    const start = now();
    const sink = enqueue ?? ((row) => getDefaultBuffer().enqueue(row));
    res.on('finish', () => {
      try {
        sink(buildRow(req, res, now() - start));
      } catch (err) {
        console.error('[apiRequestLog] row failed:', err?.message ?? err);
      }
    });
    return true;
  } catch (err) {
    console.error('[apiRequestLog] track failed:', err?.message ?? err);
    return false;
  }
}
