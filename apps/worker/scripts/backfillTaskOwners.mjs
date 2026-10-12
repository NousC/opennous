#!/usr/bin/env node
// Give the tasks we already have an owner (GET-383).
//
// `taskAssignee.ts` resolves a seat from an address on read, so onboarding someone hands them
// their history. #283 makes the extractor record that address going forward. Nothing gives it to
// the hundreds of email tasks already in the graph, and re-reading those threads to get it would cost
// real money for a fact no model needs to be asked about.
//
// WHERE THE ADDRESS COMES FROM. Not `owner_user_id` — that is null on every observation in this
// workspace (none of a few hundred sampled), because the mail arrived through the HubSpot import
// and HubSpot has no notion of our seats. It comes from the thread itself: the one address on
// OUR side that wrote in it.
//
//     halden@harborline.example            ← ours
//     ken.halloran@stonebridgerv.example  ← theirs
//
// That is the same natural key taskAssignee stores, so the backfill and the extractor agree by
// construction rather than by coincidence.
//
// WHAT IT REFUSES TO GUESS:
//   · a thread with NO our-side sender — nothing to attribute
//   · a thread with MORE THAN ONE — a handoff or a group thread. Picking the loudest would put a
//     nag on a rep for someone else's promise, which is worse than leaving it unowned. The task
//     list already says "unassigned" honestly.
//   · `owner_kind: 'prospect'` — a customer's promise must NEVER name one of our people. This is
//     the property `taskAssignee.test.mjs` exists to protect, and it is re-checked here rather
//     than assumed, because this script writes and that one only reads.
//
// USAGE — `docker compose run`, so the worker service's env is present:
//
//   docker compose run --rm --no-deps -e WS_ID=<uuid> worker \
//     node apps/worker/scripts/backfillTaskOwners.mjs              # dry run: prints every write
//   … --apply          # write them
//   … --limit 5        # a handful first, always
//
// Makes NO model calls. It can run alongside an extraction pass without touching its budget.

import { getSupabaseClient, loadOwnDomains, isOwnEmail, recordObservation } from '@nous/core';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i === -1 ? d : (process.argv[i + 1] ?? d); };
const LIMIT = Number(arg('--limit', '0')) || Infinity;

// A prefix LIKE cannot use claims_ws_property_live and degrades to a scan of every claim in the
// table — roughly ten times slower than the range (GET-396). '/' is the byte
// after '.', so this matches the `action_item.` prefix exactly and nothing else.
const LO = 'action_item.', HI = 'action_item/';
const PAGE = 1000;

// Built inside main, not at import time, so the pure rules below can be exercised by a test
// without a workspace or a database connection.
let supabase = null;

