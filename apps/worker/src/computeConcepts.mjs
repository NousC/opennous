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
import { getSupabaseClient } from '@nous/core';
import { read, parseArray, parseObject, acceptsArray, acceptsObject } from './noema/read.mjs';
import { loadOurSide, ourSideNamesList } from './signals/extractionText.mjs';

const TYPES = ['pain', 'tool', 'competitor', 'objection', 'play', 'person', 'connection', 'channel', 'segment'];
const TYPE_SET = new Set(TYPES);

// Concepts go through the model door's extraction tier like every other call (GET-257). The
// CONCEPTS_BASE_URL direct-fetch branch is gone: it skipped the fallback, the host pins and metering.
//
// Both passes are Reads (GET-320): they used to coerce an unreadable answer to `[]` or `{}` and
// carry on, so a batch the model fumbled the format on looked exactly like a batch of claims
// holding no revenue entity, and a whole workspace's concept layer could come out thin with
// nothing saying why. Each declares its own parser and takes its gate from it.
async function readConcepts({ prompt, maxTokens, accept, parse, supabase, workspaceId }) {
  return read({
    supabase, workspaceId,
    feature: 'compute-concepts',
    meterAs: 'compute-concepts',
    accept, parse, maxTokens, prompt,
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

// PASS 1 — extract atomic revenue entities from a batch of claims.
async function extractBatch(batch, supabase, workspaceId, ourSide) {
  const result = await readConcepts({
    supabase, workspaceId, maxTokens: 4000, accept: acceptsArray, parse: parseArray,
    prompt: buildConceptExtractPrompt(batch, ourSide),
  });
  // The caller already treats an empty batch as "nothing here", so a failure keeps that result —
  // it is simply no longer the same answer as far as the record is concerned.
  return result.ok ? result.value : [];
}

/** Pass 1's prompt. `ourSide` (loadOurSide) names our own people so they never become nodes. */
export function buildConceptExtractPrompt(batch, ourSide) {
  const names = ourSideNamesList(ourSide);
  const ours = names ? `the user, ${names}, "Nous"` : 'the user, "Nous"';
  return `You are building a REVENUE knowledge graph. From each GTM claim, extract the atomic revenue ENTITIES it contains — the specific things a sales motion turns on. Each entity is {"type","label"}:
- pain: a specific problem/frustration ("fragmented GTM stack", "reps distrust the CRM")
- tool: a specific product/vendor in their stack ("Clay", "Salesforce", "Instantly")
- competitor: a product competing with OURS they use or evaluated ("relaywise.example", "memory tools")
- objection: a specific concern that blocks a deal ("switching cost", "not differentiated enough")
- play: an initiative/motion they are pursuing ("building own outbound", "moving to AI agents", "hiring a GTM engineer")
- person: a specific NAMED individual + their buying role if stated ("Yvaine Torsdal (evaluator)")
- connection: a named person/org/community they know = a warm path ("Halvard", "YC network", "Clay Club")
- channel: how they found us or a distribution channel ("YouTube", "LinkedIn post")
- segment: their industry / company type ("agency", "fintech", "e-commerce")

label = a SHORT canonical name (2-5 words), normalized so the SAME thing phrased differently gets the SAME label across claims. Extract ONLY what is genuinely present — a claim may yield 0, 1, or several entities. Never invent; skip generic filler ("software", "business", "AI"). Never extract OUR own side (${ours}) as a person, connection, tool, or competitor — these people are our side; never extract them. Only the account's world.

Claims:
${JSON.stringify(batch.map(b => ({ i: b.i, category: b.cat, content: b.content })))}

Return ONLY JSON: [{"i":<index>,"entities":[{"type":"pain|tool|competitor|objection|play|person|connection|channel|segment","label":"..."}]}]`;
}

// PASS 2 — merge synonym labels within a type into canonical labels.
async function canonicalize(type, labels, supabase, workspaceId) {
  if (labels.length <= 1) return new Map(labels.map(l => [l, l]));
  const result = await readConcepts({
    supabase, workspaceId, maxTokens: 2000, accept: acceptsObject, parse: parseObject,
    prompt: `These are "${type}" labels extracted for a revenue graph. Many are the SAME thing phrased differently (e.g. "fragmented stack", "no unified account view", "siloed account data" are one pain). Merge synonyms and map EVERY input label to ONE canonical label (Title Case, 2-5 words). Keep genuinely distinct things separate.

Labels: ${JSON.stringify(labels)}

Return ONLY a JSON object mapping every input label to its canonical label: {"<input>":"<canonical>", ...}`,
  });
  // Degrade the same way the caller's catch does: no merge for this type, raw labels kept. Losing
  // synonym-merging on one type is far cheaper than losing every concept — but it is a loss, and
  // now one you can count.
  const obj = result.ok ? result.value : {};
  return new Map(labels.map(l => [l, obj[l] || l]));
}

// Exported for the post-enrichment hook (contactEnrichmentJobs): rebuild one workspace's
// concept layer the moment its claims land. Thin wrapper so callers don't pass { dry }.
export async function computeWorkspaceConcepts(supabase, workspaceId) {
  return computeWorkspace(supabase, workspaceId, { dry: false });
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

  // Our own people and company, so the prompt can keep them out of the account's world.
  const ourSide = await loadOurSide(supabase, workspaceId);

  // Pass 1: extract entities (batched).
  const raw = [];   // {type, label, entity, claimId}
  const B = 18;
  // The batches are independent, so run them CONCURRENTLY (pool of 6) instead of one at
  // a time. On a reasoning model (~1min/call) a serial loop over a few thousand claims is
  // hours; a pool turns it into minutes. The pool size stays modest to respect the
  // provider's rate limit.
  const batches = [];
  for (let i = 0; i < claims.length; i += B) batches.push(claims.slice(i, i + B));
  const POOL = 6;
  const collect = (batch, res) => {
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
  };
  let bi = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (bi < batches.length) {
      const batch = batches[bi++];
      try { collect(batch, await extractBatch(batch, supabase, workspaceId, ourSide)); }
      catch (e) { console.warn('[CONCEPTS] batch failed:', e?.message || e); }
    }
  }));

  // Pass 2: canonicalize labels per type. Degrade gracefully — if the merge call fails
  // for a type (rate limit, credit, a bad response), fall back to the raw labels
  // (identity mapping) for that type rather than throwing away the whole extract pass.
  // Losing synonym-merging on one type is far cheaper than losing every concept.
  const canonByType = new Map();
  for (const type of TYPES) {
    const labels = [...new Set(raw.filter(r => r.type === type).map(r => r.label))];
    if (!labels.length) continue;
    try {
      canonByType.set(type, await canonicalize(type, labels, supabase, workspaceId));
    } catch (e) {
      console.warn(`[CONCEPTS] canonicalize ${type} failed (${e?.message || e}) — using raw labels`);
      canonByType.set(type, new Map(labels.map(l => [l, l])));
    }
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

// The workspaces whose concept layer is worth (re)building: those with extracted
// (signal_extraction) claims. Same query the CLI's no-arg branch uses.
async function workspacesWithClaims(supabase) {
  const rows = await pageAll((a, b) => supabase.from('claims')
    .select('workspace_id').like('property', 'note.%').filter('value->>source', 'eq', 'signal_extraction').range(a, b));
  return [...new Set(rows.map(r => r.workspace_id))];
}

// Cron entry: rebuild the revenue-concept layer for every workspace that has extracted
// claims. This is what keeps the graph's VIEW lenses (Pains, Objections, Stack, …)
// populated as claims accumulate — without it, concepts only exist if someone runs the
// script by hand. Cross-account by nature (a concept is SHARED across ≥2 accounts), so
// it can't run per-claim on ingestion; it's a scheduled batch, like the scorecard.
export async function computeConceptsCron() {
  const supabase = getSupabaseClient();
  const workspaceIds = await workspacesWithClaims(supabase);
  let built = 0, skipped = 0, total = 0;
  for (const ws of workspaceIds) {
    try {
      // INCREMENTAL: rebuilding re-extracts every claim, so it's only worth it when a
      // workspace actually gained claims since its last build. Concept nodes carry
      // `generation` = Date.now() at build time; if the newest note claim predates that,
      // a rebuild produces the identical graph — so skip it and don't pay for it. This is
      // what keeps the daily cron from being a full ~$0.75/workspace rebuild every night;
      // quiet workspaces cost nothing.
      const { data: lastGen } = await supabase.from('graph_concepts')
        .select('generation').eq('workspace_id', ws)
        .order('generation', { ascending: false }).limit(1).maybeSingle();
      if (lastGen?.generation) {
        const { data: newest } = await supabase.from('claims')
          .select('computed_at').eq('workspace_id', ws).like('property', 'note.%')
          .order('computed_at', { ascending: false }).limit(1).maybeSingle();
        const newestMs = newest?.computed_at ? new Date(newest.computed_at).getTime() : 0;
        if (newestMs <= Number(lastGen.generation)) { skipped++; continue; }
      }
      total += await computeWorkspace(supabase, ws, { dry: false });
      built++;
    } catch (err) { console.warn(`[CONCEPTS] ${ws} failed:`, err?.message || err); }
  }
  console.log(`[CONCEPTS] rebuilt ${built}, skipped ${skipped} unchanged — ${total} concept nodes`);
  return { built, skipped, nodes: total };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const wsArg = args.find(a => !a.startsWith('--'));
  const supabase = getSupabaseClient();
  const workspaceIds = wsArg ? [wsArg] : await workspacesWithClaims(supabase);
  console.log(`${dry ? 'DRY-RUN' : 'COMPUTE'} revenue concepts — ${workspaceIds.length} workspace(s)\n`);
  let total = 0;
  for (const ws of workspaceIds) total += await computeWorkspace(supabase, ws, { dry });
  console.log(`\nDone — ${total} concept nodes${dry ? ' (dry-run)' : ' written'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
