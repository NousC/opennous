// Workspace-wide facts cleanup. For every contact in a workspace that has facts
// (or a meeting transcript), runs the three passes IN ORDER:
//   1. backfill   — purge logistics / non-durable junk
//   2. reextract  — re-mine the meeting transcript with the current prompt
//   3. dedup      — collapse near-duplicates the first two may have left
// This order matters: backfill clears noise first, reextract adds depth, dedup
// reconciles overlaps last.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to commit all three. Always run a
// dry-run first and skim the output.
//
// Options:
//   --workspace <uuid>   target workspace (default: the Nous prod workspace)
//   --limit <n>          only process the first N contacts (test on a few first)
//   --only <a,b>         restrict to phases: backfill,reextract,dedup
//   --apply              commit changes (otherwise dry-run)
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/sweepWorkspace.mjs --limit 5
//   docker compose exec -T worker node apps/worker/src/sweepWorkspace.mjs --apply

import './bootEnv.mjs';
import { getSupabaseClient } from '@nous/core';
import { backfillContact } from './backfillFacts.mjs';
import { reextractContact } from './reextractMeetings.mjs';
import { dedupContact } from './dedupFacts.mjs';

const DEFAULT_WORKSPACE = process.env.WS_ID || '00000000-0000-0000-0000-000000000000'; // pass --workspace <id>, or set WS_ID

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workspaceId = arg('--workspace', DEFAULT_WORKSPACE);
  const limit = Number(arg('--limit', 0)) || 0;
  const only = (arg('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const run = (phase) => only.length === 0 || only.includes(phase);

  const supabase = getSupabaseClient();

  // Every contact-entity that has at least one active note.* claim (a fact OR a
  // meeting doc). entity_id == contact.id in v2, so these are the contacts worth
  // sweeping — we skip the thousands of contacts with no facts at all.
  const { data: rows, error } = await supabase
    .from('claims')
    .select('entity_id')
    .eq('workspace_id', workspaceId)
    .like('property', 'note.%')
    .is('invalid_at', null);
  if (error) { console.error('failed to list fact entities:', error.message); process.exit(1); }

  let entityIds = [...new Set((rows || []).map(r => r.entity_id))];
  if (limit) entityIds = entityIds.slice(0, limit);

  // Resolve names (and confirm they're contacts).
  const { data: contacts } = await supabase
    .from('contacts').select('id, first_name, last_name').in('id', entityIds);
  const nameById = new Map((contacts || []).map(c =>
    [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.id]));
  const targets = entityIds.filter(id => nameById.has(id)); // contacts only, not company entities

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — sweeping ${targets.length} contacts in ${workspaceId}`);
  console.log(`phases: ${only.length ? only.join(' → ') : 'backfill → reextract → dedup'}\n`);

  const totals = { purged: 0, added: 0, removed: 0 };
  let n = 0;
  for (const contactId of targets) {
    const name = nameById.get(contactId);
    console.log(`\n[${++n}/${targets.length}] ${name}`);

    if (run('backfill')) {
      const { purged } = await backfillContact({ supabase, workspaceId, contactId, apply });
      totals.purged += purged;
    }
    if (run('reextract')) {
      const results = await reextractContact({ supabase, workspaceId, contactId, apply });
      const added = results.filter(r => r.action !== 'SKIP').length;
      totals.added += added;
    }
    if (run('dedup')) {
      const { removed } = await dedupContact({ supabase, workspaceId, contactId, apply });
      totals.removed += removed;
    }
  }

  const verb = apply ? '' : 'would ';
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`${apply ? 'DONE' : 'DRY-RUN COMPLETE'} — ${targets.length} contacts`);
  console.log(`  backfill:  ${verb}purge   ${totals.purged}`);
  console.log(`  reextract: ${verb}add     ${totals.added}`);
  console.log(`  dedup:     ${verb}remove  ${totals.removed}`);
  if (!apply) console.log(`\nRe-run with --apply to commit.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
