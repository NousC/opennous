// Build the claim-pattern graph — WITHOUT any LLM.
//
// The revenue-concept builder (computeConcepts.mjs) used two Haiku passes to extract
// entities and merge synonyms. This does the same job — resolve thousands of claims
// into a handful of named patterns per category — using ONLY data that already exists:
// each claim's category (goal / pain / objection / …) and its embedding (all note.*
// claims are embedded by the embeddings worker). So it costs zero AI credits.
//
// The model the user asked for (Obsidian-style): every claim maps to a pattern node,
// nothing dropped; the graph's VIEW lenses ARE the claim categories; picking a category
// shows its claims resolved into pattern hubs with the accounts hanging off them.
//
// Method:
//   1. Group claims by their existing `category` (the lens).
//   2. Within a category, greedily cluster by cosine similarity of the embeddings.
//   3. Label each cluster extractively (top distinctive terms — no LLM).
//   4. Write each cluster as a graph_concepts row (type = category), which the graph
//      endpoint already reads. No ≥2-account filter — patterns keep every claim.
//
// Run:  docker compose exec -T worker node apps/worker/src/computeClaimPatterns.mjs [workspaceId]

import { getSupabaseClient } from '@nous/core';

// Categories worth turning into lenses. These are the real claim categories (same set
// shown on the account/company Intel tab). `general`/`meeting_notes` are noise buckets,
// excluded so they don't become a junk lens.
const CATEGORIES = [
  'goal', 'pain', 'objection', 'discovery', 'authority', 'timeline', 'budget',
  'preference', 'status_quo', 'relationship', 'competitor', 'data quality', 'buying_signal',
];

const SIM_THRESHOLD = 0.6;    // cosine; lower = fewer, bigger, more meaningful patterns
const MIN_CLUSTER = 3;         // a pattern needs ≥3 claims to be a real recurring theme, not a stray pair
const TOP_PER_CATEGORY = 8;    // show only the top themes per category — a readable handful, not 40 micro-clusters

const STOP = new Set(('a an the and or but of to in on for with at by from into over after their our your they we you i he she it as is are was were be been being that this these those not no do does did have has had can could would should will may might must about your our not out up more most into via per not our their its his her them us me my we our so if then than when what which who whom whose how why where more less over under again once here there all any both each few other some such only own same very can just also get got make made use used using want wants need needs like likes really kind sort thing things lot lots going go went said say says talk talking').split(/\s+/));

const cosine = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // embeddings are unit-normalized by OpenAI, so dot == cosine
};
const parseEmb = (e) => {
  if (Array.isArray(e)) return e;
  if (typeof e === 'string') { try { return JSON.parse(e); } catch { return null; } }
  return null;
};

// Greedy single-pass clustering: each claim joins the nearest cluster whose centroid it
// is within threshold of, else starts its own. Centroid is the running mean. O(n·k),
// fine for hundreds of claims per category.
function cluster(items) {
  const clusters = [];   // { centroid:Float64Array, sum:Float64Array, members:[item] }
  for (const it of items) {
    let best = -1, bestSim = SIM_THRESHOLD;
    for (let c = 0; c < clusters.length; c++) {
      const s = cosine(it.emb, clusters[c].centroid);
      if (s > bestSim) { bestSim = s; best = c; }
    }
    if (best === -1) {
      const sum = Float64Array.from(it.emb);
      clusters.push({ sum, centroid: normalize(sum, 1), members: [it] });
    } else {
      const cl = clusters[best];
      for (let i = 0; i < cl.sum.length; i++) cl.sum[i] += it.emb[i];
      cl.members.push(it);
      cl.centroid = normalize(cl.sum, cl.members.length);
    }
  }
  return clusters;
}
function normalize(sum, n) {
  const out = new Float64Array(sum.length);
  let mag = 0;
  for (let i = 0; i < sum.length; i++) { out[i] = sum[i] / n; mag += out[i] * out[i]; }
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= mag;
  return out;
}

