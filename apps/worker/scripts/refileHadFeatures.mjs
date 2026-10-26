// One-off (GET-1031): the feature requests already on file that ask for something we have. Each one
// is re-checked against what we sell, and refiled as setup (help them use it). The Feature requested
// events already sent stay: they are history.
//
//   node apps/worker/scripts/refileHadFeatures.mjs --workspace=UUID [--write]
//
// Dry run by default: prints what it would refile and what covers it. Needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY, and the model keys the worker uses.
import { getSupabaseClient } from '@nous/core';
import { alreadyHave, catalogueFor } from '../src/signals/alreadyHave.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WS = arg('workspace');
const WRITE = argv.includes('--write');
const BATCH = 40;
if (!WS) { console.error('usage: refileHadFeatures --workspace=UUID [--write]'); process.exit(1); }
const supabase = getSupabaseClient();

const catalogue = await catalogueFor(supabase, WS);
if (!catalogue) { console.error('no "What we sell" on file (ICP or Positioning): nothing to check against'); process.exit(1); }
const { data: rows, error } = await supabase.from('about_us_claims').select('id, what, content, use_case')
  .eq('workspace_id', WS).eq('kind', 'feature').is('retired_at', null).order('created_at').limit(2000);
if (error) throw error;
console.log(`[ALREADY_HAVE] ${rows.length} open feature request(s) · ${WRITE ? 'WRITE' : 'dry run'}`);

const refile = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const have = await alreadyHave(supabase, WS, batch, { catalogue });
  for (const [k, covers] of have) {
    refile.push(batch[k].id);
    console.log(`  setup · ${batch[k].what ?? '—'} · ${String(batch[k].content).slice(0, 90)}${covers ? `  [we have: ${covers}]` : ''}`);
  }
}
const kept = rows.filter(r => !refile.includes(r.id));
console.log(`[ALREADY_HAVE] ${refile.length} to refile as setup, ${kept.length} stay feature requests:`);
for (const r of kept) console.log(`  feature · ${r.what ?? '—'}`);
if (WRITE && refile.length) {
  const { error: upErr } = await supabase.from('about_us_claims').update({ kind: 'setup' }).in('id', refile);
  if (upErr) throw upErr;
  console.log(`[ALREADY_HAVE] refiled ${refile.length}`);
}
