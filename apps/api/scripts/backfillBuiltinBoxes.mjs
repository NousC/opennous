// One-off backfill (GET-897): put every built-in job of every Workspace-plan workspace in a RevBox,
// the same default boxes the RevBox list ensures on read (core planDefaultBuiltinBoxes /
// ensureDefaultBuiltinBoxes): "Meetings Follow-up" (sales_follow_up), "Pipeline Health"
// (stale_deal, deal_risk, deal_signals), "Customer Growth" (expansion). A box with the default name
// gains the built-in; a built-in already in any box is never moved; nothing is ever duplicated.
//
// Dry run by default: prints, per Workspace-plan workspace, what it would create or add. --apply
// writes. Workspaces on any other plan are listed as skipped.
//
//   Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   Run:   node apps/api/scripts/backfillBuiltinBoxes.mjs [--workspace=<uuid>] [--apply]
//
// Output: one block per workspace, then a JSON summary line:
//   ws 1a2b3c4d-…  plan custom  owner 5e6f…
//     create  "Meetings Follow-up"   sales_follow_up
//     add     "Pipeline Health" (box 9a8b…)  deal_risk, deal_signals
//     (nothing to do)
//   {"mode":"dry-run","workspaces":3,"skipped_other_plan":12,"to_create":4,"to_add":1,"created":0,"added":0}

import { getSupabaseClient, ensureDefaultBuiltinBoxes, workspaceDefaultOwner } from '@nous/core';
import { getPlanFromSubscription, planTier } from '../src/lib/plans.mjs';

const argv = process.argv.slice(2);
const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const APPLY = argv.includes('--apply');
const ONLY = arg('workspace');

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');

const sb = getSupabaseClient();
// Every row, a page at a time (PostgREST caps a read at 1,000 rows).
async function readAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) die(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

let workspaces = await readAll(() => sb.from('workspaces').select('id, team_id').order('id'));
if (ONLY) workspaces = workspaces.filter((w) => w.id === ONLY);
const subs = await readAll(() => sb.from('subscriptions').select('*').order('team_id'));
const planOfTeam = new Map(subs.map((s) => [s.team_id, getPlanFromSubscription(s).id]));

const summary = { mode: APPLY ? 'apply' : 'dry-run', workspaces: 0, skipped_other_plan: 0, to_create: 0, to_add: 0, created: 0, added: 0, errors: 0 };
for (const w of workspaces) {
  const plan = planOfTeam.get(w.team_id) ?? 'api';
  if (planTier(plan) !== 'custom') { summary.skipped_other_plan += 1; continue; }
  summary.workspaces += 1;
  try {
    const owner = await workspaceDefaultOwner(sb, w.id);
    console.log(`ws ${w.id}  plan ${plan}  owner ${owner ? owner.slice(0, 8) + '…' : '(no members: nothing can be created)'}`);
    const out = await ensureDefaultBuiltinBoxes(sb, w.id, { ownerId: owner, dryRun: !APPLY });
    if (!out.planned.length) console.log('  (nothing to do)');
    for (const step of out.planned) {
      if (step.add) { summary.to_add += 1; console.log(`  add     "${step.name}" (box ${step.add.slice(0, 8)}…)  ${step.keys.join(', ')}`); }
      else { summary.to_create += 1; console.log(`  create  "${step.create}"  ${step.keys.join(', ')}`); }
    }
    summary.created += out.created.length; summary.added += out.added.length;
    if (APPLY && out.planned.length) console.log(`  applied: ${out.created.length} created, ${out.added.length} added`);
  } catch (e) {
    summary.errors += 1;
    console.log(`  error: ${e?.message ?? e}`);
  }
}
console.log(JSON.stringify(summary));
