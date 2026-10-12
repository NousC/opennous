#!/usr/bin/env node
// Build the close records by hand (GET-405): the backfill over every closed deal, or a rebuild.
// The daily worker pass (apps/worker/src/workers/closeRecords.mjs) does the same thing for deals
// closed since; this is for the first run and for repairing after a taxonomy change.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/closeRecords.mjs                # dry run: counts + a sample of paths
//   WS_ID=<uuid> node apps/worker/scripts/closeRecords.mjs --apply
//   ... --force            rebuild deals that already have a record
//   ... --limit 200

import { getSupabaseClient } from '@nous/core';
import { lockScript } from '../src/lib/backfillLock.mjs';
import { buildCloseRecordsForWorkspace } from '../src/workers/closeRecords.mjs';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('limit', 0)) || 100000;
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const sample = [];
const paths = new Map();
const supabase = getSupabaseClient();
const lock = await lockScript(supabase, WS, 'closeRecords', { leaseMinutes: 120 });
const c = await buildCloseRecordsForWorkspace(supabase, WS, {
  force: FORCE, dryRun: !APPLY, limit: LIMIT,
  log: (o, r) => {
    if (r.outcome !== 'won') { const k = r.path.join(' → ') || '(unexplained)'; paths.set(k, (paths.get(k) ?? 0) + 1); }
    if (sample.length < 6 && r.events.length >= 3) sample.push({ o, r });
  },
});
console.log(`${c.closed} closed deals · ${c.todo} ${FORCE ? 'rebuilt' : 'without a record'} · ${c.explained} explained, ${c.unexplained} unexplained`
  + (APPLY ? ` · written ${c.written}, failed ${c.failed}` : ' · dry run, nothing written'));

if (paths.size) {
  console.log('\nmost common paths on lost / no-decision deals:');
  for (const [k, n] of [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${k}`);
}
for (const { o, r } of sample) {
  console.log(`\n── ${o.deal_id} · ${r.outcome} ${r.closed_at.slice(0, 10)}${r.rep_reason ? ` · rep said: ${r.rep_reason}` : ''}`);
  for (const e of r.events) console.log(`   ${e.at.slice(0, 10)}  ${e.kind.padEnd(20)} ${e.text.slice(0, 90)}${e.attribution === 'deal' ? '  [filed to deal]' : ''}`);
}
if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');
await lock.release();
