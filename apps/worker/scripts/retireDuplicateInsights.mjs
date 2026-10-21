// One-time (Phase 0.7): retire stored insights that repeat an older one from the same source.
//
// Before GET-961 and GET-974 an email thread was re-read on every new reply and each read could
// file the same point again in new words, so one fact from one source counted as many mentions.
// New insights are checked now (newInsights); this runs the same rule over what is already filed
// (storedRepeats). A repeat gets status 'duplicate', which every read hides; nothing is deleted, and
// setting the status back undoes it. The same point from different accounts is not touched.
//
//   node apps/worker/scripts/retireDuplicateInsights.mjs [--write] [--workspace=UUID] [--out=FILE]
//
// Dry run by default: prints the count and writes the groups to --out (default /tmp). Needs
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and OPENAI_API_KEY (embeddings).
import { writeFileSync } from 'node:fs';
import { getSupabaseClient, embedBatch, HIDDEN_INSIGHT_STATUSES } from '@nous/core';
import { storedRepeats } from '../src/signals/insights.mjs';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const WORKSPACE = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
const OUT = (argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || '/tmp/insight-duplicates.json';
const supabase = getSupabaseClient();

const rows = [];
for (let from = 0; ; from += 1000) {
  let q = supabase.from('insight_items')
    .select('id, workspace_id, source, category, statement, source_ref, company_id, status, created_at')
    .not('status', 'in', `(${HIDDEN_INSIGHT_STATUSES.join(',')})`).order('id').range(from, from + 999);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data, error } = await q;
  if (error) throw error;
  rows.push(...data);
  if (data.length < 1000) break;
}

// Only rows that share a group with another need a vector.
const key = (r) => (r.source_ref ? `ref:${r.source_ref}` : r.company_id ? `acct:${r.company_id}` : null);
const sizes = new Map();
for (const r of rows) if (key(r)) { const k = `${r.workspace_id}|${r.source}|${r.category}|${key(r)}`; sizes.set(k, (sizes.get(k) || 0) + 1); }
const need = rows.filter(r => key(r) && sizes.get(`${r.workspace_id}|${r.source}|${r.category}|${key(r)}`) > 1);
const vecs = new Map();
for (let i = 0; i < need.length; i += 200) {
  const batch = need.slice(i, i + 200);
  const v = await embedBatch(batch.map(r => r.statement));
  if (!v) throw new Error('embeddings unavailable: nothing retired');
  batch.forEach((r, j) => vecs.set(r.id, v[j]));
}

const groups = storedRepeats(rows, (id) => vecs.get(id));
const repeats = groups.flatMap(g => g.repeats.map(r => ({ id: r.id, workspace_id: r.workspace_id, was: r.status, duplicate_of: g.keep.id })));
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), groups: groups.map(g => ({ keep: g.keep, repeats: g.repeats })), repeats }, null, 1));
console.log(`[RETIRE_DUPLICATE_INSIGHTS] ${rows.length} insights · ${groups.length} groups · ${repeats.length} repeats${WRITE ? '' : ' (dry run)'} · list in ${OUT}`);

if (WRITE) {
  let done = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < repeats.length; i += 100) {
    const ids = repeats.slice(i, i + 100).map(r => r.id);
    // Only rows still as the dry run saw them: a status a person set since then is theirs.
    const { data, error } = await supabase.from('insight_items')
      .update({ status: 'duplicate', status_changed_at: now, updated_at: now })
      .in('id', ids).not('status', 'in', `(${HIDDEN_INSIGHT_STATUSES.join(',')})`).select('id');
    if (error) throw error;
    done += data?.length ?? 0;
  }
  console.log(`[RETIRE_DUPLICATE_INSIGHTS] retired ${done}. Undo: set status back from the 'was' field in ${OUT}.`);
}
