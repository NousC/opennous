// Build the REVENUE ENTITY GRAPH from claims.
//
// A claim is a container; the atoms are the revenue entities inside it. This job
// extracts those atoms (pain, tool, competitor, objection, play, person, connection,
// channel, segment), canonicalizes synonyms across accounts so the same thing said
// three ways collapses to ONE node, and stores each shared node (>=2 accounts) with
// the accounts + claims that point to it. graph.mjs then draws the typed web.
//
// Two LLM passes: (1) extract {type,label} per claim, (2) merge synonym labels per
// type into a canonical label. No embeddings needed — the merge pass does the dedupe.
//
// NOTE: raw @anthropic-ai/sdk (not the `useleak` wrapper) — see computePatterns.mjs.
//
// Run (worker container):
//   docker compose exec -T worker node apps/worker/src/computeConcepts.mjs [workspaceId] [--dry]
import Anthropic from '@anthropic-ai/sdk';
import { getSupabaseClient } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';
const TYPES = ['pain', 'tool', 'competitor', 'objection', 'play', 'person', 'connection', 'channel', 'segment'];
const TYPE_SET = new Set(TYPES);

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

const jsonFrom = (text, open = '[', close = ']') => {
  const s = text.indexOf(open), e = text.lastIndexOf(close);
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
};

// PASS 1 — extract atomic revenue entities from a batch of claims.
async function extractBatch(batch) {
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 4000,
    messages: [{ role: 'user', content: `You are building a REVENUE knowledge graph. From each GTM claim, extract the atomic revenue ENTITIES it contains — the specific things a sales motion turns on. Each entity is {"type","label"}:
- pain: a specific problem/frustration ("fragmented GTM stack", "reps distrust the CRM")
- tool: a specific product/vendor in their stack ("Clay", "Salesforce", "Instantly")
- competitor: a product competing with OURS they use or evaluated ("reo.dev", "memory tools")
- objection: a specific concern that blocks a deal ("switching cost", "not differentiated enough")
- play: an initiative/motion they are pursuing ("building own outbound", "moving to AI agents", "hiring a GTM engineer")
- person: a specific NAMED individual + their buying role if stated ("Priya Nair (evaluator)")
- connection: a named person/org/community they know = a warm path ("Georgi", "YC network", "Clay Club")
- channel: how they found us or a distribution channel ("YouTube", "LinkedIn post")
- segment: their industry / company type ("agency", "fintech", "e-commerce")

label = a SHORT canonical name (2-5 words), normalized so the SAME thing phrased differently gets the SAME label across claims. Extract ONLY what is genuinely present — a claim may yield 0, 1, or several entities. Never invent; skip generic filler ("software", "business", "AI"). Never extract OUR own side (the user, "Bennet", "Bennet Glinder", "Nous") as a person, connection, tool, or competitor — only the account's world.

Claims:
${JSON.stringify(batch.map(b => ({ i: b.i, category: b.cat, content: b.content })))}

Return ONLY JSON: [{"i":<index>,"entities":[{"type":"pain|tool|competitor|objection|play|person|connection|channel|segment","label":"..."}]}]` }],
  });
  return jsonFrom(msg.content?.[0]?.text ?? '[]') || [];
}

// PASS 2 — merge synonym labels within a type into canonical labels.
async function canonicalize(type, labels) {
  if (labels.length <= 1) return new Map(labels.map(l => [l, l]));
  const msg = await anthropic.messages.create({
    model: MODEL, max_tokens: 2000,
    messages: [{ role: 'user', content: `These are "${type}" labels extracted for a revenue graph. Many are the SAME thing phrased differently (e.g. "fragmented stack", "no unified account view", "siloed account data" are one pain). Merge synonyms and map EVERY input label to ONE canonical label (Title Case, 2-5 words). Keep genuinely distinct things separate.

Labels: ${JSON.stringify(labels)}

Return ONLY a JSON object mapping every input label to its canonical label: {"<input>":"<canonical>", ...}` }],
  });
  const obj = jsonFrom(msg.content?.[0]?.text ?? '{}', '{', '}') || {};
  return new Map(labels.map(l => [l, obj[l] || l]));
}

