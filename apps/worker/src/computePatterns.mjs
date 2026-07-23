// Compute claim-derived patterns for the context graph.
//
// The USP is claims (raw data -> background reasoning -> claims), so the graph's
// "patterns" should be SEMANTIC clusters of the claims, not exact-match keyword
// counts over extracted edge-labels. This job:
//   1. pulls every Intel claim (signal_extraction) with its embedding, for active accounts
//   2. single-linkage clusters them by cosine distance (< THRESH)
//   3. keeps clusters that span >=2 distinct accounts (a fact one account carries
//      alone is not a pattern)
//   4. labels + quality-grades each cluster with one Haiku call
//   5. writes them to public.claim_patterns under a fresh generation, then drops
//      the previous generation for the workspace
//
// NOTE: uses the raw @anthropic-ai/sdk. The rest of the worker calls Anthropic
// through the `useleak` cost-tracking wrapper; swap the import to match if you want
// this job's label calls to show up in LLM cost tracking too.
//
// Run (worker container):
//   docker compose exec -T worker node apps/worker/src/computePatterns.mjs [workspaceId] [--dry] [--thresh 0.28]
// No workspaceId → every workspace that has Intel claims.
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseClient } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_THRESH = 0.28;   // cosine DISTANCE ceiling for a semantic link (tuned: tighter fragments, looser chains)

// Coarse structural class for the graph's existing cluster-node colouring.
function kindOf(category) {
  const c = (category || '').toLowerCase();
  if (c === 'objection' || c === 'pain') return 'pain';
  if (c === 'goal' || c === 'timeline') return 'intent';
  if (c === 'status_quo' || c === 'competitor' || c === 'budget') return 'stack';
  return 'theme';   // relationship, discovery, authority, preference, general
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

function normalize(vec) {
  let n = 0; for (const x of vec) n += x * x; n = Math.sqrt(n) || 1;
  return vec.map(x => x / n);
}
const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };

// Batch-label clusters: one Haiku call returns a theme + quality grade per cluster.
async function labelClusters(clusters) {
  if (!clusters.length) return new Map();
  const payload = clusters.map((c, i) => ({
    id: i,
    accounts: c.names,
    dominant_category: c.dominantCat,
    claims: c.members.slice(0, 12).map(m => ({ name: m.name, cat: m.cat, content: m.content })),
  }));
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: Math.min(4000, 200 + clusters.length * 90),
    messages: [{ role: 'user', content: `These are semantic clusters of GTM CRM "claims" (facts extracted from sales-call transcripts), grouped by MEANING across different accounts. For EACH cluster produce a crisp 3-6 word PATTERN LABEL naming the shared theme (e.g. "Fragmented stack, no unified view", "Switching-cost objection mid-campaign", "Agency running multiple clients"), and grade it:
- "strong" = the claims genuinely share one coherent, actionable theme
- "weak" = loosely related / one account dominates / grab-bag
- "noise" = unrelated, logistics/scheduling, or actually about the user ("Bennet") not the account

Clusters:
${JSON.stringify(payload)}

Return ONLY a JSON array: [{"id":0,"label":"...","quality":"strong|weak|noise","why":"one short sentence on what they share"}]` }],
  });
  const text = msg.content?.[0]?.text ?? '[]';
  let arr = [];
  try { arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); } catch { /* leave unlabeled */ }
  return new Map(arr.map(o => [o.id, o]));
}