/** Every live action-item claim, paged. */
async function allTasks() {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('claims')
      .select('entity_id, property, value')
      .eq('workspace_id', WS)
      .gte('property', LO).lt('property', HI)
      .is('invalid_at', null)
      .order('entity_id').order('property')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * The one address on our side of a thread, or null.
 *
 * One query per THREAD, not per task — tasks share threads at roughly two to one, and the per-task form
 * is the N+1 that times out (measured).
 */
async function ourSenderIn(threadId, ownDomains) {
  const { data, error } = await supabase
    .from('observations')
    .select('from:raw->>from')
    .eq('workspace_id', WS)
    .eq('raw->>thread_id', threadId)
    .limit(200);
  if (error) return { email: null, why: `lookup failed: ${error.message}` };
  return pickOurSender((data ?? []).map(r => r.from), (e) => isOwnEmail(e, ownDomains));
}

/**
 * The single address on our side of a thread — or a stated reason there isn't one.
 *
 * Pure, and separated out because these are the judgements that decide whether a real person gets
 * blamed for a promise. `mine` is injected rather than imported so the rule can be exercised
 * without a workspace.
 */
export function pickOurSender(froms, mine) {
  const ours = new Set();
  for (const raw of froms ?? []) {
    const addr = String(raw ?? '').trim().toLowerCase();
    // Headers arrive as "Halden Brisk <halden@harborline.example>" as often as bare.
    const bare = (/<([^>]+)>/.exec(addr)?.[1] ?? addr).trim();
    if (bare.includes('@') && mine(bare)) ours.add(bare);
  }
  if (ours.size === 1) return { email: [...ours][0], why: null };
  if (ours.size === 0) return { email: null, why: 'no our-side sender in the thread' };
  // A handoff or a group thread. Picking the loudest would nag a rep for someone else's promise.
  return { email: null, why: `${ours.size} our-side senders — refusing to pick` };
}

async function main() {
  if (!WS) { console.error('WS_ID is required'); process.exit(1); }
  supabase = getSupabaseClient();
  const ownDomains = await loadOwnDomains(supabase, WS);
  console.log(`[TASK_OWNERS] own domains: ${[...ownDomains].join(', ') || '(none)'}`);
  if (!ownDomains || (ownDomains.size ?? ownDomains.length) === 0) {
    console.error('[TASK_OWNERS] no own domains — refusing to guess which side is ours');
    process.exit(1);
  }

  const tasks = await allTasks();
  const email = tasks.filter(t => (t.value?.source_type) === 'email');
  const need = email.filter(t => t.value?.owner_kind === 'user' && !t.value?.owner_email && t.value?.source_id);
  const theirs = email.filter(t => t.value?.owner_kind === 'prospect').length;

  console.log(`[TASK_OWNERS] ${tasks.length} tasks · ${email.length} from email · ${theirs} owed by them (never ours to name) · ${need.length} need an owner`);

  const byThread = new Map();
  for (const t of need) {
    const k = String(t.value.source_id);
    (byThread.get(k) ?? byThread.set(k, []).get(k)).push(t);
  }
  console.log(`[TASK_OWNERS] ${byThread.size} distinct thread(s) to resolve`);

  let resolved = 0, wrote = 0, failed = 0;
  const skipped = new Map();
  let n = 0;

  for (const [threadId, group] of byThread) {
    if (n++ >= LIMIT) break;
    const { email: owner, why } = await ourSenderIn(threadId, ownDomains);
    if (!owner) {
      skipped.set(why, (skipped.get(why) ?? 0) + group.length);
      continue;
    }
    resolved += group.length;
    for (const t of group) {
      // Re-checked, not assumed: this script writes.
      if (t.value.owner_kind === 'prospect') continue;
      const value = { ...t.value, owner_email: owner, owner_name: t.value.owner_name ?? null };
      console.log(`[TASK_OWNERS] ${APPLY ? 'WRITE' : 'would write'} ${owner} → ${t.property} · ${String(t.value.title ?? '').slice(0, 70)}`);
      if (!APPLY) continue;
      try {
        // Same entity, same property: the claim is unique on (workspace, entity, property), so
        // this lands on the row that already exists rather than making a second one. observed_at
        // keeps the ORIGINAL recording time — this is a repair, not a new observation of the
        // task, and moving the date would make every backfilled task look freshly promised.
        await recordObservation(supabase, {
          workspaceId: WS,
          entityId: t.entity_id,
          kind: 'state',
          property: t.property,
          value,
          source: 'gmail',
          method: 'extraction',
          observedAt: t.value.recorded_at ?? undefined,
        });
        wrote++;
      } catch (e) {
        failed++;
        console.error(`[TASK_OWNERS] FAILED ${t.property}: ${e.message}`);
      }
    }
  }

  console.log(`[TASK_OWNERS] resolvable: ${resolved} · written: ${wrote} · failed: ${failed}`);
  for (const [why, count] of [...skipped].sort((a, b) => b[1] - a[1])) {
    console.log(`[TASK_OWNERS] left unowned — ${why}: ${count} task(s)`);
  }
  if (!APPLY) console.log('[TASK_OWNERS] dry run — nothing written. Re-run with --apply.');
}

// Only when run, never on import — the test imports this file for the pure rules above.
if (process.argv[1] && process.argv[1].endsWith('backfillTaskOwners.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
