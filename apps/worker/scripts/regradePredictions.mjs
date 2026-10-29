// One-time re-grade of resolved ICP predictions (GET-1068, DECISIONS 2026-10-29).
//
// The old resolver graded an account by its CURRENT stage, so accounts that were
// already customers when we scored them counted as wins, and deal outcomes (on
// companies and deals) never reached the people who were scored. This re-applies
// the fixed rule (decideDisposition) to every resolved icp_fit prediction:
//
//   closed_won when scored                 -> already_decided (not learned from)
//   a deal won/lost after scoring          -> won / lost, the first one decides
//   stage only, deal closed before scoring -> already_decided
//
// Each changed row keeps outcome_value.regraded { from, at, issue }. Imported
// closed deals (record_closed_deals) are left alone.
//
// SAFETY
//   Dry run by default. It prints the transitions it would make and touches nothing.
//   Pass --write to apply. Pass --workspace=<uuid> to scope to one workspace.
//
//   node apps/worker/scripts/regradePredictions.mjs [--workspace=<uuid>] [--write]

import { getSupabaseClient, regradeResolvedPredictions } from '@nous/core';

const WRITE = process.argv.includes('--write');
const WS_ARG = process.argv.find(a => a.startsWith('--workspace='));
const ONLY_WORKSPACE = WS_ARG ? WS_ARG.split('=')[1] : undefined;

async function main() {
  const supabase = getSupabaseClient();
  console.log(`\n=== ICP prediction re-grade ${WRITE ? '(WRITE)' : '(DRY RUN — nothing will change)'} ===`);
  if (ONLY_WORKSPACE) console.log(`workspace: ${ONLY_WORKSPACE}`);

  const totals = { scanned: 0, changed: 0, transitions: {} };
  let afterId = null;
  for (;;) {
    const r = await regradeResolvedPredictions(supabase, { workspaceId: ONLY_WORKSPACE, write: WRITE, batch: 200, afterId });
    totals.scanned += r.scanned;
    totals.changed += r.changed;
    for (const [k, n] of Object.entries(r.transitions)) totals.transitions[k] = (totals.transitions[k] ?? 0) + n;
    if (!r.lastId || r.scanned < 200) break;
    afterId = r.lastId;
    process.stdout.write(`  …${totals.scanned} scanned, ${totals.changed} to change\r`);
  }

  console.log(`\nscanned ${totals.scanned}, ${WRITE ? 'changed' : 'would change'} ${totals.changed}`);
  for (const [k, n] of Object.entries(totals.transitions).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${n}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
