// Job: pipeline.multithreading (comparative) — do more stakeholders win more deals?
//
// LEARN: the workspace's own won-deal average stakeholder count = the baseline.
//   Gated on how many won deals we have (comparative jobs are honest at any N, but a
//   baseline off 2 wins is weak, so confidence tracks the won sample).
// RECOMMEND: every open deal below the baseline (or single-threaded, when we don't
//   have enough wins yet to trust a baseline) gets a "add a decision-maker" rec, with
//   the evidence attached. Small-N falls back to the seeded global prior — never a
//   fabricated number.

import { listDeals } from '../deals.mjs';
import { getActiveObservations, getPrior } from '../db.mjs';
import { confidenceForSample } from '../types.mjs';

const KEY = 'pipeline.multithreading';
const round1 = (n) => Math.round(n * 10) / 10;

export const pipelineMultithreading = {
  key: KEY,
  category: 'pipeline',
  type: 'comparative',
  cadence: 'nightly',
  question: 'Do deals with more stakeholders win more often?',

  async learn(ctx) {
    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    if (!deals.length) return [];                 // no pipeline here — nothing to learn
    const won = deals.filter((d) => d.isWon);
    const open = deals.filter((d) => d.isOpen);
    if (!won.length) {
      // Nothing won yet — record the question as still learning, no fabricated effect.
      return [{
        conditions: {}, behaviorKey: 'deal.stakeholder_count', outcomeKey: 'closed_won',
        sampleSize: 0, effect: null, confidence: 'learning',
        evidence: { won_sample: 0, open_sample: open.length },
        recommendationTemplate: 'Multithreaded deals win more often.',
      }];
    }
    const baseline = round1(won.reduce((s, d) => s + d.stakeholderCount, 0) / won.length);
    return [{
      conditions: {}, behaviorKey: 'deal.stakeholder_count', outcomeKey: 'closed_won',
      sampleSize: won.length, effect: baseline, confidence: confidenceForSample(won.length),
      evidence: { won_sample: won.length, won_avg: baseline, open_sample: open.length },
      recommendationTemplate: `Your won deals averaged ${baseline} stakeholders.`,
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'pipeline'))
      .find((o) => o.question_key === KEY);
    const prior = active ? null : await getPrior(ctx.supabase, KEY);
    const baseline = active?.effect ?? prior?.effect ?? 3;         // won-avg, or the seeded prior
    const threshold = Math.max(2, Math.round(baseline));           // recommend below this; min = single-threaded
    const observationId = active?.id ?? null;

    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    const under = deals.filter((d) => d.isOpen && d.name && d.stakeholderCount < threshold)
      .sort((a, b) => (b.dealValue ?? 0) - (a.dealValue ?? 0) || b.rank - a.rank)  // biggest at stake, then furthest-along
      .slice(0, 50);

    return under.map((d) => {
      const state = d.stakeholderCount <= 1
        ? `is single-threaded (1 stakeholder)`
        : `has only ${d.stakeholderCount} stakeholders`;
      return {
      category: 'pipeline', recKey: KEY, targetType: 'deal', targetId: d.id,
      observationId, impactEstimate: d.dealValue ?? null,
      text: active
        ? `${d.name} ${state}. Your won deals averaged ${round1(baseline)}. Add another decision-maker.`
        : `${d.name} ${state}. Multithreaded deals win more often — bring in another decision-maker.`,
      impactEstimate: null,
      evidence: {
        stakeholder_count: d.stakeholderCount, baseline: round1(baseline), stage: d.stage,
        source: active ? 'workspace_wons' : 'gtm_prior', won_sample: active?.sample_size ?? null,
      },
      };
    });
  },
};
