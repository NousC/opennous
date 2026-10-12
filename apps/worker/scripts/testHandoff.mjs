// Write ONE handoff, for ONE account, and print it. No automation, no cron, no delivery —
// the point is to read what the writer produces before it is allowed to produce anything at
// scale. The last version of this shipped straight to a workspace and wrote hundreds of documents.
//
//   node apps/worker/scripts/testHandoff.mjs --ws <id> --account <entity-id> [--apply]
import { getSupabaseClient, makeArtifactForTest, citeKey } from '@nous/core';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const WS = arg('--ws');
const ACCOUNT = arg('--account');
const APPLY = process.argv.includes('--apply');
if (!WS || !ACCOUNT) { console.error('usage: --ws <id> --account <entity-id> [--apply]'); process.exit(2); }

const supabase = getSupabaseClient();
const doc = await makeArtifactForTest(supabase, WS, {
  artifact: 'account_summary', entityId: ACCOUNT, stage: 'closed_won', prompt: null, dryRun: !APPLY,
});
console.log(`\nTITLE     ${doc.title}`);
console.log(`HEADLINE  ${doc.headline}\n`);
for (const s of doc.sections ?? []) {
  console.log(`── ${s.label} ──`);
  if (Array.isArray(s.blocks)) console.log(JSON.stringify(s.blocks, null, 1));
  else console.log(s.body);
  console.log();
}
// Markers are cite tokens ("[c3f9x]"), not numbers; each must name a source we filed.
const known = new Set((doc.sources ?? []).map(s => citeKey(s.ref)));
const marks = [...new Set([...(doc.sections ?? []).map(s => s.body ?? '').join('\n').matchAll(/\[(c[0-9a-z]{4})\]/g)].map(m => m[1]))];
console.log(`SOURCES   ${(doc.sources ?? []).length} · distinct markers used ${marks.length}`);
const dangling = marks.filter(t => !known.has(t));
console.log(dangling.length ? `DANGLING  ${dangling.join(', ')}` : 'DANGLING  none');
for (const s of (doc.sources ?? []).slice(0, 3)) console.log(`  [${citeKey(s.ref)}] ${s.system} · ${String(s.quote ?? s.detail ?? '').slice(0, 70)}`);
console.log(APPLY ? `filed as ${doc.id}` : '(dry run — nothing written)');