// Extractive label: the terms most distinctive to this cluster vs the rest of the
// category (TF in cluster × IDF across clusters). Title-cased, top 3, no LLM.
// `names` = the workspace's people, excluded so a cluster labels by its THEME
// ("Domain · Deliverability") not by whoever happened to say it ("Brennick · Olavsen").
function labelClusters(clusters, names = new Set()) {
  const tokenize = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w) && !names.has(w));
  const df = new Map();   // term -> # clusters containing it
  const clusterTerms = clusters.map(cl => {
    const tf = new Map();
    for (const m of cl.members) for (const w of tokenize(m.content)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  const N = clusters.length;
  return clusters.map((cl, i) => {
    const tf = clusterTerms[i];
    const scored = [...tf.entries()]
      .map(([w, f]) => [w, f * Math.log((N + 1) / ((df.get(w) || 1))) ]) // tf-idf
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);
    const label = scored.map(w => w.replace(/\b\w/g, c => c.toUpperCase())).join(' · ') || 'Other';
    return label;
  });
}

async function pageAll(makeQuery) {
  const out = []; const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await makeQuery(from, from + size - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

export async function computeClaimPatterns(supabase, workspaceId) {
  // Pull every note.* claim with an embedding: its category, entity, text.
  const claims = await pageAll((a, b) => supabase.from('claims')
    .select('id, entity_id, value, embedding')
    .eq('workspace_id', workspaceId).like('property', 'note.%').is('invalid_at', null)
    .not('embedding', 'is', null).range(a, b));
  if (claims.length < MIN_CLUSTER) { console.log(`  ${workspaceId}: ${claims.length} embedded claims — skip`); return 0; }

  // Every person name in the workspace → excluded from labels, so patterns read by theme
  // ("Domain · Deliverability") not by speaker ("Brennick · Olavsen"). Pull from the name
  // CLAIMS (first_name/last_name/name) so it covers everyone — engaged contacts AND
  // internal people like the founder, who aren't in the `contacts` view.
  const names = new Set();
  const nameClaims = await pageAll((a, b) => supabase.from('claims')
    .select('value').eq('workspace_id', workspaceId).is('invalid_at', null)
    .in('property', ['first_name', 'last_name', 'name']).range(a, b));
  for (const c of nameClaims) {
    const v = c.value;
    const str = typeof v === 'string' ? v : (v?.content || v?.value || '');
    for (const tok of String(str).toLowerCase().split(/\s+/)) {
      const w = tok.replace(/[^a-z0-9-]/g, '');
      if (w.length > 2) names.add(w);
    }
  }

  // Bucket by category.
  const byCat = new Map();
  for (const c of claims) {
    const cat = String(c.value?.category || '').toLowerCase().trim();
    if (!CATEGORIES.includes(cat)) continue;
    const emb = parseEmb(c.embedding);
    if (!emb) continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({ id: c.id, entity: c.entity_id, content: c.value?.content || '', emb });
  }
  // DETERMINISTIC: greedy clustering is order-dependent, so a stable input order → the
  // same clusters (and the same counts) every run. Sort each category's claims by id.
  for (const items of byCat.values()) items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const gen = Date.now();
  const rows = [];
  for (const [cat, items] of byCat) {
    const clusters = cluster(items);
    const labels = labelClusters(clusters, names);
    // Keep only real recurring themes (≥ MIN_CLUSTER claims), then the TOP_PER_CATEGORY
    // biggest — a readable handful per lens, not 40 micro-clusters that fragment the graph.
    const kept = clusters
      .map((cl, i) => ({ cl, label: labels[i] }))
      .filter(x => x.cl.members.length >= MIN_CLUSTER)
      .sort((a, b) => b.cl.members.length - a.cl.members.length)
      .slice(0, TOP_PER_CATEGORY);
    for (const { cl, label } of kept) {
      const ents = [...new Set(cl.members.map(m => m.entity))];
      rows.push({
        workspace_id: workspaceId,
        type: cat,
        label,
        entity_ids: ents,
        claim_ids: cl.members.map(m => m.id),
        size: ents.length,
        generation: gen,
      });
    }
  }

  const byType = {}; for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log(`  ${workspaceId}: ${claims.length} claims → ${rows.length} patterns  ${JSON.stringify(byType)}`);

  if (rows.length) {
    for (let i = 0; i < rows.length; i += 500) await supabase.from('graph_concepts').insert(rows.slice(i, i + 500));
    await supabase.from('graph_concepts').delete().eq('workspace_id', workspaceId).lt('generation', gen);
  }
  return rows.length;
}

// All workspaces with extracted claims.
async function workspacesWithClaims(supabase) {
  const rows = await pageAll((a, b) => supabase.from('claims')
    .select('workspace_id').like('property', 'note.%').filter('value->>source', 'eq', 'signal_extraction').range(a, b));
  return [...new Set(rows.map(r => r.workspace_id))];
}

// Cron entry: rebuild every workspace's claim-pattern graph. Deterministic + embedding-
// based, so it's FREE — no Anthropic/OpenRouter, no per-workspace cost. That's the whole
// reason this replaced the Haiku concept builder: it can run daily for everyone at $0.
export async function computeClaimPatternsCron() {
  const supabase = getSupabaseClient();
  const wsIds = await workspacesWithClaims(supabase);
  let total = 0;
  for (const ws of wsIds) {
    try { total += await computeClaimPatterns(supabase, ws); }
    catch (err) { console.warn(`[CLAIM_PATTERNS] ${ws} failed:`, err?.message || err); }
  }
  console.log(`[CLAIM_PATTERNS] rebuilt ${wsIds.length} workspace(s), ${total} patterns`);
  return { workspaces: wsIds.length, patterns: total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ws = process.argv.slice(2).find(a => !a.startsWith('--'));
  const supabase = getSupabaseClient();
  (async () => {
    const wsIds = ws ? [ws] : (await pageAll((a, b) => supabase.from('claims')
      .select('workspace_id').like('property', 'note.%').filter('value->>source', 'eq', 'signal_extraction').range(a, b)))
      .map(r => r.workspace_id).filter((v, i, arr) => arr.indexOf(v) === i);
    console.log(`CLAIM PATTERNS (no AI) — ${wsIds.length} workspace(s)\n`);
    let total = 0;
    for (const w of wsIds) total += await computeClaimPatterns(supabase, w);
    console.log(`\nDone — ${total} patterns written.`);
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}