async function computeWorkspace(supabase, workspaceId, { dry, thresh }) {
  // Active person entities only — a merged/parked tombstone keeps its name+claims,
  // and we must not let a folded duplicate re-enter as a second account.
  const ents = await pageAll((a, b) => supabase.from('entities')
    .select('id').eq('workspace_id', workspaceId).eq('type', 'person').eq('status', 'active').range(a, b));
  const active = new Set(ents.map(e => e.id));

  const rawClaims = await pageAll((a, b) => supabase.from('claims')
    .select('id,entity_id,value,embedding')
    .eq('workspace_id', workspaceId).like('property', 'note.%')
    .filter('value->>source', 'eq', 'signal_extraction')
    .not('embedding', 'is', null).range(a, b));

  const contacts = await pageAll((a, b) => supabase.from('contacts')
    .select('id,first_name,last_name').eq('workspace_id', workspaceId).range(a, b));
  const nameOf = new Map(contacts.map(c => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ').trim()]));

  const nodes = rawClaims
    .filter(c => active.has(c.entity_id) && c.value?.content && (nameOf.get(c.entity_id) || '').trim())
    .map(c => ({
      id: c.id, entity: c.entity_id, name: nameOf.get(c.entity_id),
      cat: c.value?.category || 'general', content: c.value.content,
      vec: normalize(typeof c.embedding === 'string' ? JSON.parse(c.embedding) : c.embedding),
    }));

  const N = nodes.length;
  if (N < 2) { console.log(`  ${workspaceId}: ${N} claims — nothing to cluster`); return 0; }

  // single-linkage connected components over the similarity graph
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      if (1 - dot(nodes[i].vec, nodes[j].vec) < thresh) { const ra = find(i), rb = find(j); if (ra !== rb) parent[ra] = rb; }

  const comp = new Map();
  for (let i = 0; i < N; i++) { const r = find(i); (comp.get(r) ?? comp.set(r, []).get(r)).push(nodes[i]); }

  const clusters = [...comp.values()].map(members => {
    const names = [...new Set(members.map(m => m.name))];
    const byEnt = new Set(members.map(m => m.entity));
    const cats = {}; for (const m of members) cats[m.cat] = (cats[m.cat] || 0) + 1;
    const dominantCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0];
    return { members, names, entIds: [...byEnt], size: names.length, dominantCat };
  }).filter(c => c.size >= 2 && c.entIds.length >= 2).sort((a, b) => b.size - a.size);

  if (!clusters.length) { console.log(`  ${workspaceId}: ${N} claims — 0 cross-account clusters`); return 0; }

  const labels = await labelClusters(clusters);
  const gen = Date.now();
  const rows = clusters.map((c, i) => {
    const lab = labels.get(i) || {};
    return {
      workspace_id: workspaceId,
      label: lab.label || c.members[0].content.slice(0, 60),
      category: c.dominantCat,
      kind: kindOf(c.dominantCat),
      quality: lab.quality || 'weak',
      why: lab.why || null,
      entity_ids: c.entIds,
      claim_ids: c.members.map(m => m.id),
      size: c.size,
      generation: gen,
    };
  }).filter(r => r.quality !== 'noise');

  console.log(`  ${workspaceId}: ${N} claims → ${clusters.length} clusters (${rows.length} kept):`);
  for (const r of rows.slice(0, 12)) console.log(`      [${r.quality}/${r.category}] ${r.label}  (${r.size} accounts)`);

  if (dry) { console.log('  (dry-run — nothing written)'); return rows.length; }
  if (rows.length) {
    await supabase.from('claim_patterns').insert(rows);
    await supabase.from('claim_patterns').delete().eq('workspace_id', workspaceId).lt('generation', gen);
  }
  return rows.length;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const ti = args.indexOf('--thresh');
  const thresh = ti !== -1 ? Number(args[ti + 1]) : DEFAULT_THRESH;
  const wsArg = args.find(a => !a.startsWith('--') && !/^\d/.test(a));

  const supabase = getSupabaseClient();
  let workspaceIds;
  if (wsArg) workspaceIds = [wsArg];
  else {
    const rows = await pageAll((a, b) => supabase.from('claims')
      .select('workspace_id').like('property', 'note.%').filter('value->>source', 'eq', 'signal_extraction').range(a, b));
    workspaceIds = [...new Set(rows.map(r => r.workspace_id))];
  }
  console.log(`${dry ? 'DRY-RUN' : 'COMPUTE'} claim patterns — ${workspaceIds.length} workspace(s), thresh=${thresh}\n`);
  let total = 0;
  for (const ws of workspaceIds) total += await computeWorkspace(supabase, ws, { dry, thresh });
  console.log(`\nDone — ${total} patterns${dry ? ' (dry-run)' : ' written'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
