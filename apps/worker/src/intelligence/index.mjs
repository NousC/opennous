// Revenue Intelligence Engine — the cron entrypoints and the public surface.
//
// Phase 0 ships the substrate + the three runners + these entrypoints, wired into
// the worker's calibration chain but IDLE: the registries are empty, so every
// entrypoint returns before doing any work or spending anything. Phase 1 registers
// the first extractor + job (registerBuiltins below) and the engine lights up with
// zero further plumbing.

import { getSupabaseClient } from '@nous/core';
import { getExtractors, getJobs, registerExtractor, registerJob } from './registry.mjs';
import { runBehaviorExtractors } from './behaviors.mjs';
import { runLearningJobs } from './observations.mjs';
import { runRecommendations } from './recommendations.mjs';
import { dealStakeholderCount } from './jobs/stakeholderCount.mjs';
import { dealDaysSinceLastTouch } from './jobs/daysSinceLastTouch.mjs';
import { pipelineMultithreading } from './jobs/multithreading.mjs';
import { pipelineStall } from './jobs/stall.mjs';
import { campaignPerformance, outboundUnderperformer } from './jobs/outbound.mjs';
import { hygieneMissingValue, pipelineSingleEngaged } from './jobs/hygiene.mjs';
import { meetingQualification } from './jobs/meeting.mjs';
import { signalsBuying } from './jobs/signals.mjs';
import { journeyNoMeeting } from './jobs/journey.mjs';
import { playbookBuild } from './jobs/playbook.mjs';
import { leakageFitCold, leakageCooling } from './jobs/reengagement.mjs';
import { objectionMatcher } from './jobs/objectionMatcher.mjs';
import { objectionCoaching } from './jobs/objectionCoaching.mjs';
import { meetingCoaching } from './jobs/meetingCoaching.mjs';
import { speedToLead } from './jobs/speedToLead.mjs';
import { recEffectiveness } from './jobs/recEffectiveness.mjs';
import { decisionQuality } from './jobs/decisionQuality.mjs';
import { followUpPersistence } from './jobs/followUpPersistence.mjs';
import { reengagementWindow } from './jobs/reengagementWindow.mjs';
import { channelEffectiveness } from './jobs/channelPerContact.mjs';
import { cadenceGap } from './jobs/cadenceGap.mjs';
import { valuePropResonance } from './jobs/valuePropResonance.mjs';
import { resolveDecisionTraces, matureUnconfirmedDecisions, matureIgnoredDecisions } from './decisionTraces.mjs';

// The one place built-in behaviors and jobs are registered — the entire extension
// surface. Each new lens is a new file plus one line here.
export function registerBuiltins() {
  registerExtractor(dealStakeholderCount);     // deal.stakeholder_count
  registerExtractor(dealDaysSinceLastTouch);   // deal.days_since_last_touch
  registerExtractor(campaignPerformance);      // campaign.reply_rate / opportunity_rate
  registerJob(pipelineMultithreading);         // pipeline.multithreading (comparative)
  registerJob(pipelineStall);                  // pipeline.stall / leakage (deterministic)
  registerJob(outboundUnderperformer);         // outbound.underperformer (general recs)
  registerJob(hygieneMissingValue);            // hygiene.missing_value (deterministic)
  registerJob(pipelineSingleEngaged);          // pipeline.single_engaged (deterministic)
  registerJob(meetingQualification);           // meeting.qualification (coaching, claim-based)
  registerJob(signalsBuying);                  // signals.buying (buying-signal claims)
  registerJob(journeyNoMeeting);               // journey.no_meeting
  registerJob(leakageFitCold);                 // leakage.fit_cold (was the fit_cold flag)
  registerJob(leakageCooling);                 // leakage.cooling (was engagement_cooling)
  registerJob(playbookBuild);                  // playbook.build (curation, monthly)
  registerJob(objectionMatcher);               // objection.recurring (curation, weekly — battlecard + recs)
  registerJob(objectionCoaching);              // objection.response_coaching (trace-learning — reads OUR sent replies, learns the answer that wins)
  registerJob(meetingCoaching);                // meeting.coaching (content — reads OUR call transcripts, learns the on-call behavior that wins)
  registerJob(speedToLead);                    // outbound.speed_to_lead (correlational — response latency -> booked)
  registerJob(recEffectiveness);               // outbound.rec_effectiveness (trace-learning — which recs/channels convert)
  registerJob(decisionQuality);                // decision.quality (what to tell the next agent before it drafts)
  registerJob(followUpPersistence);            // outbound.follow_up_persistence (correlational — # follow-ups -> booked)
  registerJob(reengagementWindow);             // leakage.reengagement_window (correlational — quiet-gap -> revived, the deadline)
  registerJob(channelEffectiveness);           // outbound.channel_effectiveness (correlational — email vs LinkedIn response)
  registerJob(cadenceGap);                     // outbound.cadence_gap (correlational — touch spacing -> reply)
  registerJob(valuePropResonance);             // outbound.value_prop_resonance (content — which value props advance deals)
}
registerBuiltins();

