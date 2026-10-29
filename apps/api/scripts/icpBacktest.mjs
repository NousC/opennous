// Backtest the ICP score on closed deals (GET-1074). Read-only unless --save.
//
// Scores every won/lost deal in deal_outcomes the way the live scorer would score its
// account today (best-fitting contact, ICP rules only) and prints how well the score
// separates winners, raw and with contact coverage controlled. The worker runs the same
// thing nightly (apps/worker/src/cloud/workers/icpBacktest.mjs); --save stores this run
// for the ICP page now instead of waiting for it. See packages/core/src/cloud/icpBacktest.ts.
//
//   node apps/api/scripts/icpBacktest.mjs [--workspace=<uuid>] [--save] [--json]

import { getSupabaseClient } from '@nous/core';
import { runIcpBacktest, saveIcpBacktest, workspacesToBacktest } from '@nous/core/cloud';

const argv = process.argv.slice(2);
const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const ONLY = arg('workspace');
const SAVE = argv.includes('--save');
const JSON_OUT = argv.includes('--json');

const supabase = getSupabaseClient();
const pct = (r) => (r == null ? '–' : `${Math.round(r * 1000) / 10}%`);

async function main() {
  const workspaces = ONLY ? [ONLY] : await workspacesToBacktest(supabase);
  const runs = [];
  for (const ws of workspaces) {
    const run = await runIcpBacktest(supabase, ws);
    if (!run) continue;
    if (SAVE) await saveIcpBacktest(supabase, run);
    runs.push(run);
  }
  if (JSON_OUT) { console.log(JSON.stringify(runs, null, 2)); return; }

  console.log(`\n=== ICP backtest on closed deals (${SAVE ? 'saved' : 'read-only'}) ===`);
  for (const { workspace_id, result: r } of runs) {
    const c = r.coverage, a = r.accuracy;
    console.log(`\nworkspace ${workspace_id}`);
    console.log(`  scored ${c.won.scored}/${c.won.total} won, ${c.lost.scored}/${c.lost.total} lost`);
    for (const t of r.tiers) console.log(`  ${t.label.padEnd(8)} ${String(t.won).padStart(5)} won ${String(t.lost).padStart(5)} lost  ${pct(t.rate)}`);
    console.log(`  fit ${pct(a.fit_rate)} vs rest ${pct(a.rest_rate)}: raw ${a.raw_ratio ?? '–'}x, controlled ${a.controlled_ratio ?? '–'}x → ${a.label}`);
    console.log(`  median contacts: won ${a.median_contacts.won ?? '–'}, lost ${a.median_contacts.lost ?? '–'}`);
    console.log('  criteria (fired won/lost, raw lift, controlled lift, impact):');
    for (const s of r.rules) console.log(`    ${s.weight > 0 ? '+' : ''}${s.weight}  ${s.key.padEnd(40)} ${s.fired_won}/${s.fired_lost}  ${s.lift ?? '–'}x  ${s.controlled_lift ?? '–'}x  ${s.impact}`);
    for (const d of r.disqualifiers) console.log(`    disqualifier ${d.key}: ${d.capped} capped, ${d.won} won → ${d.status}`);
    for (const x of r.recommendations) console.log(`  → ${x.text} (${x.meta})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
