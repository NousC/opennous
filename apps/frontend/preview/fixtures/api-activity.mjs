// Preview fixtures for Settings > Workspace > API & MCP activity (GET-898): a seeded 90-day call
// log, aggregated the way GET /api/usage/activity and /api/usage/activity/calls answer (the SQL
// function api_request_log_activity and apps/api/src/lib/apiActivity.mjs). Same seed every start,
// times relative to now, so the page always has a recent day to show. Served on every preview plan.
import { COMPANIES } from "../world.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;

// A small deterministic PRNG, so the log is the same on every start.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  { id: "a1a1a1a1-0000-4000-8000-000000000001", name: "Laptop agent", revoked_at: null },
  { id: "a1a1a1a1-0000-4000-8000-000000000002", name: "Workflow automation", revoked_at: null },
  { id: "a1a1a1a1-0000-4000-8000-000000000003", name: "Reporting script", revoked_at: null },
  { id: "a1a1a1a1-0000-4000-8000-000000000004", name: "Old laptop key", revoked_at: new Date(Date.now() - 20 * DAY).toISOString() },
];
const MCP_TOOLS = [["get_account", 9], ["query", 8], ["get_context", 7], ["deals", 4], ["record", 3], ["attention", 3], ["whoami", 2], ["read_page", 1]];
const REST_ROUTES = [["/v2/context", 5], ["/v2/accounts/:id", 4], ["/v2/query", 3], ["/v2/observations", 2], ["/v2/webhooks", 1]];
const pick = (rnd, weighted) => {
  const total = weighted.reduce((n, [, w]) => n + w, 0);
  let r = rnd() * total;
  for (const [v, w] of weighted) { if ((r -= w) < 0) return v; }
  return weighted[weighted.length - 1][0];
};

function seed() {
  const rnd = mulberry32(898);
  const now = Date.now();
  const rows = [];
  let id = 1;
  for (let d = 89; d >= 0; d--) {
    // Quiet at first, busier lately, lighter at weekends.
    const dayStart = Math.floor((now - d * DAY) / DAY) * DAY;
    const weekend = [0, 6].includes(new Date(dayStart).getUTCDay());
    const base = d > 60 ? 4 : d > 20 ? 14 : 26;
    const n = Math.round(base * (weekend ? 0.35 : 1) * (0.6 + rnd() * 0.8));
    for (let i = 0; i < n; i++) {
      const at = dayStart + Math.floor((7 + rnd() * 13) * HOUR) + Math.floor(rnd() * HOUR);
      if (at > now) continue;
      const mcp = rnd() < 0.72;
      const key = d > 20 && rnd() < 0.15 ? KEYS[3] : mcp ? (rnd() < 0.8 ? KEYS[0] : KEYS[1]) : (rnd() < 0.6 ? KEYS[2] : KEYS[1]);
      const route = mcp ? pick(rnd, MCP_TOOLS) : pick(rnd, REST_ROUTES);
      const co = COMPANIES[Math.floor(rnd() * Math.min(COMPANIES.length, 8))];
      const about = ["get_account", "get_context", "deals", "record", "/v2/context", "/v2/accounts/:id", "/v2/observations"].includes(route)
        ? (rnd() < 0.7 ? co.id : co.domain)
        : null;
      const err = rnd() < 0.035;
      rows.push({
        id: id++, at: new Date(at).toISOString(), surface: mcp ? "mcp" : "rest", route, target: about,
        status: err ? (rnd() < 0.5 ? 404 : 429) : 200,
        latency_ms: Math.round((mcp ? 180 : 90) + rnd() * rnd() * 2400),
        client: mcp ? (key === KEYS[1] ? "n8n" : rnd() < 0.7 ? "Claude Code" : "Cursor") : (key === KEYS[2] ? "Python-urllib/3.13" : "curl"),
        api_key_id: key.id,
      });
    }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
}
const LOG = seed();

const WINDOWS = { "24h": ["hour", 24], "7d": ["day", 7], "30d": ["day", 30], "90d": ["day", 90] };
const winOf = (q) => (Object.hasOwn(WINDOWS, q.get("window") ?? "") ? q.get("window") : "7d");
function buckets(win, now = Date.now()) {
  const [unit, count] = WINDOWS[win];
  const out = [];
  if (unit === "hour") {
    const h = Math.floor(now / HOUR) * HOUR;
    for (let i = count - 1; i >= 0; i--) out.push(`${new Date(h - i * HOUR).toISOString().slice(0, 13)}:00:00Z`);
  } else {
    const t = Date.parse(new Date(now).toISOString().slice(0, 10));
    for (let i = count - 1; i >= 0; i--) out.push(new Date(t - i * DAY).toISOString().slice(0, 10));
  }
  return out;
}
const sinceOf = (win) => { const b = buckets(win)[0]; return b.length === 10 ? `${b}T00:00:00.000Z` : new Date(b).toISOString(); };
const pctl = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; };
const rate = (e, c) => (c ? e / c : null);

