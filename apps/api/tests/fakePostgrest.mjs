// A small in-memory PostgREST stand-in for route tests, served over HTTP so the real supabase-js
// client talks to it: eq / neq / is / not.is / in / not.in / gte / or filters, select, insert,
// update, delete, HEAD counts, and single() as PostgREST answers it. Not a database.
//
// startFakePostgrest(() => tables) points SUPABASE_URL at it, before anything creates the client,
// so nothing in a test can reach a real project.
import http from 'node:http';

const unquote = (s) => s.replace(/^"|"$/g, '');
/** Split "a.b,c.d.(x,y)" on the commas outside parentheses. */
function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}
function filterOf(col, expr) {
  if (col === 'or') {
    const parts = splitTop(expr.slice(1, -1)).map((p) => { const i = p.indexOf('.'); return filterOf(p.slice(0, i), p.slice(i + 1)); });
    return (r) => parts.some((f) => f(r));
  }
  const val = (r) => (r[col] === undefined || r[col] === null ? null : String(r[col]));
  if (expr === 'is.null') return (r) => val(r) === null;
  if (expr === 'not.is.null') return (r) => val(r) !== null;
  if (expr.startsWith('not.in.(')) { const list = expr.slice(8, -1).split(',').map(unquote); return (r) => val(r) !== null && !list.includes(val(r)); }
  if (expr.startsWith('eq.')) return (r) => val(r) === expr.slice(3);
  if (expr.startsWith('neq.')) return (r) => val(r) !== expr.slice(4);
  if (expr.startsWith('gte.')) return (r) => val(r) !== null && val(r) >= expr.slice(4);
  if (expr.startsWith('in.(')) { const list = expr.slice(4, -1).split(',').map(unquote); return (r) => list.includes(val(r)); }
  return () => true;   // like, ilike and the rest: not narrowed
}

export async function startFakePostgrest(getTables) {
  const server = http.createServer(async (req, res) => {
    const tables = getTables();
    const u = new URL(req.url, 'http://x');
    let body = ''; for await (const c of req) body += c;
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    const rows = (tables[table] ??= []);
    const filters = [];
    for (const [k, v] of u.searchParams) if (!['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) filters.push(filterOf(k, v));
    let out = rows.filter((r) => filters.every((f) => f(r)));
    if (req.method === 'POST') {
      const list = [].concat(JSON.parse(body || '[]')).map((r) => ({ id: `row-${rows.length + 1}`, ...r }));
      rows.push(...list); out = list;
    } else if (req.method === 'PATCH') {
      const patch = JSON.parse(body || '{}');
      for (const r of out) Object.assign(r, patch);
    } else if (req.method === 'DELETE') {
      tables[table] = rows.filter((r) => !out.includes(r));
    }
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = u.searchParams.get('limit');
    if (req.method === 'GET') out = out.slice(offset, limit == null ? undefined : offset + Number(limit));
    const headers = { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(out.length - 1, 0)}/${out.length}` };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    if (String(req.headers.accept ?? '').includes('vnd.pgrst.object')) {
      if (out.length !== 1) { res.writeHead(406, headers); return res.end(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null })); }
      res.writeHead(200, headers); return res.end(JSON.stringify(out[0]));
    }
    res.writeHead(200, headers); res.end(JSON.stringify(out));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
  return { close: () => new Promise((r) => server.close(r)) };
}

/** Serve an Express app on a free port. */
export async function serveApp(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** One JSON request: { status, body, text }. */
export async function callJson(base, method, path, body) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
