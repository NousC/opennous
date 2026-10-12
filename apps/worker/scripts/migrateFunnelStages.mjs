// One-time migration: move every account onto the new funnel.
//
//   OLD                          NEW
//   identified                   identified          (unchanged)
//   aware                        identified          opens/visits are not a stage
//   connected                    connected           (unchanged)
//   interested                   interested          (unchanged)
//   evaluating                   *** depends on history — see below ***
//   proposal                     negotiation         folded in
//   negotiation                  negotiation         (unchanged)
//   client                       closed_won          renamed
//   lost                         closed_lost         renamed
//   onboarding                   closed_won          phantom stage, never real
//   disqualified                 disqualified        (unchanged)
//   churned                      churned             (unchanged)
//
// `evaluating` is the one that cannot be a straight rename. It was a catch-all
// that swallowed meetings, pricing-page visits, trial starts and sent proposals
// alike. Mapping all of it to `discovery` would invent calls that never happened
// and inflate the funnel on day one, so each account is resolved from its OWN
// history:
//
//   a meeting was HELD            -> discovery
//   a meeting is BOOKED, none held-> meeting_booked
//   neither                       -> interested
//
// SAFETY
//   Dry run by default. It prints exactly what it would do and touches nothing.
//   Pass --write to apply. Pass --workspace=<uuid> to scope to one workspace.
//
//   Every change is written the way the app writes one (see writeStage in
//   packages/core/src/db/activities.ts): the contacts view is updated AND a
//   kind='state' observation is appended, so the pipeline_stage claim re-derives
//   from the substrate and the change has a diary entry behind it. A stage that
//   appeared out of nowhere with no observation would be unexplainable later.
//
// USAGE
//   node apps/worker/scripts/migrateFunnelStages.mjs                  # dry run, all workspaces
//   node apps/worker/scripts/migrateFunnelStages.mjs --workspace=UUID # dry run, one workspace
//   node apps/worker/scripts/migrateFunnelStages.mjs --write          # apply

import { getSupabaseClient, LEGACY_STAGE_MAP, resolveLegacyEvaluating } from '@nous/core';

const WRITE = process.argv.includes('--write');
const WS_ARG = process.argv.find(a => a.startsWith('--workspace='));
const ONLY_WORKSPACE = WS_ARG ? WS_ARG.split('=')[1] : null;

const METHOD = 'funnel_migration_2026_08';

// Straight renames, taken from the canonical map so this script can never drift
// from what the app itself believes a legacy stage means. `evaluating` is pulled
// OUT: the canonical map gives it a conservative default, but here we can do
// better and resolve it per account from real history.
const DIRECT = Object.fromEntries(
  Object.entries(LEGACY_STAGE_MAP).filter(([from]) => from !== 'evaluating'),
);

const LEGACY_STAGES = [...Object.keys(DIRECT), 'evaluating'];

const MEETING_HELD_TYPES = ['interaction.meeting_held'];
const MEETING_BOOKED_TYPES = ['interaction.meeting_scheduled'];

async function main() {
  const supabase = getSupabaseClient();

  console.log(`\n=== Funnel stage migration ${WRITE ? '(WRITE)' : '(DRY RUN — nothing will change)'} ===`);
  if (ONLY_WORKSPACE) console.log(`workspace: ${ONLY_WORKSPACE}`);

  // Read straight from `claims`, not the `contacts` view. The view filters out
  // not-yet-graduated entities, so an account sitting at a legacy stage that the
  // view hides would be invisible to this migration and silently left behind.
  let q = supabase
    .from('claims')
    .select('entity_id, workspace_id, value')
    .eq('property', 'pipeline_stage')
    .is('invalid_at', null)
    .in('value', LEGACY_STAGES);
  if (ONLY_WORKSPACE) q = q.eq('workspace_id', ONLY_WORKSPACE);

  const { data: rows, error } = await q;
  if (error) throw new Error(`read failed: ${error.message}`);
  if (!rows?.length) {
    console.log('\nNothing to migrate — no account is on a legacy stage.\n');
    return;
  }

  console.log(`\nFound ${rows.length} account(s) on a legacy stage.`);

  // For the `evaluating` cohort we need each account's meeting history.
  const evaluating = rows.filter(r => r.value === 'evaluating');
  const meetingHeld = new Set();
  const meetingBooked = new Set();

  if (evaluating.length) {
    const ids = evaluating.map(r => r.entity_id);
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: obs } = await supabase
        .from('observations')
        .select('entity_id, property')
        .eq('kind', 'event')
        .in('entity_id', chunk)
        .in('property', [...MEETING_HELD_TYPES, ...MEETING_BOOKED_TYPES]);
      for (const o of obs || []) {
        if (MEETING_HELD_TYPES.includes(o.property)) meetingHeld.add(o.entity_id);
        else meetingBooked.add(o.entity_id);
      }
    }
  }

  const resolve = (row) => {
    if (row.value !== 'evaluating') return DIRECT[row.value] ?? null;
    return resolveLegacyEvaluating({
      hasMeetingHeld: meetingHeld.has(row.entity_id),
      hasMeetingBooked: meetingBooked.has(row.entity_id),
    });
  };

  const tally = {};
  const plan = [];
  for (const row of rows) {
    const next = resolve(row);
    if (!next || next === row.value) continue;
    plan.push({ ...row, next });
    const key = `${row.value} -> ${next}`;
    tally[key] = (tally[key] || 0) + 1;
  }

  console.log('\nPlanned changes:');
  for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  console.log(`  ${String(plan.length).padStart(6)}  TOTAL`);

  if (!WRITE) {
    console.log('\nDry run — nothing was changed. Re-run with --write to apply.\n');
    return;
  }

  console.log('\nApplying...');
  const ts = new Date().toISOString();
  let ok = 0;
  let failed = 0;

  for (const item of plan) {
    // Same two writes the app makes on a real transition: pin the column the UI
    // reads, and append the observation the claim re-derives from.
    const { error: upErr } = await supabase
      .from('contacts')
      .update({ pipeline_stage: item.next })
      .eq('id', item.entity_id);

    const { error: obsErr } = await supabase.from('observations').insert({
      workspace_id: item.workspace_id,
      entity_id: item.entity_id,
      kind: 'state',
      property: 'pipeline_stage',
      value: item.next,
      source: 'system',
      method: METHOD,
      observed_at: ts,
    });

    if (upErr || obsErr) {
      failed++;
      console.warn(`  FAIL ${item.entity_id}: ${upErr?.message || ''} ${obsErr?.message || ''}`.trim());
    } else {
      ok++;
    }
  }

  console.log(`\nDone. ${ok} migrated, ${failed} failed.\n`);
  if (failed) process.exitCode = 1;
}

main().catch(err => {
  console.error('\nMigration aborted:', err.message);
  process.exitCode = 1;
});