async function computeWorkspace(supabase, workspaceId, { dry }) {
  const ents = await pageAll((a, b) => supabase.from('entities')
    .select('id').eq('workspace_id', workspaceId).eq('type', 'person').eq('status', 'active').range(a, b));
  const active = new Set(ents.map(e => e.id));

  const rawClaims = await pageAll((a, b) => supabase.from('claims')
    .select('id,entity_id,value')
    .eq('workspace_id', workspaceId).like('property', 'note.%')
    .filter('value->>source', 'eq', 'signal_extraction').range(a, b));

  const contacts = await pageAll((a, b) => supabase.from('contacts')
    .select('id,first_name,last_name').eq('workspace_id', workspaceId).range(a, b));
  const nameOf = new Map(contacts.map(c => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ').trim()]));

  const claims = rawClaims
    .filter(c => active.has(c.entity_id) && c.value?.content && (nameOf.get(c.entity_id) || '').trim())
    .map((c, i) => ({ i, id: c.id, entity: c.entity_id, cat: c.value?.category || 'general', content: c.value.content }));
  if (claims.length < 2) { console.log(`  ${workspaceId}: ${claims.length} claims — skip`); return 0; }

  // Pass 1: extract entities (batched).
  const raw = [];   // {type, label, entity, claimId}
  const B = 18;
  for (let i = 0; i < claims.length; i += B) {
    const batch = claims.slice(i, i + B);
    const res = await extractBatch(batch);
    for (const r of (res || [])) {
      const src = batch[batch.findIndex(b => b.i === r.i)] || claims[r.i];
      if (!src) continue;
      for (const e of (r.entities || [])) {
        const type = String(e?.type || '').toLowerCase();
        const label = String(e?.label || '').trim();
        if (!TYPE_SET.has(type) || label.length < 2) continue;
        raw.push({ type, label, entity: src.entity, claimId: src.id });
      }
    }
  }

  // Pass 2: canonicalize labels per type.
  const canonByType = new Map();
  for (const type of TYPES) {
    const labels = [...new Set(raw.filter(r => r.type === type).map(r => r.label))];
    if (!labels.length) continue;
    canonByType.set(type, await canonicalize(type, labels));
  }

  // Build typed concept nodes: canonical (type,label) -> accounts + claims.
  const nodes = new Map();   // key `${type}::${canonLabel}` -> {type,label,ents:Set,claims:Set}
  for (const r of raw) {
    const canon = canonByType.get(r.type)?.get(r.label) || r.label;
    const key = `${r.type}::${canon.toLowerCase()}`;
    if (!nodes.has(key)) nodes.set(key, { type: r.type, label: canon, ents: new Set(), claims: new Set() });
    const n = nodes.get(key); n.ents.add(r.entity); n.claims.add(r.claimId);
  }

  const gen = Date.now();
  const rows = [...nodes.values()]
    .filter(n => n.ents.size >= 2)   // shared concepts are the connective tissue
    .sort((a, b) => b.ents.size - a.ents.size)
    .map(n => ({
      workspace_id: workspaceId, type: n.type, label: n.label,
      entity_ids: [...n.ents], claim_ids: [...n.claims], size: n.ents.size, generation: gen,
    }));

  const byType = {}; for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log(`  ${workspaceId}: ${claims.length} claims → ${raw.length} entities → ${rows.length} shared concept nodes  ${JSON.stringify(byType)}`);
  for (const r of rows.slice(0, 14)) console.log(`      [${r.type}] ${r.label}  (${r.size} accounts)`);

  if (dry) { console.log('  (dry-run — nothing written)'); return rows.length; }
  if (rows.length) {
    for (let i = 0; i < rows.length; i += 500) await supabase.from('graph_concepts').insert(rows.slice(i, i + 500));
    await supabase.from('graph_concepts').delete().eq('workspace_id', workspaceId).lt('generation', gen);
  }
  return rows.length;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const wsArg = args.find(a => !a.startsWith('--'));
  const supabase = getSupabaseClient();
  let workspaceIds;
  if (wsArg) workspaceIds = [wsArg];
  else {
    const rows = await pageAll((a, b) => supabase.from('claims')
      .select('workspace_id').like('property', 'note.%').filter('value->>source', 'eq', 'signal_extraction').range(a, b));
    workspaceIds = [...new Set(rows.map(r => r.workspace_id))];
  }
  console.log(`${dry ? 'DRY-RUN' : 'COMPUTE'} revenue concepts — ${workspaceIds.length} workspace(s)\n`);
  let total = 0;
  for (const ws of workspaceIds) total += await computeWorkspace(supabase, ws, { dry });
  console.log(`\nDone — ${total} concept nodes${dry ? ' (dry-run)' : ' written'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
