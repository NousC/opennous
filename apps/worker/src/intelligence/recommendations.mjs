// The recommendation matcher. For each job, apply its recommend() step — which
// takes the job's active observations and matches them to live subjects (open
// deals, recent meetings, reps) — and persist the drafts. This is the generic
// plumbing every lens (leakage, coaching, deals-at-risk) shares; the job supplies
// the matching logic for its category.
//
// Nothing here fires an action. A recommendation is a suggestion the human acts on
// in Focus — the loop closes when they do and the outcome flows back into the graph.

import { getJobs } from './registry.mjs';
import { upsertRecommendation, expireStaleRecs, recordRun } from './db.mjs';
import { loadEffectiveness, scoreRec } from './effectiveness.mjs';

export async function runRecommendations(supabase, workspaceId) {
  const jobs = getJobs().filter((j) => typeof j.recommend === 'function');
  if (!jobs.length) return { jobs: 0, recommendations: 0 };

  // Close the loop: pull what we've LEARNED about which recs convert, and let it re-rank
  // (and suppress) what we recommend next. Neutral (no-op) until there is honest data.
  const eff = await loadEffectiveness(supabase, workspaceId);

  let written = 0;
  let expired = 0;
  let suppressed = 0;
  for (const job of jobs) {
    try {
      const ctx = { supabase, workspaceId, job };
      const drafts = (await job.recommend(ctx)) ?? [];
      const emitted = new Set();
      for (const d of drafts) {
        const category = d.category ?? job.category;
        const { priority, suppress, effectiveness } = scoreRec({ category, channel: d.channel }, eff);
        // A category that converts decisively worse than the rest (on strong sample) is not
        // ranked low — it is left out. Not adding it to `emitted` means expireStaleRecs below
        // pulls any existing open copy off the worklist. This is the loop learning to stop
        // recommending what does not work.
        if (suppress) { suppressed += 1; continue; }
        const id = await upsertRecommendation(supabase, workspaceId, {
          category,
          recKey: d.recKey ?? job.key,
          targetType: d.targetType,
          targetId: d.targetId,
          observationId: d.observationId ?? null,
          text: d.text,
          impactEstimate: d.impactEstimate ?? null,
          priority,
          evidence: effectiveness.applied ? { ...(d.evidence ?? {}), effectiveness } : (d.evidence ?? {}),
        });
        if (id) { written += 1; emitted.add(`${d.targetType}:${String(d.targetId)}`); }
      }
      // Only after a clean run of THIS job: close its open recs we no longer emit (or suppressed).
      expired += await expireStaleRecs(supabase, workspaceId, job.key, emitted);
    } catch (err) {
      console.warn(`[ri.recommend] ${job.key} failed:`, err?.message);
    }
  }
  await recordRun(supabase, 'recommendations', workspaceId, {
    jobs: jobs.length, recommendations: written, expired, suppressed, reweighted: eff.hasData,
  });
  return { jobs: jobs.length, recommendations: written, expired, suppressed };
}
