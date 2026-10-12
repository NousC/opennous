#!/usr/bin/env node
// Import a workspace's Fellow meeting history (GET-286).
//
// Connecting Fellow deliberately imports nothing (GET-229): it goes live from that moment, so a
// client who connects today has a year of calls we cannot see. This is the one way to go back and
// get them, run once, deliberately, with the bill stated first.
//
// WHY A SCRIPT AND NOT THE POLLER: the poller exists to catch up a few minutes of missed calls for
// connections with no webhook. Pointing it at a year would ignore the scope rule below, spend model
// credits on every meeting with nobody watching, and fire a year of after-call automations.
//
// THE SCOPE RULE (product decision, 2026-09-16): file a meeting when its attendees name a company we already
// hold. A KNOWN company with an unknown person CREATES that person — that is how a buying committee
// gets completed. An entirely UNKNOWN company is skipped: a backfill must not invent the account
// list, which is the CRM's job. --include-unknown lifts that (GET-788): every external meeting is
// filed, and its people are created and shown as "Not in CRM" for someone to review or push.
//
// ORDER: oldest → newest, always. A person met in March must exist before the June call that
// mentions them, or the June call mints a second record of the same human.
//
// IDEMPOTENT: every meeting_held carries `fellow_<noteId>_<contactId>`, so a re-run resumes. Stop it
// and start it again as often as you like; nothing files twice.
//
// USAGE — always `docker compose run`, never `docker run --env-file .env`. The model config
// (EXTRACTION_MODEL, OPENROUTER_API_KEY) is supplied to the worker SERVICE by compose and is not in
// .env; a standalone container silently falls back to Claude and bills an empty Anthropic account.
// assertModelConfig below refuses to start rather than let that happen again.
//
//   docker compose run --rm --no-deps -e WS_ID=<uuid> worker \
//     node apps/worker/scripts/fellowBackfill.mjs --dry-run          # count + price
//   … --include-unknown                                              # also companies not in the CRM
//   … --limit 20                                                     # pilot
//   … --file-only                                                    # no model calls
//   … --commitments-only [--window A-B] [--force]                    # tasks for meetings already read
//   … --coach                                                        # grade the reps too (off by default)
//   … --all-live                                                     # artifacts for old calls too (see below)
//   … --notes id1,id2 --force                                        # rebuild named meetings
//   … -e SINCE_DAYS=365                                              # the whole year

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { getSupabaseClient, writesCallArtifacts, writesCallSummary, ARCHIVAL_AFTER_DAYS, SUMMARY_AFTER_DAYS, CLAIM_CATEGORY_KEYS } from '@nous/core';
import { lockScript, WORKSPACE_WIDE_JOB } from '../src/lib/backfillLock.mjs';
import {
  getFellowConnections, fellowApiBase, fellowAccountEmail, callFromRecording, reprocessFellow,
} from '../src/webhooks/handlers/fellow.mjs';
import { createMessage } from '../src/lib/llm.mjs';

const WS = process.env.WS_ID;
const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 365);
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
};
// A month at a time, newest first: --window 0-30 is the last 30 days, 30-60 the month before it.
// Recent history is what a CS team acts on, and it lets the bill be taken one month at a time
// rather than as one number nobody has agreed to.
const WINDOW = String(arg('--window', '') || '');
const [WIN_FROM, WIN_TO] = WINDOW.includes('-') ? WINDOW.split('-').map(n => Number(n.trim())) : [null, null];

// Named meetings, for repairing a handful rather than re-running a month: --notes id1,id2.
// Used after a fix to rewrite the calls the old code filed wrongly, at the price of those calls only.
const NOTES = String(arg('--notes', '') || '').split(',').map(x => x.trim()).filter(Boolean);

