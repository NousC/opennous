// The learning runner. For each job due this cadence, run its learn() step and
// persist the observations it returns — applying the confidence gate and appending
// a version whenever the number actually moved. The runner owns gating, versioning,
// and idempotency; the job owns the computation for its one question.

import { getJobs, } from './registry.mjs';
import { upsertObservation, getPrior, recordRun } from './db.mjs';
import { confidenceForSample } from './types.mjs';

export async function runLearningJobs(supabase, workspaceId, cadence) {
  const jobs = getJobs(cadence);
  if (!jobs.length) return { jobs: 0, observations: 0 };

  let written = 0;
  for (const job of jobs) {
    try {
      const prior = await getPrior(supabase, job.key);
      const ctx = { supabase, workspaceId, job, prior };
      const results = (await job.learn(ctx)) ?? [];
      for (const r of results) {
        // A job may set its own confidence (deterministic rules, comparative
        // baselines). Otherwise it is derived from the sample size — never invented.
        const confidence = r.confidence ?? confidenceForSample(r.sampleSize);
        await upsertObservation(supabase, workspaceId, {
          questionKey: r.questionKey ?? job.key,
          category: r.category ?? job.category,
          jobType: r.jobType ?? job.type,
          behaviorKey: r.behaviorKey ?? null,
          outcomeKey: r.outcomeKey ?? null,
          conditions: r.conditions ?? {},
          sampleSize: r.sampleSize ?? 0,
          effect: r.effect ?? null,
          confidence,
          recommendationTemplate: r.recommendationTemplate ?? null,
          evidence: r.evidence ?? {},
        });
        written += 1;
      }
    } catch (err) {
      console.warn(`[ri.learn] ${job.key} failed:`, err?.message);
    }
  }
  await recordRun(supabase, `learn:${cadence}`, workspaceId, { jobs: jobs.length, observations: written });
  return { jobs: jobs.length, observations: written };
}
