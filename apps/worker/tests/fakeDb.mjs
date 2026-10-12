// A small in-memory stand-in for the Supabase client, for tests that need to see what a code path
// WRITES. Selects filter the seeded rows (eq / in / is / neq / not / gte / lt / like are applied,
// ordering and column lists are ignored); inserts, upserts, updates and deletes are applied to the
// tables and also recorded in `writes`. rpc() answers { data: null }. Not a database: just enough
// to compare two runs of the same ingest.

export function fakeDb(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const writes = [];
  let nextId = 1;
  const tableOf = (t) => (tables[t] ??= []);

  const likeRe = (pattern) => new RegExp('^' + String(pattern)
    .replace(/\\([\\%_])/g, '\u0000$1')
    .replace(/[.*+?^${}()|[\]]/g, '\\$&')
    .replace(/%/g, '.*').replace(/_/g, '.')
    .replace(/\u0000(.)/g, (_, c) => (c === '\\' ? '\\\\' : c)) + '$');

  function builder(table) {
    const filters = [];
    let op = 'select';
    let payload = null;
    let single = null;
    let limit = null;
    const q = {
      select() { return q; },
      eq(c, v) { filters.push((r) => r[c] === v); return q; },
      neq(c, v) { filters.push((r) => r[c] !== v); return q; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
      not(c, o, v) { if (o === 'is') filters.push((r) => (r[c] ?? null) !== v); return q; },
      gte(c, v) { filters.push((r) => r[c] >= v); return q; },
      lt(c, v) { filters.push((r) => r[c] < v); return q; },
      like(c, p) { const re = likeRe(p); filters.push((r) => re.test(String(r[c] ?? ''))); return q; },
      ilike(c, p) { const re = new RegExp(likeRe(p).source, 'i'); filters.push((r) => re.test(String(r[c] ?? ''))); return q; },
      or() { return q; },
      order() { return q; },
      range() { return q; },
      limit(n) { limit = n; return q; },
      maybeSingle() { single = 'maybe'; return q; },
      single() { single = 'one'; return q; },
      insert(v) { op = 'insert'; payload = v; return q; },
      upsert(v, opts) { op = 'upsert'; payload = { v, opts }; return q; },
      update(v) { op = 'update'; payload = v; return q; },
      delete() { op = 'delete'; return q; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const rows = tableOf(table);
      const match = () => rows.filter((r) => filters.every((f) => f(r)));
      let data;
      if (op === 'select') {
        data = match();
        if (limit != null) data = data.slice(0, limit);
      } else if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `row-${nextId++}`, ...r }));
        rows.push(...list);
        writes.push({ table, op, rows: list });
        data = list;
      } else if (op === 'upsert') {
        const keys = String(payload.opts?.onConflict || 'id').split(',');
        data = (Array.isArray(payload.v) ? payload.v : [payload.v]).map((r) => {
          const hit = rows.find((x) => keys.every((k) => x[k] === r[k]));
          if (hit && payload.opts?.ignoreDuplicates) return null;   // INSERT … ON CONFLICT DO NOTHING
          if (hit) { Object.assign(hit, r); return hit; }
          const row = { id: `row-${nextId++}`, ...r };
          rows.push(row);
          return row;
        }).filter(Boolean);
        writes.push({ table, op, rows: data.map((r) => ({ ...r })) });
      } else if (op === 'update') {
        data = match();
        for (const r of data) Object.assign(r, payload);
        writes.push({ table, op, set: payload, count: data.length });
      } else if (op === 'delete') {
        data = match();
        tables[table] = rows.filter((r) => !data.includes(r));
        writes.push({ table, op, count: data.length });
      }
      if (single) {
        const first = data[0] ?? null;
        if (single === 'one' && !first) return { data: null, error: { message: 'no rows', code: 'PGRST116' } };
        return { data: first, error: null };
      }
      return { data, error: null, count: data.length };
    }
    return q;
  }

  return {
    tables,
    writes,
    from: (t) => builder(t),
    rpc: async () => ({ data: null, error: null }),
  };
}