const DRY_RUN   = process.argv.includes('--dry-run');
// File meetings whose company we do not hold yet too (GET-788). Their people land as Not in CRM.
const INCLUDE_UNKNOWN = process.argv.includes('--include-unknown');
const FILE_ONLY = process.argv.includes('--file-only');
// COACHING IS OFF BY DEFAULT for a backfill (GET-350). Read the account, do not grade the rep.
// A year of sales calls each cost a 60,000-character rubric pass to produce coaching nobody will
// act on — over a third of the model calls on a customer workspace. It used to be opt-OUT, so every run that
// forgot the flag bought grades against a rubric whose eight weight sets were chosen by us, shown
// to no sales leader, and which we intend to replace. A rep also cannot re-run March.
// --coach asks for it back, deliberately, for when that rubric is worth spending on again.
// The health reads that turn a business review into account standing are NOT coaching, and still
// run on anything recent enough for them to mean something (see ALL_LIVE).
const SKIP_COACHING = !process.argv.includes('--coach');
// Rebuild meetings we already hold: for when the pages were deleted deliberately, to rewrite them
// under a newer system. Without it a re-run is a no-op by design.
const FORCE     = process.argv.includes('--force');
// --commitments-only: for meetings already read, run only the commitments read and file the tasks
// (GET-420). Selects meetings the markers say are READ and that carry no task yet; ~$0.02 each.
const COMMITMENTS_ONLY = process.argv.includes('--commitments-only');
// A meeting older than its health windows gets CLAIMS ONLY: no health read, no commitments, no
// call page, no grade (GET-351). The claims are what an old call permanently teaches us about the
// account and they do not go stale; everything else is recency-bound, and `deriveAccountHealth`
// would drop those signals for age on the very next read. --all-live overrides it, for rebuilding
// old pages on purpose.
const ALL_LIVE  = process.argv.includes('--all-live');
const LIMIT     = Number(arg('--limit', 0)) || Infinity;
// A meeting takes ~5 minutes end to end: two Fellow reads, the classifier, extraction over a
// 22k-character transcript, then the review or the health read. Serially, a year of calls is a week
// of wall clock. The work is almost all waiting on someone else's API, so a handful in flight at
// once costs nothing and turns days into hours. Kept modest: Fellow allows 3 requests/second, and a
// stampede on the extraction provider earns 429s that cost more time than they save.
const CONCURRENCY = Math.min(Math.max(Number(arg('--concurrency', 4)) || 4, 1), 10);

if (!WS) { console.error('WS_ID is required'); process.exit(1); }

