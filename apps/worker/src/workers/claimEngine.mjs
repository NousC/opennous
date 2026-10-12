// Claim-derivation engine — drains the claim_jobs queue.
//
// Every observation insert enqueues a (entity, property) recompute via a DB
// trigger (observations_enqueue_recompute). This worker drains that queue and
// re-derives each affected claim from its observations. This is the
// self-healing loop: a new observation always pulls the belief back toward
// truth. The derivation logic itself lives in @nous/core (recomputeClaim).

import { getSupabaseClient, recomputeClaim, logWorkerRun, listSignals, rescoreEntityFromClaims, rescoreCompanyMembers, normalizeStage, isScoreAffectingProperty, isListRowProperty } from '@nous/core';
import { runIntentScoring } from '../intentScore.mjs';

// Sized for a client import, not a demo workspace: one large CRM import can queue close to a million
// jobs, and at 500 a minute that is more than a day during which the app shows yesterday (GET-302).
const BATCH_SIZE = 2000;       // jobs pulled per inner sweep
const TIME_BUDGET_MS = 50_000; // drain up to ~50s per tick (cron fires every minute)

// The worker and the app share one connection pool, and the app has eight seconds to answer before
// its statement is killed. At 40 this drained one customer's queue fast and took the product down
// with it: every recompute holds a connection through several round trips, the app's queries
// queued behind them, and the account list timed out while the queue it was waiting on emptied
// nicely. Throughput here is worth nothing if the page it feeds will not load.
//
// Twelve keeps the drain useful (~480k jobs in well under an hour) and still leaves the pool room
// to answer a request. Raise it only for a backfill on a workspace nobody is using, via the env.
const CONCURRENCY = Number(process.env.CLAIM_ENGINE_CONCURRENCY ?? 12);

// The most list rows one workspace may have rebuilt per kind per tick (GET-347). Steady state is a
// handful; an import settles thousands, and there the queue drain matters more than instant rows —
// the hourly sweep still covers whatever this leaves. Each rebuild is one aimed chunk call.
const LIST_ROWS_PER_TICK = Number(process.env.CLAIM_ENGINE_LIST_ROWS_PER_TICK ?? 300);

// Claim properties whose change can move an ICP score. When one of these is
// recomputed for an entity that already has an OPEN prediction, we re-score that
// prediction from current claims so enrichment (job title, seniority,
// firmographics) flows straight into the score and the account trail — not just
// at model-change time. The list lives in @nous/core because the import's settle
// step (GET-299) must leave exactly these jobs queued for this follow-up.
const isScoreAffecting = isScoreAffectingProperty;

// Prevent overlapping ticks — a long drain must not collide with the next cron.
let running = false;

