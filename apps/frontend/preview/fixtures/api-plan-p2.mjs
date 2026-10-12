// Preview fixtures for the API keys pages (GET-629, GET-630, GET-639). Served only when
// PREVIEW_PLAN=api (server.mjs spreads `routes` ahead of its own), so the visual baselines never
// see them. Keys are stateful for the session: create, rename, extend, rotate and revoke stick, and
// a revoke can be undone for 10 minutes, as the API allows.
//
//   PREVIEW_KEYS=empty   start with no keys (the empty state)
import crypto from "node:crypto";

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const ahead = (days) => new Date(Date.now() + days * DAY).toISOString();
const hex = (n) => crypto.randomBytes(n).toString("hex");

const readBody = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});

let keys = process.env.PREVIEW_KEYS === "empty" ? [] : [
  { id: "11111111-1111-4111-8111-111111111111", name: "claude-code", key_prefix: "pk_8f3a2c", created_at: ago(21), last_used_at: ago(0.0015), capability: "read_write", expires_at: null, scope: "admin", created_by_user_id: "u1", client: "Claude Code" },
  { id: "22222222-2222-4222-8222-222222222222", name: "n8n-prod", key_prefix: "pk_2b7d90", created_at: ago(44), last_used_at: ago(0.17), capability: "read_write", expires_at: null, scope: "admin", created_by_user_id: "u1", client: "n8n" },
  { id: "33333333-3333-4333-8333-333333333333", name: "metabase-readonly", key_prefix: "pk_e90c41", created_at: ago(62), last_used_at: ago(1.1), capability: "read_only", expires_at: ahead(5.5), scope: "admin", created_by_user_id: "u1", client: "Metabase" },
  { id: "44444444-4444-4444-8444-444444444444", name: "staging-sandbox", key_prefix: null, created_at: ago(3), last_used_at: null, capability: "read_write", expires_at: null, scope: "admin", created_by_user_id: "u1", client: null },
];

const listRow = ({ client: _c, created_by_user_id: _u, origin: _o, ...k }) => k;

function mint(body, base = {}) {
  const key = `pk_${hex(24)}`;
  const days = Number(body.expires_in_days);
  const row = {
    id: crypto.randomUUID(), name: base.name ?? String(body.name ?? "key").trim(), key_prefix: key.slice(0, 9),
    created_at: new Date().toISOString(), last_used_at: null,
    capability: base.capability ?? (body.capability === "read_only" ? "read_only" : "read_write"),
    expires_at: days > 0 ? ahead(days) : null, scope: "admin", created_by_user_id: "u1", client: null,
    // A rotated key carries its predecessor's history (as the real usage folds rotated_from in).
    origin: base.origin ?? base.id,
  };
  return { row, key };
}

// Usage: the board's 14 days for the busiest key, scaled down for the others, nothing for a new one.
const SHAPE = [182, 240, 196, 0, 0, 260, 310, 210, 340, 280, 390, 120, 60, 412];
const TOOLS = [["get_account", 0.36], ["query", 0.26], ["record", 0.2], ["score", 0.1], ["get_context", 0.08]];
// By id, not name, so a renamed key keeps its history.
const CLAUDE_CODE = "11111111-1111-4111-8111-111111111111";
const N8N = "22222222-2222-4222-8222-222222222222";
const lineage = (k) => k.origin ?? k.id;
const scaleOf = (k) => (!k.last_used_at ? 0 : lineage(k) === CLAUDE_CODE ? 1 : lineage(k) === N8N ? 0.35 : 0.08);

function usage(k) {
  const s = scaleOf(k);
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const per_day = SHAPE.map((v, i) => ({ day: new Date(today - (13 - i) * DAY).toISOString().slice(0, 10), calls: Math.round(v * s) }));
  const total = per_day.reduce((n, d) => n + d.calls, 0);
  const calls_7d = per_day.slice(-7).reduce((n, d) => n + d.calls, 0);
  return {
    key: {
      id: k.id, name: k.name, prefix: k.key_prefix, access: k.capability, scope: k.scope,
      created_at: k.created_at, created_by: k.created_by_user_id, last_used_at: k.last_used_at,
      last_client: k.client, expires_at: k.expires_at, revoked_at: null,
    },
    per_day,
    by_route: total ? TOOLS.map(([route, f]) => ({ route, surface: lineage(k) === N8N ? "rest" : "mcp", calls: Math.round(total * f) })) : [],
    totals: { calls_7d, errors_7d: Math.round(calls_7d * 0.004) },
  };
}

const TARGETS = {
  get_account: ["kestrelpay.example", "fernhill.example", "meridian.example"],
  query: ['"who went quiet this week"', '"open deals over 50k"'],
  record: ["maya@kestrelpay.example · call", "tom@fernhill.example · email"],
  score: ["40 leads", "12 leads"],
  get_context: ["fernhill.example", "kestrelpay.example"],
};