// Fellow allows 3 requests/second — for the KEY, not for each worker holding it.
//
// This used to be a 350ms sleep after every call, which is right for one worker and wrong for
// every other number: at --concurrency 4 each of the four paced itself to ~3/s and the key issued
// about 12/s, four times the limit. Fellow answers that with 429s, fellowFetch backs off 2s, 4s,
// 6s, and on the fourth attempt returns the 429 — at which point the recording reads as missing
// and the meeting is dropped as `recording_unavailable`. Turning concurrency UP lost meetings.
//
// So the budget is shared. Each request reserves the next free slot before it goes out, and slots
// are handed out 1/RPS apart, so N workers cost exactly the same request rate as one. The waiting
// moves off the meeting's critical path too: a worker sleeps only until its own slot, not a flat
// 350ms after every call it makes.
const FELLOW_RPS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let nextSlotAt = 0;
async function takeFellowSlot() {
  const now = Date.now();
  // Reserved synchronously, so two workers can never be handed the same slot: everything between
  // here and the assignment below runs without an await.
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 1000 / FELLOW_RPS;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

// Fellow 500s now and then — one did, mid-run, on a list call that worked a minute later. A job
// that runs for hours has to ride that out rather than lose the run, so every call retries with
// backoff and only a persistent failure is real.
const MAX_ATTEMPTS = 4;
async function fellowFetch(url, init = {}, label = 'call') {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Every request, retries included — a retry is another request against the same budget.
      await takeFellowSlot();
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${label} ${res.status}`);
        const wait = res.status === 429 ? 2000 * attempt : 1000 * attempt;
        if (attempt < MAX_ATTEMPTS) { console.warn(`[FELLOW_BACKFILL] ${label} ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${wait}ms`); await sleep(wait); continue; }
        return res;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) { await sleep(1000 * attempt); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

// MEASURED, not estimated: a few hundred metered model calls across a few dozen meetings came to a
// few dollars. The first figure (arithmetic over token counts) was more than ten times under, because these are
// reasoning models — 4,000-8,000 OUTPUT tokens per call, billed at 4x the input rate — and a meeting
// costs five or six calls, not two: extraction splits long transcripts into parts, the classifier
// bills as a scoring call, and fallbacks retry. Quote from the meter, never from arithmetic.
// MEASURED against the meter over one week's batch: about eight cents a meeting. The old figure
// was itself a measurement, taken before the health read filed commitments and before claims
// carried quotes — both of which added output tokens, which reasoning models bill at 4x input. A
// stale constant is worse than an absent one: one week was quoted a ceiling and cost over half as
// much again, so the ceiling was not a ceiling.
const COST_PER_MEETING = 0.08;

const FREE_MAIL = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com', 'me.com',
  'aol.com', 'msn.com', 'protonmail.com', 'googlemail.com', 'yahoo.ca', 'hotmail.ca', 'outlook.ca',
  'shaw.ca', 'telus.net', 'sympatico.ca', 'bell.net', 'rogers.com', 'videotron.ca',
]);
const domainOf = (email) => {
  const at = String(email || '').lastIndexOf('@');
  return at > 0 ? String(email).slice(at + 1).toLowerCase() : null;
};

/**
 * Every company domain the workspace holds.
 *
 * PAGED, because a plain select silently stops at 1000 rows — which would shrink thousands of domains to
 * 1,000 and skip most of the year as "unknown company".
 *
 * CACHED, because this runs once per batch against a table a CRM import is writing to, and a
 * statement timeout there kills the whole run before a single meeting is filed. The account list
 * does not change minute to minute; a few hours old is fine, and a stale cache beats no backfill.
 */
const SCOPE_CACHE = `/tmp/fellow-scope-${WS}.json`;
const SCOPE_MAX_AGE_MS = 6 * 3600_000;

async function knownDomains(supabase) {
  if (!process.argv.includes('--refresh-scope') && existsSync(SCOPE_CACHE)) {
    try {
      const cached = JSON.parse(readFileSync(SCOPE_CACHE, 'utf8'));
      if (Date.now() - Date.parse(cached.at) < SCOPE_MAX_AGE_MS && Array.isArray(cached.domains)) {
        console.log(`[FELLOW_BACKFILL] scope from cache (${cached.domains.length} domains, ${Math.round((Date.now() - Date.parse(cached.at)) / 60000)} min old)`);
        return new Set(cached.domains);
      }
    } catch { /* unreadable cache is no cache */ }
  }

  const domains = new Set();
  for (let from = 0; ; from += 500) {
    let page = null;
    for (let attempt = 1; attempt <= 4 && !page; attempt++) {
      const { data, error } = await supabase.from('companies').select('domain')
        .eq('workspace_id', WS).not('domain', 'is', null).range(from, from + 499);
      if (!error) { page = data ?? []; break; }
      console.warn(`[FELLOW_BACKFILL] companies page ${from} failed (${error.message}) — retry ${attempt}/3`);
      await sleep(3000 * attempt);
    }
    if (!page) {
      // The import is hammering the table. Use what we have rather than losing the run: a domain we
      // miss costs one meeting filed as out-of-scope, and the next batch picks it up.
      console.warn(`[FELLOW_BACKFILL] giving up on companies at offset ${from} — scoping with ${domains.size} domains`);
      break;
    }
    for (const row of page) {
      const v = String(row.domain).toLowerCase().replace(/^www\./, '');
      if (v) domains.add(v);
    }
    if (page.length < 500) break;
  }
  try { writeFileSync(SCOPE_CACHE, JSON.stringify({ at: new Date().toISOString(), domains: [...domains] })); } catch { /* cache is a convenience */ }
  return domains;
}

/** Which of THESE addresses we already hold.
 *
 *  Asked against `entity_identifiers`, NOT `contacts`. `contacts` is a VIEW over claims, so an
 *  `in (...)` of any size projects the view and times out — it did, at 200 addresses, while the
 *  CRM import was writing. The identifier table is the real one and answers in milliseconds.
 *
 *  Degrades instead of dying: if a chunk still fails, the run continues on company domains alone
 *  and says so. Losing the email check costs a handful of free-mail attendees; losing the run
 *  costs the night. */
async function knownEmails(supabase, wanted) {
  const found = new Set();
  const list = [...wanted];
  let failed = 0;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { data, error } = await supabase.from('entity_identifiers').select('value')
      .eq('workspace_id', WS).eq('kind', 'email').in('value', chunk);
    if (error) { failed++; continue; }
    for (const row of data ?? []) if (row.value) found.add(String(row.value).toLowerCase());
  }
  if (failed) console.warn(`[FELLOW_BACKFILL] ${failed} address batch(es) failed — scope falls back to company domains for those`);
  return found;
}

/** Every note in the window, with its attendees. One paged list beats a fetch per meeting. */
async function listNotes(base, apiKey, since) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    const res = await fellowFetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pagination: { cursor, page_size: 50 },
        include: { event_attendees: true },
        filters: { created_at_start: since },
      }),
    }, 'notes list');
    if (!res.ok) throw new Error(`notes list ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const d = await res.json();
    const data = d.notes?.data ?? [];
    out.push(...data);
    cursor = d.notes?.page_info?.cursor ?? null;
    if (!cursor || !data.length) break;   // paced by takeFellowSlot inside fellowFetch
  }
  return out;
}

const getJson = async (base, apiKey, path) => {
  const r = await fellowFetch(`${base}${path}`, { headers: { 'X-API-KEY': apiKey } }, path.split('/')[1]);
  if (!r.ok) return null;
  return r.json().catch(() => null);
};

/**
 * Every Fellow note that already has a live call page, as a Set of note ids.
 *
 * Paged, because a Supabase response silently caps at 1,000 rows and a workspace with a year of
 * calls has more than that — a truncated answer here would quietly re-run everything past the cap,
 * which is the failure this guard exists to prevent.
 *
 * A read that fails returns an EMPTY set on purpose: not knowing what is filed must not silently
 * skip the whole month. The run then behaves as it did before, and --force is unaffected either way.
 */
