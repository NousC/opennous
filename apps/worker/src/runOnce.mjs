// Manual one-off runner for the compound-intelligence loop workers.
//
// Useful for:
//   - Smoke-testing worker_runs logging without waiting for the cron schedule.
//   - Re-running a failed nightly job mid-day.
//
// Usage:
//   pnpm --filter @nous/worker run once               # runs everything
//   pnpm --filter @nous/worker run once mind_outcomes # runs one worker
//
// (Or directly: node --env-file=../../.env src/runOnce.mjs [worker_name])

import { processClaimJobs } from './workers/claimEngine.mjs';
import { processEmbeddings } from './workers/embeddings.mjs';
import { scoreEntities } from './workers/scoreEntities.mjs';
import { resolveOutcomes } from './workers/mindOutcomes.mjs';
import { runScorecardLoop } from './workers/scorecardLoop.mjs';
import { processLeadReplies } from './workers/leadReplies.mjs';
import { runCrmAutoSync } from './workers/crmSync.mjs';
import { runLinkedInEngagement } from './workers/linkedinEngagement.mjs';
import { getSupabaseClient, logWorkerRun } from '@nous/core';

// Ordered the same way the cron would in a single nightly cycle:
//   crm_sync → pipeline_decay → mind_outcomes → scorecard_loop, plus the
//   continuous workers (claim_engine, score_entities, embeddings, lead_replies)
//   for completeness.
const WORKERS = {
  crm_sync:        runCrmAutoSync,
  pipeline_decay:  async () => {
    const supabase = getSupabaseClient();
    const startedAt = new Date();
    try {
      const { error } = await supabase.rpc('decay_pipeline_stages');
      if (error) throw error;
      await logWorkerRun(supabase, {
        worker: 'pipeline_decay',
        status: 'success',
        summary: 'pipeline stage decay complete',
        startedAt,
      });
    } catch (err) {
      await logWorkerRun(supabase, {
        worker: 'pipeline_decay',
        status: 'error',
        summary: 'pipeline decay failed',
        error: err.message,
        startedAt,
      });
      throw err;
    }
  },
  claim_engine:    processClaimJobs,
  embeddings:      processEmbeddings,
  score_entities:  scoreEntities,
  mind_outcomes:   resolveOutcomes,
  scorecard_loop:  runScorecardLoop,
  lead_replies:    processLeadReplies,
  linkedin_engagement: runLinkedInEngagement,
};

const arg = process.argv[2];
const targets = arg ? [arg] : Object.keys(WORKERS);

for (const name of targets) {
  const fn = WORKERS[name];
  if (!fn) {
    console.error(`[RUN_ONCE] unknown worker: ${name}`);
    console.error(`[RUN_ONCE] valid: ${Object.keys(WORKERS).join(', ')}`);
    process.exit(1);
  }
  const t0 = Date.now();
  console.log(`\n→ ${name}`);
  try {
    await fn();
    console.log(`  ✓ ${name} done (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err.message);
  }
}

console.log('\nDone. Check the worker_runs table to see what landed.');
process.exit(0);
