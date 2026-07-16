// Claim-derivation engine — drains the claim_jobs queue.
//
// Every observation insert enqueues a (entity, property) recompute via a DB
// trigger (observations_enqueue_recompute). This worker drains that queue and
// re-derives each affected claim from its observations. This is the
// self-healing loop: a new observation always pulls the belief back toward
// truth. The derivation logic itself lives in @nous/core (recomputeClaim).

import { getSupabaseClient, recomputeClaim, logWorkerRun, listSignals, rescoreEntityFromClaims, rescoreCompanyMembers } from '@nous/core';

const BATCH_SIZE = 500;        // jobs pulled per inner sweep
const CONCURRENCY = 15;        // parallel recomputes within a sweep
const TIME_BUDGET_MS = 50_000; // drain up to ~50s per tick (cron fires every minute)

// Claim properties whose change can move an ICP score. When one of these is
// recomputed for an entity that already has an OPEN prediction, we re-score that
// prediction from current claims so enrichment (job title, seniority,
// firmographics) flows straight into the score and the account trail — not just
// at model-change time. `signal.*` covers the website-extractor features.
// Identity/metadata props (name, email, enrichment_status, …) are excluded.
const SCORE_AFFECTING = new Set([
  'job_title', 'seniority', 'department', 'industry', 'employee_count',
  'size_band', 'funding_stage', 'country', 'company_type', 'what_they_do',
  'pipeline_stage',
]);
const isScoreAffecting = (property) =>
  SCORE_AFFECTING.has(property) || property.startsWith('signal.') || property.startsWith('exclusion.');

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
  try {
    // Keep draining the queue (in 500-job sweeps) until it's empty or we hit the
    // time budget. Each sweep recomputes its unique (entity, property) targets in
    // parallel — distinct targets are independent, so this is safe.
    while (Date.now() < deadline) {
      const { data: jobs, error } = await supabase
        .from('claim_jobs')
        .select('id, workspace_id, entity_id, property')
        .is('picked_at', null)
        .order('enqueued_at', { ascending: true })
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