async function pagedNoteIds(supabase, workspaceId) {
  const ids = new Set();
  const PAGE = 1000;
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('documents')
        .select('series')
        .eq('workspace_id', workspaceId)
        .eq('status', 'live')
        .like('series', 'call:fellow:%')
        .order('id', { ascending: true })   // without an order, pages overlap and skip (see resolveOwnDomains)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const id = String(row.series || '').slice('call:fellow:'.length);
        if (id) ids.add(id);
      }
      if ((data ?? []).length < PAGE) break;
    }
  } catch (err) {
    console.warn(`[FELLOW_BACKFILL] could not read which meetings are already paged (${err?.message || err}) — treating none as filed`);
    return new Set();
  }
  return ids;
}

/**
 * Which meetings we have already EXTRACTED from.
 *
 * An archival meeting writes no call page, so `pagedNoteIds` cannot see it and a resumed run would
 * pay to read the same year a second time. Claims carry `source_ref = source://fellow/<noteId>`,
 * which is the durable mark that this transcript has been read.
 *
 * Used for anything past the summary window. A meeting that still writes a page is judged by its
 * page, because the page is what a re-run would overwrite.
 *
 * "Extracted from" means a claim the EXTRACTOR wrote. The meeting's own notes blob carries the same
 * source_ref, and counting it would mark a meeting done that nothing has ever read (GET-356).
 */

/**
 * Which of these Fellow notes already carry a task (GET-420). One read of the workspace's meeting
 * tasks by range (index-friendly, see GET-396/414), then a set lookup per note id.
 */
async function meetingsWithTasks(supabase, workspaceId, noteIds) {
  const out = new Set();
  if (!noteIds.length) return out;
  const wanted = new Set(noteIds);
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('claims').select('property').eq('workspace_id', workspaceId)
      // The proven range (GET-396/410): '.'→'/' holds under ICU; a bound ending in a symbol does not.
      .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null)
      .order('property').range(from, from + 999);
    if (error) { console.warn(`[FELLOW_BACKFILL] could not read which meetings carry tasks (${error.message}) — treating none as done`); return out; }
    for (const r of data ?? []) {
      if (!String(r.property).startsWith('action_item.meeting_')) continue;
      const id = String(r.property).slice('action_item.meeting_'.length).split('_')[0];
      if (wanted.has(id)) out.add(id);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function extractedNoteIds(supabase, workspaceId) {
  const ids = new Set();
  const PAGE = 1000;
  const PREFIX = 'source://fellow/';
  try {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('claims')
        .select('id, value')
        .eq('workspace_id', workspaceId)
        // A half-open range, never a prefix LIKE: the LIKE cannot use claims_ws_property_live and
        // read every claim in the workspace per page — hundreds of thousands of rows — which is a statement timeout,
        // and a timed-out marker reports every meeting as unread and re-buys the year (GET-396,
        // GET-412). '/' is the byte after '.', and sorts after it under ICU too.
        .gte('property', 'note.')
        .lt('property', 'note/')
        .like('value->metadata->>source_ref', `${PREFIX}%`)
        // A REAL extracted claim, not the meeting's notes blob. The notes carry the same
        // source_ref, so without this a meeting that got its notes and no extraction counts as
        // done and is skipped forever — about a quarter of them in prod when this was checked. A document has a
        // doc_type; a claim the extractor wrote does not.
        .is('value->metadata->>doc_type', null)
        .in('value->>category', CLAIM_CATEGORY_KEYS)
        .order('id', { ascending: true })   // paging without an order overlaps and skips (PR #197)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        const ref = String(row.value?.metadata?.source_ref || '');
        if (ref.startsWith(PREFIX)) ids.add(ref.slice(PREFIX.length));
      }
      if ((data ?? []).length < PAGE) break;
    }
  } catch (err) {
    // Same posture as pagedNoteIds: an unreadable marker must not silently skip work. Paying twice
    // is visible on the bill; skipping a year of transcripts is not.
    console.warn(`[FELLOW_BACKFILL] could not read which meetings are already extracted (${err?.message || err}) — treating none as done`);
    return new Set();
  }
  return ids;
}

/**
 * The SECOND proof that a transcript has been read, independent of `source_ref`.
 *
 * `source_ref` is only as good as the writer that stamps it, and one writer did not:
 * `extractActivitySignals` never passed it through, so every 1:1 call, thread and message it
 * extracted produced claims with a null ref — most of them in prod. Those meetings are fully
 * extracted and entirely invisible to `extractedNoteIds`.
 *
 * Measured cost of trusting one marker: a run selected a batch of "remaining" meetings, most of
 * which had already been read, and filed over a hundred duplicate claims onto live accounts before it was
 * stopped. That is the GET-359 shape a second time — "has this been read" must not rest on a
 * single field one writer can forget.
 *
 * A claim points at the observations it was derived from (`supporting_observation_ids`), and a
 * Fellow meeting observation's `external_id` is `fellow_<noteId>_<uuid>`. That chain is
 * structural: it exists because the claim engine builds it, not because an extractor remembered.
 */
