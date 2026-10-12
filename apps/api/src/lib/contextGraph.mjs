// The context graph (GET-815): everything the workspace knows as typed nodes and typed links, the
// way a notes app draws a vault. No node in the middle — nothing is tied to "us" — so clusters form
// from who is connected: the people at an account, the deals they sit on, who knows whom. Pure: it
// only reshapes what /api/graph and the deals already hold.

/**
 * net: the /api/graph network ({ nodes, edges }: t 0 person, 1 account, 3 pattern; k 0 works at,
 * 2 shares a pattern, 3 knows; patterns are not drawn). deals: [{ entity_id, name, company_id, stage, status, pipeline_value,
 * last_activity_at }]. stakes: [{ from_entity_id (person), to_entity_id (deal) }].
 */
export function contextGraph(net, deals = [], stakes = [], { now = Date.now() } = {}) {
  const nodes = [];
  const edges = [];
  const ids = new Set();
  const add = (n) => { if (!ids.has(n.id)) { ids.add(n.id); nodes.push(n); } };
  const days = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 86_400_000)) : null; };

  for (const n of net?.nodes ?? []) {
    if (n.t === 1) add({ id: n.i, type: 'account', label: n.l ?? 'Unnamed account', domain: n.d ?? null, icp: n.s ?? null, days: n.a ?? null, people: n.pc ?? 0 });
    else if (n.t === 0) add({ id: n.i, type: 'person', label: n.l ?? 'Unnamed', sub: n.jt ?? null, icp: n.s ?? null, days: n.a ?? null, dm: !!n.dm });
    // Patterns (t 3) are not drawn. Their labels are keyword clusters ("Outreach · Pipeline · Uses",
    // "Paying · Until · Base"), not things anyone can name, and a tool one became a hub every
    // account hung off. What accounts said is read as claims in the record panel, and what it
    // taught us is the Insights view (GET-840, GET-841).
  }
  for (const e of net?.edges ?? []) {
    if (!ids.has(e.s) || !ids.has(e.t)) continue;
    // k 0 is employment; the network sends it as person → account through `co`, not as an edge.
    edges.push({ s: e.s, t: e.t, type: e.k === 3 ? 'knows' : e.k === 2 ? 'shares' : 'works_at' });
  }
  for (const n of net?.nodes ?? []) if (n.t === 0 && n.co && ids.has(n.co)) edges.push({ s: n.i, t: n.co, type: 'works_at' });

  // Deals hang off their account, and the people on them hang off the deal.
  for (const d of deals) {
    if (!d?.entity_id || !ids.has(d.company_id)) continue;
    add({ id: d.entity_id, type: 'deal', label: d.name ?? 'Deal', sub: d.stage ?? d.status ?? null, status: d.status ?? null,
      value: d.pipeline_value != null ? Number(d.pipeline_value) : null, days: days(d.last_activity_at) });
    edges.push({ s: d.entity_id, t: d.company_id, type: 'deal_of' });
  }
  for (const r of stakes) if (ids.has(r.from_entity_id) && ids.has(r.to_entity_id)) edges.push({ s: r.from_entity_id, t: r.to_entity_id, type: 'on_deal' });

  // One link per pair and type.
  const seen = new Set();
  const uniq = edges.filter(e => { const k = `${e.type}|${e.s < e.t ? `${e.s}|${e.t}` : `${e.t}|${e.s}`}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { nodes, edges: uniq };
}

/** A node's neighbourhood to `depth` hops, for the local graph. Pure. */
export function neighbourhood(graph, focus, depth = 1) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.s)) adj.set(e.s, []); if (!adj.has(e.t)) adj.set(e.t, []);
    adj.get(e.s).push(e.t); adj.get(e.t).push(e.s);
  }
  const keep = new Set([focus]);
  let ring = [focus];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of ring) for (const n of adj.get(id) ?? []) if (!keep.has(n)) { keep.add(n); next.push(n); }
    ring = next;
  }
  return { nodes: graph.nodes.filter(n => keep.has(n.id)), edges: graph.edges.filter(e => keep.has(e.s) && keep.has(e.t)) };
}
