// One-time backfill: add the context tags the Deal Health engine needs onto existing
// competitor + objection claims — so a fired past vendor stops reading as "high risk"
// and a resolved objection stops holding "blocker: critical". New claims get these from
// the extractor; this catches the backlog. Idempotent (skips already-tagged rows).
//
//   node apps/worker/scripts/backfillClaimContext.mjs [--dry] [--limit=N]
//
// competitor → metadata.entity + metadata.stance (evaluating|incumbent|past_failure|mentioned)
// objection  → metadata.status (open|resolved|addressed) + metadata.hardness (hard|soft)
//
// Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY in the environment.
import { getSupabaseClient } from '@nous/core';
import { createMessage, messageText } from '../src/lib/llm.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const LIMIT = Number((argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
const BATCH = 12;
const CONCURRENCY = 4;

const supabase = getSupabaseClient();

const PROMPTS = {
  competitor: (items) => `For each claim about a competitor/vendor, decide its posture toward the buyer's deal with US.
Return ONLY JSON: [{"i": <n>, "entity": "<vendor name only>", "stance": "evaluating|incumbent|past_failure|mentioned"}]
- entity: the competitor/vendor NAME only (e.g. "Quarrystone Leads", "Brightlist").
- stance: "evaluating" = a live alternative they're weighing against us; "incumbent" = a tool/vendor they currently use; "past_failure" = a vendor they TRIED and it failed or they fired them (this is an opening for us, not a threat); "mentioned" = named in passing, no clear posture.

Claims:
${items.map(it => `${it.i}. ${it.content}`).join('\n')}`,

  objection: (items) => `For each objection/concern the buyer raised, classify it.
Return ONLY JSON: [{"i": <n>, "status": "open|resolved|addressed", "hardness": "hard|soft"}]
- status: "open" = still an unresolved concern; "resolved" = answered / no longer a concern; "addressed" = we responded, awaiting their confirmation.
- hardness: "hard" = budget, authority, security, legal, procurement — a real gate; "soft" = needs info, timing, or a minor preference.

Claims:
${items.map(it => `${it.i}. ${it.content}`).join('\n')}`,
};

async function tagBatch(category, items) {
  try {
    const msg = await createMessage({
      meter: { workspaceId: null },
      feature: 'backfill-claim-context', max_tokens: 1024,
      accept: (t) => /\[[\s\S]*\]/.test(t),
      messages: [{ role: 'user', content: PROMPTS[category](items) }],
    });
    const text = messageText(msg).trim() || '[]';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    const arr = s !== -1 && e !== -1 ? JSON.parse(text.slice(s, e + 1)) : [];
    const byI = new Map(arr.map(r => [Number(r.i), r]));
    return items.map(it => ({ id: it.id, value: it.value, category, tag: byI.get(it.i) || null }));
  } catch (err) {
    console.warn('  [batch failed]', err.message);
    return [];
  }
}

function cleanTag(category, tag) {
  if (!tag) return null;
  if (category === 'competitor') {
    const stance = ['evaluating', 'incumbent', 'past_failure', 'mentioned'].includes(tag.stance) ? tag.stance : 'mentioned';
    const entity = typeof tag.entity === 'string' ? tag.entity.trim().slice(0, 60) || null : null;
    return { entity, stance };
  }
  const status = ['open', 'resolved', 'addressed'].includes(tag.status) ? tag.status : 'open';
  const hardness = ['hard', 'soft'].includes(tag.hardness) ? tag.hardness : 'soft';
  return { status, hardness };
}

async function run() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('claims')
      .select('id, value')
      .like('property', 'note.%').is('invalid_at', null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const r of data) {
      const v = r.value || {};
      const cat = (v.category || '').toLowerCase();
      if (v.source !== 'signal_extraction' || !v.content) continue;
      if (cat !== 'competitor' && cat !== 'objection') continue;
      const m = v.metadata || {};
      const tagged = cat === 'competitor' ? m.stance != null : m.status != null;
      if (!tagged) rows.push({ id: r.id, value: v, category: cat });
    }
    if (data.length < PAGE) break;
  }

  const todo = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
  console.log(`Found ${rows.length} untagged competitor/objection claims; processing ${todo.length}${DRY ? ' (dry run)' : ''}.`);

  const batches = [];
  for (const category of ['competitor', 'objection']) {
    const set = todo.filter(r => r.category === category);
    for (let i = 0; i < set.length; i += BATCH) {
      const slice = set.slice(i, i + BATCH);
      batches.push({ category, items: slice.map((r, k) => ({ i: k + 1, id: r.id, value: r.value, content: String(r.value.content).slice(0, 400) })) });
    }
  }

  let done = 0, tagged = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(group.map(b => tagBatch(b.category, b.items)));
    for (const batchResult of results) {
      for (const r of batchResult) {
        const clean = cleanTag(r.category, r.tag);
        if (!clean) continue;
        if (!DRY) {
          const newValue = { ...r.value, metadata: { ...(r.value.metadata || {}), ...clean } };
          const { error } = await supabase.from('claims').update({ value: newValue }).eq('id', r.id);
          if (error) { console.warn('  [update failed]', r.id, error.message); continue; }
        }
        tagged++;
      }
    }
    done += group.reduce((s, b) => s + b.items.length, 0);
    console.log(`  ${done}/${todo.length} processed, ${tagged} tagged`);
  }
  console.log(`Done. ${tagged} claims tagged${DRY ? ' (dry — nothing written)' : ''}.`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