function aboutOf(target) {
  if (!target) return null;
  const co = COMPANIES.find((c) => c.id === target || c.domain === target);
  return co ? { id: co.id, type: "company", name: co.name } : null;
}
const keyName = (id) => KEYS.find((k) => k.id === id)?.name ?? null;

function group(rows, keyFn, limit = 10) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    const g = m.get(k) ?? { key: k, rows: [] };
    g.rows.push(r);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.rows.length - a.rows.length).slice(0, limit).map((g) => {
    const errors = g.rows.filter((r) => r.status >= 400).length;
    return { key: g.key, first: g.rows[0], calls: g.rows.length, errors, error_rate: rate(errors, g.rows.length), last_at: g.rows[0].at, p95_ms: pctl(g.rows.map((r) => r.latency_ms), 0.95) };
  });
}

function activity(q) {
  const win = winOf(q);
  const since = sinceOf(win);
  const rows = LOG.filter((r) => r.at >= since);
  const hourly = WINDOWS[win][0] === "hour";
  const bucketOf = (r) => (hourly ? `${r.at.slice(0, 13)}:00:00Z` : r.at.slice(0, 10));
  const series = buckets(win).map((b) => {
    const in_ = rows.filter((r) => bucketOf(r) === b);
    return { bucket: b, calls: in_.length, mcp: in_.filter((r) => r.surface === "mcp").length, rest: in_.filter((r) => r.surface === "rest").length, errors: in_.filter((r) => r.status >= 400).length };
  });
  const errors = rows.filter((r) => r.status >= 400).length;
  return {
    window: win, since, bucket: hourly ? "hour" : "day",
    totals: {
      calls: rows.length, mcp: rows.filter((r) => r.surface === "mcp").length, rest: rows.filter((r) => r.surface === "rest").length,
      errors, error_rate: rate(errors, rows.length),
      p50_ms: pctl(rows.map((r) => r.latency_ms), 0.5), p95_ms: pctl(rows.map((r) => r.latency_ms), 0.95),
      keys: new Set(rows.map((r) => r.api_key_id)).size, clients: new Set(rows.map((r) => r.client).filter(Boolean)).size,
      targets: new Set(rows.map((r) => r.target).filter(Boolean)).size,
    },
    series,
    by_route: group(rows, (r) => `${r.surface}\u0000${r.route}`).map(({ first, calls, errors, error_rate, last_at, p95_ms }) => ({ surface: first.surface, route: first.route, calls, errors, error_rate, last_at, p95_ms })),
    by_target: group(rows, (r) => r.target).map(({ key, calls, errors, error_rate, last_at }) => ({ target: key, about: aboutOf(key), calls, errors, error_rate, last_at })),
    by_key: group(rows, (r) => r.api_key_id, 100).map(({ key, calls, errors, error_rate, last_at }) => ({ api_key_id: key, name: keyName(key), revoked: !!KEYS.find((k) => k.id === key)?.revoked_at, calls, errors, error_rate, last_at })),
    by_client: group(rows, (r) => r.client ?? "").map(({ key, calls, errors, error_rate, last_at }) => ({ client: key || null, calls, errors, error_rate, last_at })),
  };
}

function calls(q) {
  const win = winOf(q);
  const limit = Math.min(Number(q.get("limit")) || 50, 200);
  const surface = q.get("surface"), route = q.get("route"), status = q.get("status"), key = q.get("key");
  const search = (q.get("q") ?? "").toLowerCase();
  const before = q.get("before");
  const [bAt, bId] = before ? [before.slice(0, before.lastIndexOf("|")), Number(before.slice(before.lastIndexOf("|") + 1))] : [null, null];
  const since = sinceOf(win);
  const rows = LOG.filter((r) => r.at >= since
    && (!surface || r.surface === surface) && (!route || r.route === route)
    && (!status || (status === "error" ? r.status >= 400 : r.status < 400))
    && (!key || r.api_key_id === key)
    && (!search || (r.target ?? "").toLowerCase().includes(search) || (aboutOf(r.target)?.name ?? "").toLowerCase().includes(search))
    && (!bAt || r.at < bAt || (r.at === bAt && r.id < bId)));
  const page = rows.slice(0, limit);
  return {
    calls: page.map((r) => ({
      id: String(r.id), at: r.at, surface: r.surface, route: r.route, target: r.target, about: aboutOf(r.target),
      status: r.status, latency_ms: r.latency_ms, client: r.client, key: { id: r.api_key_id, name: keyName(r.api_key_id) },
    })),
    next_before: page.length === limit ? `${page[page.length - 1].at}|${page[page.length - 1].id}` : null,
  };
}

export const routes = [
  ["GET", /^\/api\/usage\/activity$/, (_m, q) => activity(q)],
  ["GET", /^\/api\/usage\/activity\/calls$/, (_m, q) => calls(q)],
];
