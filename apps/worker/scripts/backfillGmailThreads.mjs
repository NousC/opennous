#!/usr/bin/env node
// Read a workspace's email as threads (GET-329).
//
// SAFE BY DEFAULT: dry run. Every claim and commitment that WOULD be written is printed, one JSON
// line per thread (GMAIL_JSON …), so a run can be read before --apply writes anything.
//
// USAGE (worker container):
//   docker compose exec -T worker node apps/worker/scripts/backfillGmailThreads.mjs \
//     --workspace <uuid> [--since 2025-01-01] [--limit N] [--concurrency 2] [--apply]
//
// THE RESUME MARKER. A thread is done when CLAIMS EXIST CARRYING ITS source_ref. Not when its
// messages are ingested, not when an activity row exists, not when something was written about it.
// Three bugs in one day came from markers that were neighbours of the work rather than the work
// (GET-356/358/359) — a notes blob counted a batch of unread meetings as done, and an activity row made a
// meeting whose model calls had failed unreachable forever.
//
// Gmail has one advantage the meeting path did not: nothing here has ever been extracted, so there
// is no pre-marker corpus to accept a second proof for. The marker is correct from the first run.
//
// DO NOT RUN THIS ALONGSIDE ANOTHER HEAVY EXTRACTION. Concurrent passes each reserve their
// max_tokens, and the account holds a finite amount at any instant — that is what produced an hour
// of HTTP 402s reported as `failed 0`. Check `docker ps --filter name=fellow-` first.

import '../src/bootEnv.mjs';
import { getSupabaseClient, getInternalEntityIds } from '@nous/core';
import { createMessage, pipelineModel } from '../src/lib/llm.mjs';
import { loadEmailThreads, hydrateThreadBodies, selectEmailThreads, lastAt, threadMonth } from '../src/noema/emailThreads.mjs';
import { readGmailThread, threadSourceRef, threadId, SOURCE } from '../src/noema/gmailRead.mjs';
import { dedupFailures } from '../src/signals/index.mjs';
import { markerFailures } from '../src/noema/gmailRead.mjs';

const PAGE = 1000;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

