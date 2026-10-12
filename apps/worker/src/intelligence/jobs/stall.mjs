// Job: pipeline.stall (deterministic, category leakage) — an in-motion deal that
// has gone quiet is leaking. This is a rule we assert (not a learned correlation),
// so it is always active at high confidence, like a flag. Revenue leakage in the
// engine is simply: behaviors negatively tied to progress, projected onto open
// pipeline.

import { listDeals, fmtMoney } from '../deals.mjs';
import { getActiveObservations } from '../db.mjs';

const KEY = 'pipeline.stall';
const THRESHOLD = 10; // days without a customer touch on a deal past first contact

export const pipelineStall = {
  key: KEY,
  category: 'leakage',
  type: 'deterministic',
  cadence: 'nightly',
  question: 'Which in-motion deals have gone quiet and are at risk of stalling?',

  async learn(ctx) {
    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    const open = deals.filter((d) => d.isOpen);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'deal.days_since_last_touch', outcomeKey: 'stall_risk',
      sampleSize: open.length, effect: THRESHOLD, confidence: 'high',
      recommendationTemplate: `Open deals quiet more than ${THRESHOLD} days are at stall risk.`,
      evidence: { threshold: THRESHOLD, open_sample: open.length },
    }];
  },

  async recommend(ctx) {
    const active = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'leakage'))
      .find((o) => o.question_key === KEY);
    const observationId = active?.id ?? null;

    const deals = await listDeals(ctx.supabase, ctx.workspaceId);
    const stalled = deals
      .filter((d) => d.isOpen && d.name && d.daysSinceLastTouch != null && d.daysSinceLastTouch > THRESHOLD)
      .sort((a, b) => (b.dealValue ?? 0) - (a.dealValue ?? 0) || (b.daysSinceLastTouch ?? 0) - (a.daysSinceLastTouch ?? 0))
      .slice(0, 50);

    return stalled.map((d) => {
      const money = fmtMoney(d.dealValue);
      return {
        category: 'leakage', recKey: KEY, targetType: 'deal', targetId: d.id, observationId,
        text: `${d.name} has gone ${d.daysSinceLastTouch} days without a customer touch${money ? ` (${money} at risk)` : ''}. High stall risk — schedule a follow-up.`,
        impactEstimate: d.dealValue ?? null,
        evidence: { days_quiet: d.daysSinceLastTouch, threshold: THRESHOLD, stage: d.stage, deal_value: d.dealValue ?? null },
      };
    });
  },
};