function requests(k, before, limit) {
  if (!scaleOf(k)) return { requests: [], next_before: null };
  const rest = lineage(k) === N8N;
  const all = [];
  let t = Date.parse(k.last_used_at);
  for (let i = 0; i < 80; i++) {
    const [tool] = TOOLS[i % TOOLS.length];
    const status = i === 3 ? 429 : i === 17 ? 500 : i === 29 ? 401 : 200;
    all.push({
      at: new Date(t).toISOString(), surface: rest ? "rest" : "mcp",
      route: rest ? `POST /v2/${tool === "get_account" ? "accounts" : tool}` : tool,
      target: TARGETS[tool][i % TARGETS[tool].length], status,
      latency_ms: status === 429 ? 12 : [84, 412, 131, 1840, 96][i % 5], client: k.client,
    });
    t -= (7 + (i * 37) % 900) * 60_000 / 10;
  }
  const from = before ? all.filter((r) => r.at < before) : all;
  const page = from.slice(0, limit);
  return { requests: page, next_before: page.length === limit ? page[page.length - 1].at : null };
}

const find = (id) => keys.find((k) => k.id === id);
// Revoked keys, by id, with when: what an undo can bring back.
const revoked = new Map();

export const routes = [
  ["GET", /^\/api\/workspace\/api-keys$/, () => ({ api_keys: keys.map(listRow) })],
  ["POST", /^\/api\/workspace\/api-keys$/, async (_m, _q, req) => {
    const body = await readBody(req);
    if (!String(body.name ?? "").trim()) return { __status: 400, error: "name_required" };
    const { row, key } = mint(body);
    keys = [row, ...keys];
    return { __status: 201, ...listRow(row), key };
  }],
  ["POST", /^\/api\/workspace\/api-keys\/([^/]+)\/rotate$/, async (m, _q, req) => {
    const old = find(m[1]);
    if (!old) return { error: "not_found" };
    const { row, key } = mint(await readBody(req), old);
    keys = keys.map((k) => (k.id === old.id ? row : k));
    return { __status: 201, ...listRow(row), key };
  }],
  ["PATCH", /^\/api\/workspace\/api-keys\/([^/]+)$/, async (m, _q, req) => {
    const k = find(m[1]);
    if (!k) return { __status: 404, error: "not_found" };
    const name = String((await readBody(req)).name ?? "").trim();
    if (!name) return { __status: 400, error: "name_required" };
    if (name.length > 60) return { __status: 400, error: "name_too_long" };
    if (keys.some((o) => o.id !== k.id && o.name === name)) return { __status: 409, error: "name_taken" };
    k.name = name;
    return { id: k.id, name };
  }],
  ["DELETE", /^\/api\/workspace\/api-keys\/([^/]+)$/, (m) => {
    const k = find(m[1]);
    if (k) revoked.set(k.id, { key: k, at: Date.now(), index: keys.indexOf(k) });
    keys = keys.filter((x) => x.id !== m[1]);
    return { success: true };
  }],
  ["POST", /^\/api\/workspace\/api-keys\/([^/]+)\/extend$/, async (m, _q, req) => {
    const k = find(m[1]);
    if (!k) return { __status: 404, error: "not_found" };
    const days = Number((await readBody(req)).days);
    if (![30, 90, 365].includes(days)) return { __status: 400, error: "invalid_days" };
    if (!k.expires_at) return { __status: 409, error: "no_expiry" };
    k.expires_at = new Date(Math.max(Date.now(), Date.parse(k.expires_at)) + days * DAY).toISOString();
    return { id: k.id, name: k.name, expires_at: k.expires_at };
  }],
  ["POST", /^\/api\/workspace\/api-keys\/([^/]+)\/restore$/, (m) => {
    const r = revoked.get(m[1]);
    if (!r) return { __status: 404, error: "not_found" };
    if (Date.now() - r.at > 10 * 60_000) return { __status: 409, error: "undo_window_passed" };
    if (keys.some((k) => k.name === r.key.name)) return { __status: 409, error: "name_taken" };
    revoked.delete(m[1]);
    keys = [...keys.slice(0, r.index), r.key, ...keys.slice(r.index)];
    return { ...listRow(r.key), can_manage: true };
  }],
  ["GET", /^\/api\/keys\/([^/]+)\/usage$/, (m) => {
    const k = find(m[1]);
    return k ? usage(k) : { error: "not_found" };
  }],
  ["GET", /^\/api\/keys\/([^/]+)\/requests$/, (m, q) => {
    const k = find(m[1]);
    if (!k) return { error: "not_found" };
    return requests(k, q.get("before"), Math.min(Number(q.get("limit")) || 50, 200));
  }],
];