async function extractedNoteIdsByObservation(supabase, workspaceId) {
  const ids = new Set();
  const PAGE = 1000;
  try {
    // Every observation id any live note.* claim rests on. Paged — a response silently caps at 1000.
    const supporting = new Set();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('claims')
        .select('id, supporting_observation_ids')
        .eq('workspace_id', workspaceId)
        .gte('property', 'note.')      // range, not LIKE — see extractedNoteIds
        .lt('property', 'note/')
        .is('invalid_at', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) for (const oid of row.supporting_observation_ids ?? []) supporting.add(oid);
      if ((data ?? []).length < PAGE) break;
    }
    if (!supporting.size) return ids;

    // Which of those are Fellow meetings, and which note each one names.
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('observations')
        .select('id, external_id')
        .eq('workspace_id', workspaceId)
        .eq('source', 'fellow')
        .eq('property', 'interaction.meeting_held')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        if (!supporting.has(row.id)) continue;
        // fellow_<noteId>_<uuid> — the note id is the middle segment.
        const noteId = String(row.external_id || '').split('_')[1];
        if (noteId) ids.add(noteId);
      }
      if ((data ?? []).length < PAGE) break;
    }
  } catch (err) {
    console.warn(`[FELLOW_BACKFILL] could not read the observation-link marker (${err?.message || err}) — falling back to source_ref alone`);
    return new Set();
  }
  return ids;
}

// The model config is NOT in .env — compose hands it to the worker service. So
// `docker run --env-file .env` starts a job that looks healthy and silently isn't: the model door
// falls back to its Claude default, every call hits an Anthropic account with no credit, and a
// repair run reports "10/10 done" having written nothing. That happened on 2026-09-17.
//
// A run that cannot reach the configured model must not start. Checked before the Fellow paging so
// the answer arrives in seconds, not after two minutes of listing notes. --file-only calls no model
// and is exempt.
function assertModelConfig() {
  if (FILE_ONLY) return;
  const missing = ['EXTRACTION_MODEL', 'OPENROUTER_API_KEY'].filter(k => !(process.env[k] || '').trim());
  if (!missing.length) return;
  console.error(`[FELLOW_BACKFILL] refusing to start: ${missing.join(' and ')} not set in this container.`);
  console.error('[FELLOW_BACKFILL] the model config lives in compose, not .env — start the job with:');
  console.error('[FELLOW_BACKFILL]   docker compose run --rm --no-deps -e WS_ID=<uuid> worker \\');
  console.error('[FELLOW_BACKFILL]     node apps/worker/scripts/fellowBackfill.mjs <flags>');
  process.exit(1);
}


// ── Can this run afford to finish? ──────────────────────────────────────────
//
// On 2026-09-18 a run burned an hour, reported `6/6 · filed 5 · failed 0`, exited ZERO, and
// produced well under half the claims expected. Every model call had returned HTTP 402. Nothing in
// the output said so; it was found by counting rows afterwards.
//
// assertModelConfig already refuses to start when the model is unreachable. "Reachable but cannot
// afford to finish" is the same class of failure and deserves the same treatment: a run that will
// die halfway should not begin, because a half-extracted corpus is worse than an unstarted one —
// the meetings it touched look done to every marker that counts claims.
//
// TWO CHECKS, AND THE ORDER MATTERS.
//
// The balance endpoint is advisory. It reported about $10 remaining while requests reserving roughly 17k
// tokens were being refused, because OpenRouter holds credit against IN-FLIGHT reservations: N
// concurrent calls each reserve their max_tokens, and the sum, not the balance, is what fails. So
// the authority is a REAL REQUEST at the largest reservation this run will make. 200 means go.
const PROBE_MAX_TOKENS = 18_000;   // a full extraction call: ~2k asked + 16k reasoning headroom

