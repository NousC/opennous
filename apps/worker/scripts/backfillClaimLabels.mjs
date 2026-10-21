// One-time backfill: give every extracted intel claim a concise 2–4 word `label` so the
// UI chips read as substance ("Quarrystone Leads", "Stale Apollo data") instead of the first
// two words of the sentence. Idempotent — only touches signal_extraction note claims that
// have no label yet. New claims already ship with a label from the extractor.
//
//   node apps/worker/scripts/backfillClaimLabels.mjs [--dry] [--limit=N] [--workspace=UUID]
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY in the environment.
import { getSupabaseClient } from '@nous/core';
import { createMessage, messageText } from '../src/lib/llm.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const LIMIT = Number((argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const WORKSPACE = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
const BATCH = 12;      // claims per LLM call
const CONCURRENCY = 4; // parallel LLM calls

const supabase = getSupabaseClient();

const PROMPT = (items) => `For each numbered claim, write a concise 2–4 word tag naming its SUBSTANCE — what a salesperson would skim on a card. NOT the person's name. Title Case, no trailing period.

Rules by category:
- competitor: the competitor/vendor name (e.g. "Quarrystone Leads", "Brightlist leads").
- objection: the objection itself (e.g. "Already on Salesforce", "Outbound intent doubts").
- pain: the pain (e.g. "Stale Apollo data").
- goal: the goal (e.g. "Expand to healthcare").
- budget/timeline/other: the concrete substance in 2–4 words.

Claims:
${items.map(it => `${it.i}. [${it.category}] ${it.content}`).join('\n')}

Output ONLY valid JSON: [{"i": <number>, "label": "2-4 word tag"}]`;

async function labelBatch(items) {
  try {
    const msg = await createMessage({
      meter: { workspaceId: null },
      feature: 'backfill-claim-labels',
      max_tokens: 1024,
      accept: (t) => /\[[\s\S]*\]/.test(t),
      messages: [{ role: 'user', content: PROMPT(items) }],
    });
    const text = messageText(msg).trim() || '[]';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    const arr = s !== -1 && e !== -1 ? JSON.parse(text.slice(s, e + 1)) : [];
    const byI = new Map(arr.map(r => [Number(r.i), String(r.label || '').trim().slice(0, 40)]));
    return items.map(it => ({ id: it.id, value: it.value, label: byI.get(it.i) || null }));
  } catch (err) {
    console.warn('  [batch failed]', err.message);
    return [];
  }
}

async function run() {
  // Page through every unlabelled signal_extraction note claim.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('claims')
      .select('id, workspace_id, value')
      .like('property', 'note.%')
      .is('invalid_at', null)
      .range(from, from + PAGE - 1);
    if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
    const { data, error } = await q;
    if (error) throw error;
    if (!data?.length) break;
    for (const r of data) {
      const v = r.value || {};
      if (v.source === 'signal_extraction' && !v.label && v.content) rows.push(r);
    }
    if (data.length < PAGE) break;
  }

  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`Found ${rows.length} unlabelled signal_extraction claims; processing ${todo.length}${DRY ? ' (dry run)' : ''}.`);

  // Build batches.
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    batches.push(slice.map((r, k) => ({ i: k + 1, id: r.id, value: r.value, category: r.value.category || 'general', content: String(r.value.content).slice(0, 400) })));
  }

  let done = 0, labelled = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(group.map(labelBatch));
    for (const batchResult of results) {
      for (const r of batchResult) {
        if (!r.label) continue;
        if (!DRY) {
          const newValue = { ...r.value, label: r.label };
          const { error } = await supabase.from('claims').update({ value: newValue }).eq('id', r.id);
          if (error) { console.warn('  [update failed]', r.id, error.message); continue; }
        }
        labelled++;
      }
    }
    done += group.reduce((s, b) => s + b.length, 0);
    console.log(`  ${done}/${todo.length} processed, ${labelled} labelled`);
  }
  console.log(`Done. ${labelled} claims labelled${DRY ? ' (dry — nothing written)' : ''}.`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