async function workspaceIds(supabase) {
  const { data } = await supabase.from('workspaces').select('id');
  return (data ?? []).map((w) => w.id);
}

// Behavior extraction across all workspaces. No-op while no extractor is registered.
export async function runIntelligenceBehaviorsCron() {
  if (!getExtractors().length) return;
  const supabase = getSupabaseClient();
  for (const ws of await workspaceIds(supabase)) {
    try { await runBehaviorExtractors(supabase, ws); }
    catch (e) { console.warn('[ri] behaviors', ws, e?.message); }
  }
}

// Learning jobs for one cadence across all workspaces. No-op when none are due.
export async function runIntelligenceLearningCron(cadence) {
  if (!getJobs(cadence).length) return;
  const supabase = getSupabaseClient();
  for (const ws of await workspaceIds(supabase)) {
    try { await runLearningJobs(supabase, ws, cadence); }
    catch (e) { console.warn('[ri] learn', cadence, ws, e?.message); }
  }
}

// Recommendation matching across all workspaces. No-op while no job can recommend.
export async function runIntelligenceRecommendationsCron() {
  if (!getJobs().some((j) => typeof j.recommend === 'function')) return;
  const supabase = getSupabaseClient();
  for (const ws of await workspaceIds(supabase)) {
    try { await runRecommendations(supabase, ws); }
    catch (e) { console.warn('[ri] recs', ws, e?.message); }
  }
}

// Decision-trace resolution across all workspaces (Phase 2): turn rec-linked sends
// into traces and attribute the outcome that followed. Nightly.
export async function runDecisionTracesCron() {
  const supabase = getSupabaseClient();
  for (const ws of await workspaceIds(supabase)) {
    try { await resolveDecisionTraces(supabase, ws); await matureUnconfirmedDecisions(supabase, ws); await matureIgnoredDecisions(supabase, ws); }
    catch (e) { console.warn('[ri] traces', ws, e?.message); }
  }
}

// Run the full pipeline once for a single workspace — behaviors, then every learning
// cadence, then recommendations, then decision-trace resolution. Used for verification
// and backfill (not on a cron).
export async function runIntelligenceOnce(workspaceId) {
  const supabase = getSupabaseClient();
  const b = await runBehaviorExtractors(supabase, workspaceId);
  const l = [];
  for (const cadence of ['nightly', 'weekly', 'monthly']) l.push(await runLearningJobs(supabase, workspaceId, cadence));
  const r = await runRecommendations(supabase, workspaceId);
  const t = await resolveDecisionTraces(supabase, workspaceId);
  return { behaviors: b, learning: l, recommendations: r, traces: t };
}

// Re-exported so Phase 1 job files register through one import.
export { registerExtractor, registerJob, getExtractors, getJobs };