async function assertCredit(estimatedCost) {
  if (FILE_ONLY || DRY_RUN) return;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return;   // assertModelConfig has already refused for this

  // 1. What the meter says. Advisory, and it has lied before.
  let remaining = null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` } });
    const d = (await res.json())?.data;
    if (d && Number.isFinite(d.total_credits) && Number.isFinite(d.total_usage)) {
      remaining = d.total_credits - d.total_usage;
    }
  } catch { /* the probe below is the real check */ }

  // 2. What the provider actually does, at the size this run will ask for — THROUGH THE DOOR.
  //
  // The first version of this called OpenRouter directly and the model-door guard failed the build,
  // correctly. Going through createMessage is also the better probe: it exercises the exact path
  // every real call takes, including the host pin and the reasoning headroom, rather than a
  // hand-rolled approximation of it that could pass while production fails.
  //
  // fallback: false on purpose. The fallback model working is not the question; the question is
  // whether this run can proceed normally.
  let probeOk = false, probeWhy = 'no answer';
  try {
    await createMessage({
      feature: 'backfill-preflight',
      max_tokens: PROBE_MAX_TOKENS,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      fallback: false,
    });
    probeOk = true;
  } catch (err) { probeWhy = err?.message || String(err); }

  const money = (n) => (n == null ? 'unknown' : `$${n.toFixed(2)}`);
  if (!probeOk) {
    console.error(`[FELLOW_BACKFILL] refusing to start: the model will not accept a ${PROBE_MAX_TOKENS.toLocaleString()}-token request.`);
    console.error(`[FELLOW_BACKFILL]   ${probeWhy}`);
    console.error(`[FELLOW_BACKFILL]   balance reads ${money(remaining)} — which can look healthy while requests are refused, because`);
    console.error('[FELLOW_BACKFILL]   credit is held against in-flight reservations: concurrency x max_tokens, not the balance alone.');
    console.error('[FELLOW_BACKFILL]   Add credit, or lower --concurrency, then run again.');
    process.exit(1);
  }

  // Enough to FINISH, not merely to start. A run that dies halfway leaves meetings that look done.
  if (remaining != null && remaining < estimatedCost) {
    console.error(`[FELLOW_BACKFILL] refusing to start: this run is priced at ${money(estimatedCost)} and only ${money(remaining)} remains.`);
    console.error('[FELLOW_BACKFILL]   A run that stops halfway is worse than one that never starts: the meetings it touched');
    console.error('[FELLOW_BACKFILL]   look done to every marker, and the summary line will still say "failed 0".');
    console.error('[FELLOW_BACKFILL]   Add credit, or narrow the window with --window / --limit.');
    process.exit(1);
  }
  console.log(`[FELLOW_BACKFILL] credit: ${money(remaining)} available, ${money(estimatedCost)} priced · a ${PROBE_MAX_TOKENS.toLocaleString()}-token request was accepted`);
}

(async () => {
  assertModelConfig();
  const supabase = getSupabaseClient();
  const conn = (await getFellowConnections(supabase, WS)).find(c => c.isVerified);
  if (!conn) { console.error(`no verified Fellow connection on workspace ${WS}`); process.exit(1); }
  // A month of meetings, extracted and settled: the workspace-wide lock, for as long as it runs.
  const lock = await lockScript(supabase, WS, WORKSPACE_WIDE_JOB, { note: 'fellowBackfill', leaseMinutes: 360 });

  const base = fellowApiBase(conn.subdomain);
  const accountEmail = await fellowAccountEmail(supabase, conn);
  const ourDomain = domainOf(accountEmail);
  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();
  console.log(`[FELLOW_BACKFILL] workspace=${WS} subdomain=${conn.subdomain} as=${accountEmail ?? 'unknown'} since=${since.slice(0, 10)}`);

  const domains = await knownDomains(supabase);

  const notes = await listNotes(base, conn.apiKey, since);
  let recorded = notes.filter(n => (n.recording_ids ?? []).length);
  if (Number.isFinite(WIN_FROM) && Number.isFinite(WIN_TO)) {
    const newest = Date.now() - WIN_FROM * 86400000;
    const oldest = Date.now() - WIN_TO * 86400000;
    recorded = recorded.filter(n => {
      const t = Date.parse(n.event_start ?? n.created_at ?? '');
      return Number.isFinite(t) && t <= newest && t >= oldest;
    });
    console.log(`[FELLOW_BACKFILL] window: the last ${WIN_FROM}-${WIN_TO} days → ${recorded.length} recorded meeting(s)`);
  }
  console.log(`[FELLOW_BACKFILL] ${notes.length} notes in window, ${recorded.length} with a recording`);

  // Ask about the addresses this year's meetings actually name, not the whole contacts table.
  const attendeeEmails = new Set();
  for (const n of recorded) {
    for (const a of n.event_attendees ?? []) {
      const e = String(a?.email ?? '').toLowerCase();
      if (e && domainOf(e) !== ourDomain) attendeeEmails.add(e);
    }
  }
  const emails = await knownEmails(supabase, attendeeEmails);
  console.log(`[FELLOW_BACKFILL] graph holds ${domains.size} company domains · ${emails.size} of ${attendeeEmails.size} attendee addresses are already contacts`);

  // Scope: a company we already hold, or a person we already hold. Oldest first.
  const inScope = [];
  const skipped = { unknownCompany: 0, noExternal: 0 };
  for (const n of recorded) {
    const attendees = (n.event_attendees ?? []).map(a => String(a?.email ?? '').toLowerCase()).filter(Boolean);
    const external = attendees.filter(e => domainOf(e) !== ourDomain);
    if (!external.length) { skipped.noExternal++; continue; }
    const hit = external.some(e => emails.has(e))
      || external.some(e => { const d = domainOf(e); return d && !FREE_MAIL.has(d) && domains.has(d); });
    if (!hit && !INCLUDE_UNKNOWN) { skipped.unknownCompany++; continue; }
    inScope.push(n);
  }
  inScope.sort((a, b) => String(a.event_start ?? '').localeCompare(String(b.event_start ?? '')));
  // A named set skips the scope rule on purpose: these are calls we already filed once and are
  // repairing, so "is this company known" was answered the first time.
  const chosen = NOTES.length ? recorded.filter(n => NOTES.includes(n.id)) : inScope;
  if (NOTES.length) console.log(`[FELLOW_BACKFILL] named meetings: ${chosen.length} of ${NOTES.length} found`);

  // A MEETING WE HAVE ALREADY PAGED IS DONE. Re-running one is neither free nor harmless: it calls
  // the models again, and it REPLACES the page with whatever this run resolves — so a re-run can
  // overwrite a correct page with a worse answer. That happened on 2026-09-17: a month run rewrote
  // two pages that had just been corrected, one of them onto the seller's own employee.
  //
  // Resuming a half-finished month is the ordinary case, so this is the ordinary path: skip what is
  // filed, work what is not. --force is the deliberate opposite, for rebuilding on purpose.
  // "Done" means a different thing for each half. A LIVE meeting is done when it has a page, because
  // the page is what a re-run would overwrite. An ARCHIVAL meeting writes no page, so it is done
  // when its transcript has been extracted from — without this, every resumed run would pay to read
  // the same year again and the success line would look identical.
  const alreadyPaged = FORCE ? new Set() : await pagedNoteIds(supabase, WS);
  // TWO independent proofs of extraction, unioned. Either one is enough to say "already read", and
  // needing both would be the bug: source_ref is absent on everything extractActivitySignals wrote
  // (GET-375), and the observation link is absent on the few hundred claims that carry no supporting
  // observation. Each covers the other's blind spot; trusting either alone re-reads a year.
  const alreadyExtracted = (FORCE || ALL_LIVE) ? new Set() : new Set([
    ...await extractedNoteIds(supabase, WS),
    ...await extractedNoteIdsByObservation(supabase, WS),
  ]);
  const isArchival = (n) => !ALL_LIVE && !writesCallArtifacts(n.event_start);
  // Which marker says "done" follows which marker EXISTS. A meeting that writes a page is judged by
  // its page, because the page is what a re-run would overwrite. Anything past the thirty-day
  // summary window writes none, so it is judged by whether its transcript has been extracted from —
  // and the summary window is far tighter than the archival one, so most of a year's backfill now
  // falls on this side. Get this wrong and every resumed run silently pays to redo the same months.
  //
  // EITHER proof is enough, and that is not belt-and-braces — it is the only correct answer.
  // A page proves scoreCall ran. Extracted claims prove the transcript was read. A meeting
  // processed BEFORE claims carried a source_ref (GET-359) can only ever offer the first, and
  // judging it by the second alone would re-buy every month already done. A meeting whose page was
  // skipped for age can only ever offer the second.
  const alreadyDone = (n) => alreadyPaged.has(n.id) || alreadyExtracted.has(n.id);
  const writesAPage = (n) => ALL_LIVE || writesCallSummary(n.event_start);
  let fresh = chosen.filter(n => !alreadyDone(n));
  if (COMMITMENTS_ONLY) {
    // The opposite selection (GET-420): meetings that WERE read, and carry no task yet. Their facts
    // and insights exist; only the commitments read was missing (before GET-418 it ran on reviews
    // and training calls alone). --force widens it to every read meeting.
    const read = chosen.filter(n => alreadyDone(n));
    const withTasks = await meetingsWithTasks(supabase, WS, read.map(n => n.id));
    fresh = FORCE ? read : read.filter(n => !withTasks.has(n.id));
    console.log(`[FELLOW_BACKFILL] commitments only: ${read.length} read · ${withTasks.size} already carry tasks · ${fresh.length} to read for commitments${FORCE ? ' (FORCE: all read meetings)' : ''}`);
  } else if (chosen.length !== fresh.length) {
    console.log(`[FELLOW_BACKFILL] already done: ${chosen.length - fresh.length} of ${chosen.length} — skipping (--force redoes them)`);
  }
  const targets = fresh.slice(0, LIMIT === Infinity ? fresh.length : LIMIT);

  // Archival meetings skip the health read, the page and the grade — roughly half the per-meeting
  // spend, since those are separate model calls over the same transcript. Quoted as a ceiling, as
  // the full-mode price always has been.
  const archivalCount = targets.filter(isArchival).length;
  const liveCount = targets.length - archivalCount;
  const price = FILE_ONLY ? 0 : COMMITMENTS_ONLY ? liveCount * 0.02 : (liveCount * COST_PER_MEETING) + (archivalCount * COST_PER_MEETING * 0.5);
  console.log(`[FELLOW_BACKFILL] in scope: ${inScope.length} · skipped: ${skipped.unknownCompany} unknown company, ${skipped.noExternal} internal-only`);
  const mode = FILE_ONLY ? 'file-only (no model calls)'
    : COMMITMENTS_ONLY ? 'commitments only (one read per meeting, tasks filed, nothing else)'
    : SKIP_COACHING ? 'extraction + health reads, no rep coaching'
    : 'full (extraction + review)';
  if (!FILE_ONLY) {
    const summaryCount = targets.filter(writesAPage).length;
    console.log(`[FELLOW_BACKFILL] treatment: ${summaryCount} get a summary (newer than ${SUMMARY_AFTER_DAYS}d) · ${targets.length - summaryCount - archivalCount} claims + health read, no summary · ${archivalCount} claims only (older than ${ARCHIVAL_AFTER_DAYS}d)${ALL_LIVE ? ' — OVERRIDDEN by --all-live' : ''}`);
  }
  // The price is METERED at full mode. Skipping coaching drops the rubric pass on every graded
  // call, so the real spend comes in under this — quoted as a ceiling, never as a promise.
  console.log(`[FELLOW_BACKFILL] this run: ${targets.length} meeting(s) · ${CONCURRENCY} at a time · mode: ${mode}${FORCE ? ' · FORCE (rebuilding meetings already held)' : ''} · estimated model cost: ${SKIP_COACHING ? 'at most ' : ''}$${price.toFixed(2)}`);
  if (DRY_RUN) { console.log('[FELLOW_BACKFILL] dry run — nothing written'); await lock.exit(0); }

  // Priced, and only now can we ask whether it can be paid for.
  await assertCredit(price);

  const stats = { filed: 0, alreadyFiled: 0, attached: 0, unresolved: 0, deduped: 0, withHost: 0, withTranscript: 0, failed: [] };
  let i = 0;
  let cursorIdx = 0;

  const runOne = async (note) => {
    try {
      const full = (await getJson(base, conn.apiKey, `/note/${encodeURIComponent(note.id)}`))?.note ?? note;
      const recId = (full.recording_ids ?? [])[0];
      const rec = recId ? (await getJson(base, conn.apiKey, `/recording/${encodeURIComponent(recId)}`))?.recording : null;
      if (!rec) { stats.failed.push({ note: note.id, why: 'recording_unavailable' }); return; }

      const call = callFromRecording(rec, full, { subdomain: conn.subdomain });
      const r = await reprocessFellow(supabase, WS, {
        type: 'poll', call, accountEmail, backfill: true, force: FORCE, skipCoaching: SKIP_COACHING,
        // Nothing has been extracted from this transcript, so the work is outstanding even if the
        // activity rows already exist from a run whose model calls failed (GET-358).
        reextract: !alreadyExtracted.has(note.id),
        ...(COMMITMENTS_ONLY ? { mode: 'commitments_only' } : FILE_ONLY ? { mode: 'file_only' } : ALL_LIVE ? { mode: 'live' } : {}),
      });

      // A second recording of a call we already hold is NOT an unresolved meeting — it is the
      // dedupe path doing its job (Fellow files some calls as two recordings). Counting those as
      // "unresolved" made the first run read nearly half unresolved when nothing failed to resolve.
      if (r?.deduped) { stats.deduped++; }
      else if (r?.logged > 0) { stats.filed++; if (r?.linked > 0) stats.attached++; else stats.unresolved++; }
      else { stats.alreadyFiled++; if (r?.linked > 0) stats.attached++; else stats.unresolved++; }
      if (r?.hostEmail) stats.withHost++;
      if (r?.hasTranscript) stats.withTranscript++;
    } catch (err) {
      stats.failed.push({ note: note.id, why: err?.message || String(err) });
      console.warn(`[FELLOW_BACKFILL] ${note.id} failed: ${err?.message || err}`);
    }
    i++;
    if (i % 5 === 0 || i === targets.length) {
      console.log(`[FELLOW_BACKFILL] ${i}/${targets.length} · filed ${stats.filed} · already ${stats.alreadyFiled} · deduped ${stats.deduped} · attached ${stats.attached} · unresolved ${stats.unresolved} · failed ${stats.failed.length}`);
    }
  };

  // Oldest first still holds: the workers take from one queue in order, so a person met in
  // September is established before the October call that mentions them. Only the waiting overlaps.
  const worker = async () => {
    for (;;) {
      const idx = cursorIdx++;
      if (idx >= targets.length) return;
      await runOne(targets[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  console.log('[FELLOW_BACKFILL] done');
  console.log(JSON.stringify({
    run: targets.length, mode: FILE_ONLY ? 'file_only' : (SKIP_COACHING ? 'no_coaching' : 'full'),
    live: liveCount, archival: archivalCount,
    newly_filed: stats.filed, already_filed: stats.alreadyFiled,
    second_recording_of_a_call_we_hold: stats.deduped,
    attached_to_an_account: stats.attached, unresolved: stats.unresolved,
    with_host_email: stats.withHost, with_transcript: stats.withTranscript,
    failed: stats.failed.length, failures: stats.failed.slice(0, 20),
  }, null, 2));
  await lock.exit(0);
})();