export async function processClaimJobs() {
  if (running) return;
  running = true;
  const supabase = getSupabaseClient();
  const startedAt = new Date();
  const deadline = Date.now() + TIME_BUDGET_MS;
  let recomputed = 0, failed = 0, sweeps = 0;
  // Entities whose score-affecting claims changed this tick → re-score their
  // open prediction once, after the drain. Map<workspace_id, Set<entity_id>>.
  const toRescore = new Map();
  // Entities whose pipeline_stage changed this tick → check if they just became a
  // client and, if so, flip intent to the client axis. Map<workspace_id, Set>.
  const stageChanged = new Map();
  // Entities whose settled claim changed something a LIST COLUMN shows → rebuild their flattened
  // row now rather than whenever the crawler next reaches them (GET-347). Map<workspace_id, Set>.
  const listChanged = new Map();
  try {
    // Keep draining the queue (in 500-job sweeps) until it's empty or we hit the
    // time budget. Each sweep recomputes its unique (entity, property) targets in
    // parallel — distinct targets are independent, so this is safe.
    //
    // Ordered BY TARGET, not by arrival. The queue holds one row per observation, so the same
    // (entity, property) is enqueued again every time that fact is observed again — a deal's
    // stage history, a re-import, an account that keeps receiving mail. Those copies are all
    // satisfied by ONE recompute, because recomputeClaim reads the whole observation history
    // every time and derives the current answer from it.
    //
    // The collapse below has always been here, but arrival order scattered the copies across
    // the whole queue: a workspace whose CRM import ran six times enqueued its six copies hours
    // apart, so they landed in six different sweeps and bought six identical recomputes. Sorted
    // by target they arrive together, collapse to one, and every copy is deleted with it.
    //
    // MEASURED on the first workspace to hit this: a little over two copies per target on average,
    // a handful at worst — so roughly half its queued rows stood in for answers it already had, and
    // about half the drain was buying a number it already had.
    //
    // Fairness is not lost: nothing is starved, because a sweep only ends when its rows are
    // done, and the queue is drained to empty every tick it can manage. Served by
    // claim_jobs_pending_target.
    while (Date.now() < deadline) {
      const { data: jobs, error } = await supabase
        .from('claim_jobs')
        .select('id, workspace_id, entity_id, property')
        .is('picked_at', null)
        .order('entity_id', { ascending: true })
        .order('property', { ascending: true })
        .limit(BATCH_SIZE);

      // Migration not yet applied — skip silently so we don't spam logs.
      if (error?.code === '42P01' || error?.code === 'PGRST205') return;
      if (error) throw error;
      if (!jobs?.length) break; // queue drained

      // Collapse many observations on the same (entity, property) to one recompute.
      const targets = new Map();
      for (const j of jobs) targets.set(`${j.entity_id}:${j.property}`, j);

      const succeeded = new Set();
      const entries = [...targets.entries()];
      for (let i = 0; i < entries.length; i += CONCURRENCY) {
        await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([key, t]) => {
          try {
            await recomputeClaim(supabase, t.workspace_id, t.entity_id, t.property);
            succeeded.add(key);
            recomputed++;
            if (t.property === 'pipeline_stage') {
              if (!stageChanged.has(t.workspace_id)) stageChanged.set(t.workspace_id, new Set());
              stageChanged.get(t.workspace_id).add(t.entity_id);
            }
          } catch (err) {
            failed++;
            console.error(`[CLAIM_ENGINE] ${t.entity_id}/${t.property}:`, err.message);
          }
        }));
      }

      // Delete jobs for succeeded targets; leave failed ones to retry next tick.
      const doneIds = jobs
        .filter(j => succeeded.has(`${j.entity_id}:${j.property}`))
        .map(j => j.id);
      if (doneIds.length) await supabase.from('claim_jobs').delete().in('id', doneIds);

      // Queue a re-score for any entity whose score-affecting claim just changed.
      for (const [key, t] of targets) {
        if (!succeeded.has(key) || !isScoreAffecting(t.property)) continue;
        if (!toRescore.has(t.workspace_id)) toRescore.set(t.workspace_id, new Set());
        toRescore.get(t.workspace_id).add(t.entity_id);
      }

      // And a list-row rebuild for any entity whose settled claim is one a list column renders.
      for (const [key, t] of targets) {
        if (!succeeded.has(key) || !isListRowProperty(t.property)) continue;
        if (!listChanged.has(t.workspace_id)) listChanged.set(t.workspace_id, new Set());
        listChanged.get(t.workspace_id).add(t.entity_id);
      }

      sweeps++;
      if (!succeeded.size) break; // everything failed — stop, don't hot-loop
    }

    // Re-score-on-enrichment: now that claims are current, refresh the open
    // prediction of every entity whose evidence moved. Per workspace, load the
    // Scorecard once; rescoreEntityFromClaims no-ops cheaply when an entity has
    // no open prediction or isn't scoreable yet. Best-effort — a rescore failure
    // never blocks the claim drain.
    let rescored = 0;
    for (const [workspaceId, entityIds] of toRescore) {
      let signals;
      try {
        signals = await listSignals(supabase, workspaceId);
      } catch (err) {
        console.error(`[CLAIM_ENGINE] rescore listSignals ${workspaceId}:`, err.message);
        continue;
      }
      if (!signals.some(s => s.active)) continue; // no Scorecard → nothing to refresh
      for (const entityId of entityIds) {
        try {
          // If the claim landed on a COMPANY, fan out to the people who work there
          // (their scores inherit company signals/exclusions); otherwise re-score
          // the entity itself.
          const fan = await rescoreCompanyMembers(supabase, workspaceId, entityId, { signals });
          if (fan.members) { rescored += fan.rescored; continue; }
          const r = await rescoreEntityFromClaims(supabase, workspaceId, entityId, { signals });
          if (r.status === 'rescored') rescored++;
        } catch (err) {
          console.error(`[CLAIM_ENGINE] rescore ${entityId}:`, err.message);
        }
      }
    }
    if (rescored) console.log(`[CLAIM_ENGINE] rescored ${rescored} open prediction(s) after enrichment`);

    // Any entity whose stage just became 'closed_won' → recompute intent so it flips off
    // the buying bands (Aware/Warm/Hot) onto the client axis (Active/At-risk/Expansion)
    // immediately, not on the next intent cron. Best-effort.
    let clientFlipped = 0;
    for (const [ws, ids] of stageChanged) {
      try {
        const idArr = [...ids];
        const { data: cl } = await supabase.from('claims').select('entity_id, value')
          .eq('workspace_id', ws).in('entity_id', idArr).eq('property', 'pipeline_stage').is('invalid_at', null);
        // Normalized: the claim reads `closed_won` after a new write and `client` on
        // rows the migration has not reached yet. A raw match would miss both halves
        // at different times and leave the account stuck on the buying bands.
        const clientIds = (cl || []).filter(c => normalizeStage(c.value) === 'closed_won').map(c => c.entity_id);
        if (!clientIds.length) continue;
        const { data: contacts } = await supabase.from('contacts').select('id, domain').in('id', clientIds);
        const persons = clientIds.map(id => ({ entity_id: id, domain: (contacts || []).find(c => c.id === id)?.domain || null }));
        const r = await runIntentScoring(supabase, ws, { persons, write: true });
        clientFlipped += r.staked || 0;
      } catch (err) {
        console.error('[CLAIM_ENGINE] client-intent flip:', err.message);
      }
    }
    if (clientFlipped) console.log(`[CLAIM_ENGINE] flipped ${clientFlipped} account(s) to the client intent axis`);

    // The flattened rows, rebuilt for the entities whose claims just changed (GET-347).
    //
    // Until now entity_list_rows was maintained only by an hourly cursor crawling entities in id
    // order, which on a large client workspace never completed a single cycle — so a name or
    // a stage that settled here could take a day to reach the list that shows it, and hundreds of
    // accounts had no row at all. Rebuilding on settle is what makes the projection trustworthy enough to
    // be the only thing lists read; the crawl stays as the safety net.
    //
    // Ordering is load-bearing and the same order the sweep uses: an account row aggregates the
    // person and deal rows beneath it, so accounts must be rebuilt last or they aggregate the
    // values they had a moment ago.
    let listRows = 0;
    for (const [workspaceId, entityIds] of listChanged) {
      const ids = [...entityIds];
      if (!ids.length) continue;
      let types;
      try {
        // Which kind each entity is — the projection is per-kind and the claim job does not say.
        const byId = new Map();
        for (let i = 0; i < ids.length; i += 200) {
          const { data } = await supabase.from('entities').select('id, type').in('id', ids.slice(i, i + 200));
          for (const e of data ?? []) byId.set(e.id, e.type);
        }
        types = byId;
      } catch (err) {
        console.error('[CLAIM_ENGINE] list rows: entity types:', err.message);
        continue;
      }
      const kindOf = { company: 'account', person: 'person', deal: 'deal' };
      for (const kind of ['deal', 'person', 'account']) {
        const forKind = ids.filter(id => kindOf[types.get(id)] === kind);
        if (!forKind.length) continue;
        // Capped per tick: during an import this set is thousands, and the queue drain matters
        // more than instant rows. Whatever is skipped the hourly sweep still picks up.
        const capped = forKind.slice(0, LIST_ROWS_PER_TICK);
        for (let i = 0; i < capped.length; i += 100) {
          const { data, error } = await supabase.rpc('refresh_list_rows_for', {
            ws: workspaceId, p_kind: kind, p_ids: capped.slice(i, i + 100),
          });
          if (error) {
            // A database without the function yet just keeps relying on the sweep.
            if (!/refresh_list_rows_for|PGRST202|does not exist/i.test(String(error.message))) {
              console.error('[CLAIM_ENGINE] list rows %s: %s', kind, error.message);
            }
            break;
          }
          listRows += Number(data ?? 0);
        }
      }
    }
    if (listRows) console.log(`[CLAIM_ENGINE] rebuilt ${listRows} list row(s) on settle`);

    if (recomputed || failed) {
      console.log(`[CLAIM_ENGINE] recomputed=${recomputed} failed=${failed} sweeps=${sweeps}`);
      await logWorkerRun(supabase, {
        worker: 'claim_engine',
        status: failed && !recomputed ? 'error' : 'success',
        summary: `recomputed ${recomputed}${failed ? `, failed ${failed}` : ''} over ${sweeps} sweep(s)`,
        details: { recomputed, failed, sweeps },
        startedAt,
      });
    }
  } catch (err) {
    console.error('[CLAIM_ENGINE] sweep error:', err.message);
    await logWorkerRun(supabase, {
      worker: 'claim_engine',
      status: 'error',
      summary: 'sweep failed',
      error: err.message,
      startedAt,
    });
  } finally {
    running = false;
  }
}