async function pageAll(makeQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * One real completion at the largest budget this pass will reserve.
 *
 * The balance endpoint is not a check. It reported about $10 remaining for an hour while every
 * request reserving roughly 17k tokens was refused with a 402 — the limit is what the account can hold
 * at that instant, not what it has. The only honest question is whether a request like ours works.
 */
async function preflight() {
  try {
    const msg = await createMessage({
      meter: { workspaceId: null },
      feature: 'gmail-preflight', model: pipelineModel(), max_tokens: 4000,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      accept: (t) => typeof t === 'string' && t.length > 0,
    });
    const text = msg?.content?.[0]?.text ?? '';
    return { ok: Boolean(text), model: msg?.model ?? null, text: text.slice(0, 40) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}


/**
 * Which of these threads already carry a task (GET-422). One ranged read of the workspace's gmail
 * tasks — never a prefix LIKE, which cannot use the index and times out (GET-396/414) — then a set
 * lookup per thread id.
 */
async function threadsWithTasks(supabase, workspaceId, threadIds) {
  const out = new Set();
  const wanted = new Set(threadIds.filter(Boolean).map(String));
  if (!wanted.size) return out;
  const PREFIX = `action_item.${SOURCE}_`;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('claims').select('property').eq('workspace_id', workspaceId)
      .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null)
      .order('property').range(from, from + 999);
    if (error) { console.warn(`[GMAIL] could not read which threads carry tasks (${error.message}) — treating none as done`); return out; }
    for (const r of data ?? []) {
      const p = String(r.property);
      if (!p.startsWith(PREFIX)) continue;
      // action_item.gmail_<threadId>_<i> — the id is everything up to the final underscore.
      const rest = p.slice(PREFIX.length);
      const id = rest.slice(0, rest.lastIndexOf('_'));
      if (wanted.has(id)) out.add(id);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const APPLY = args.includes('--apply');
  // --commitments-only (GET-422): the OPPOSITE selection — threads already read that carry no
  // task. Their claims and insights are on the graph and fine; only the commitments read was
  // missing, or ran before tasks carried provenance (GET-400). One read each, ~$0.005.
  const COMMITMENTS_ONLY = args.includes('--commitments-only');
  const FORCE = args.includes('--force');
  const WORKSPACE = flag('workspace', process.env.WORKSPACE_ID);
  const SINCE = flag('since');
  const LIMIT = Number(flag('limit', '30'));
  const CONCURRENCY = Number(flag('concurrency', '2'));
  // Newest-first rows to walk. 0 = unbounded, which a full backfill needs and which currently
  // exceeds the statement timeout on a corpus this size — see loadEmailThreads.
  const SCAN = Number(flag('scan', '6000')) || Infinity;
  // A cohort: only threads whose LAST message falls in this month, e.g. --month 2025-10. The scan
  // is not windowed — see threadMonth — so a thread spanning the boundary is still read whole.
  const MONTH = flag('month');
  // Size every cohort from one scan, read nothing, spend nothing. Deciding how much of a corpus to
  // buy should not itself cost a model call, and running --month 13 times to find out would.
  const SIZES = args.includes('--sizes');
  if (!WORKSPACE) { console.error('--workspace <uuid> is required'); process.exit(1); }

  const supabase = getSupabaseClient();
  console.log(`[GMAIL] workspace ${WORKSPACE} — ${APPLY ? 'APPLY' : 'dry run'} — limit ${LIMIT}${MONTH ? ` — month ${MONTH}` : ''}${SINCE ? ` — since ${SINCE}` : ''}`);

  // Pass 1: the light columns only. Bodies are up to 20k each and a large workspace holds six figures of them; the
  // rules need who, when and which thread, and nothing else.
  const { threads, scanned } = await loadEmailThreads(supabase, WORKSPACE, { since: SINCE, maxMessages: SCAN });

  const people = await pageAll((a, b) => supabase.from('entities')
    .select('id').eq('workspace_id', WORKSPACE).eq('type', 'person').eq('status', 'active')
    .order('id').range(a, b));
  // ONE query, not one per person. isEntityInternal asks the database about a single entity, and
  // a large workspace has tens of thousands of active people — that many sequential round trips before the first thread
  // is read, which is most of the wall-clock of a 30-thread run and all of it wasted.
  // getInternalEntityIds answers the same question for the whole workspace in one go.
  const internal = await getInternalEntityIds(supabase, WORKSPACE).catch(() => new Set());
  const externalIds = new Set(people.map(p => p.id).filter(id => !internal.has(id)));

  // THE MARKER: which threads have been READ. Not which produced claims — a thread can be read
  // honestly and yield nothing, and about a third of the first hundred did.
  const marks = await pageAll((a, b) => supabase.from('observations')
    .select('value').eq('workspace_id', WORKSPACE).eq('property', 'noema.read').eq('source', SOURCE)
    .order('id').range(a, b));
  const doneRefs = new Set(marks.map(m => m.value?.source_ref).filter(Boolean));

  // SECOND PROOF, for the threads read before the marker existed (§12). Claims carrying a gmail
  // source_ref prove a read just as well, and without this those would be bought a second time —
  // which is the mistake this whole change is about, made once more in the opposite direction.
  const claimed = await pageAll((a, b) => supabase.from('claims')
    // A RANGE, never a prefix LIKE on `property`: the LIKE cannot use claims_ws_property_live and
    // reads every claim in the workspace per page (hundreds of thousands on a large one) — a statement timeout, and a
    // timed-out marker reports every thread unread and re-buys the month (GET-396, GET-414). The
    // Fellow runner carried the identical line; this is the same fix on the other runner.
    .select('value').eq('workspace_id', WORKSPACE)
    .gte('property', 'note.').lt('property', 'note/').is('invalid_at', null)
    .like('value->metadata->>source_ref', `source://${SOURCE}/%`).order('id').range(a, b));
  for (const c of claimed) {
    const ref = c.value?.metadata?.source_ref;
    if (ref) doneRefs.add(ref);
  }

  const pass1 = selectEmailThreads({ threads, externalIds });
  let candidates = pass1.units.filter(u => (COMMITMENTS_ONLY ? doneRefs.has(threadSourceRef(u)) : !doneRefs.has(threadSourceRef(u))));
  if (COMMITMENTS_ONLY) {
    const withTasks = await threadsWithTasks(supabase, WORKSPACE, candidates.map(u => threadId(u)));
    const before = candidates.length;
    // --force re-reads EVERY read thread, not only the ones with no task. That is what a change to
    // the task rules needs: after GET-423/424/425 a thread can hold tasks that are real but stale —
    // written before the rules, or written as the customer's and now owed as our chase. Selecting
    // only taskless threads would leave those behind for good. Same flag, same meaning, as the
    // Fellow runner's.
    if (!FORCE) candidates = candidates.filter(u => !withTasks.has(threadId(u)));
    console.log(`[GMAIL] commitments only: ${before} read · ${withTasks.size} already carry tasks · ${candidates.length} to read${FORCE ? ' (FORCE: every read thread)' : ''}`);
  }
  if (SIZES) {
    const by = new Map();
    for (const u of candidates) {
      const m = threadMonth(u) ?? 'undated';
      const c = by.get(m) ?? { threads: 0, msgs: 0 };
      c.threads++; c.msgs += u.messages.length;
      by.set(m, c);
    }
    console.log(`[GMAIL] unread cohorts (${candidates.length} threads total):`);
    for (const m of [...by.keys()].sort().reverse()) {
      const c = by.get(m);
      console.log(`[GMAIL]   ${m}  ${String(c.threads).padStart(5)} threads  ${String(c.msgs).padStart(6)} messages`);
    }
    return;
  }
  if (MONTH) {
    const before = candidates.length;
    candidates = candidates.filter(u => threadMonth(u) === MONTH);
    console.log(`[GMAIL] cohort ${MONTH}: ${candidates.length} of ${before} unread thread(s)`);
  }

  console.log(`[GMAIL] ${scanned} messages scanned (cap ${SCAN}) · ${threads.size} threads · ${externalIds.size} external of ${people.length} people (${internal.size} internal) · ${doneRefs.size} already read (${marks.length} marked, rest by claim)`);
  console.log(`[GMAIL] skipped: ${Object.entries(pass1.skipped).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none'}`);

  // Pass 2: bodies, for the survivors only — then the same rules again, because the one rule that
  // needs a body could not be judged without one.
  const batch = candidates.slice(0, LIMIT);
  if (!batch.length) { console.log('[GMAIL] nothing to read'); return; }
  await hydrateThreadBodies(supabase, WORKSPACE, batch);
  const pass2 = selectEmailThreads({ threads: new Map(batch.map(u => [u.key, u])), externalIds });
  const units = pass2.units;
  console.log(`[GMAIL] after bodies: ${units.length} thread(s) to read` +
    `${Object.keys(pass2.skipped).length ? ` · dropped: ${Object.entries(pass2.skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}` : ''}`);
  if (!units.length) return;

  // BEFORE ANY MODEL CALL, apply or not. A dry run writes nothing but still PAYS for every read —
  // it is the writes that are suppressed, not the reads. Gating this on --apply would have sent
  // the sample into the same wall the check exists for.
  const pf = await preflight();
  if (!pf.ok) { console.error('[GMAIL] preflight FAILED — not starting:', pf.error ?? 'empty response'); process.exit(1); }
  console.log(`[GMAIL] preflight ok on ${pf.model}`);

  let read = 0, facts = 0, tasks = 0, insights = 0, failed = 0;
  const queue = [...units];
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      try {
        const r = await readGmailThread({ supabase, workspaceId: WORKSPACE, thread: u, dryRun: !APPLY, commitmentsOnly: COMMITMENTS_ONLY });
        read++; facts += r.facts.length; tasks += r.commitments.length; insights += r.insights ?? 0;
        console.log(`GMAIL_JSON ${JSON.stringify({
          source_ref: r.sourceRef, treatment: r.treatment, last_at: lastAt(u), filed_on: r.filedOn ?? null,
          messages: u.messages.length, chars: u.chars, contacts: u.externalIds.length,
          grounded: `${r.grounded ?? 0}/${r.offered ?? 0}`, insights: r.insights ?? 0,
          // A dry-run fact has no `.value` — persistFacts returns the raw fact before it is shaped — so
          // every field needs the same fallback. category had none, so it logged null for every fact
          // in the first sample and read as "the extractor assigns no categories". The extractor was
          // fine; the report was wrong, which is the failure this whole tool exists to catch.
          facts: r.facts.map(f => ({
            category: f?.value?.category ?? f?.category ?? null,
            label:    f?.value?.label ?? f?.label ?? null,
            about:    f?.value?.about ?? f?.about ?? null,
            content:  f?.value?.content ?? f?.content ?? null,
            quote:    f?.value?.quote ?? f?.quote ?? null,
          })),
          commitments: r.commitments.map(c => ({ title: c.title, owner: c.owner_kind, due: c.due_at, quote: c.quote })),
          skipped: r.skipped ?? null,
        })}`);
      } catch (err) {
        failed++;
        console.error(`[GMAIL] thread ${u.key} failed:`, err?.message || err);
      }
    }
  }));

  // Counted, not narrated. A summary line is not evidence — query the rows.
  console.log(`[GMAIL] ${read}/${units.length} read · ${facts} claim(s) · ${tasks} commitment(s) · ${insights} insight(s) · ${failed} failed · ${APPLY ? 'APPLIED' : 'DRY RUN — nothing written'}`);
  // Said out loud rather than left in the noise: a dedup pass that could not run means duplicates
  // were added with no check, and the claim count above does not distinguish them.
  if (dedupFailures) console.warn(`[GMAIL] ⚠ ${dedupFailures} fact(s) were added WITHOUT a duplicate check — the dedup search failed`);
  // A thread read but not marked will be bought again. Said out loud, because it lives in a catch.
  if (markerFailures) console.warn(`[GMAIL] ⚠ ${markerFailures} thread(s) were read but NOT marked — they will be re-read and re-paid for`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error('[GMAIL] fatal:', err); process.exit(1); });
