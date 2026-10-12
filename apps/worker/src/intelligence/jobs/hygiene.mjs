// Two more lenses, both deterministic rules over the deal view (cheap, no extra
// queries): CRM hygiene (an advanced deal with no value) and activation (a deal with
// several known contacts but only one still active). Deterministic jobs assert their
// rule, so the observation is always active at high confidence — like a flag.

import { listDeals } from '../deals.mjs';
import { getActiveObservations } from '../db.mjs';
import { STAGE_RANK } from '@nous/core';

const DISCOVERY = STAGE_RANK.discovery ?? 4;

// ── hygiene.missing_value ─────────────────────────────────────────────────────
const MV = 'hygiene.missing_value';
export const hygieneMissingValue = {
  key: MV, category: 'hygiene', type: 'deterministic', cadence: 'nightly',
  question: 'Which advanced deals have no deal value set?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.rank >= DISCOVERY);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'deal.value', outcomeKey: 'hygiene',
      sampleSize: open.length, effect: null, confidence: 'high',
      recommendationTemplate: 'Advanced deals should carry a deal value so they forecast.',
      evidence: { open_sample: open.length },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'hygiene')).find((o) => o.question_key === MV);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId))
      .filter((d) => d.isOpen && d.name && d.rank >= DISCOVERY && (d.dealValue == null || d.dealValue <= 0))
      .slice(0, 50);
    return deals.map((d) => ({
      category: 'hygiene', recKey: MV, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
      text: `${d.name} is in ${d.stage.replace(/_/g, ' ')} with no deal value set. Add the deal size so it forecasts.`,
      evidence: { stage: d.stage },
    }));
  },
};

// ── pipeline.single_engaged ───────────────────────────────────────────────────
const SE = 'pipeline.single_engaged';
export const pipelineSingleEngaged = {
  key: SE, category: 'pipeline', type: 'deterministic', cadence: 'nightly',
  question: 'Which deals have several known contacts but only one is still active?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'deal.engaged_count', outcomeKey: 'activation',
      sampleSize: open.length, effect: null, confidence: 'high',
      recommendationTemplate: 'Keep more than one contact active on a live deal.',
      evidence: { open_sample: open.length },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'pipeline')).find((o) => o.question_key === SE);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId))
      .filter((d) => d.isOpen && d.name && d.stakeholderCount >= 3 && d.engagedCount <= 1)
      .sort((a, b) => b.stakeholderCount - a.stakeholderCount)
      .slice(0, 50);
    return deals.map((d) => ({
      category: 'pipeline', recKey: SE, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
      text: `${d.name} has ${d.stakeholderCount} contacts but only ${d.engagedCount} still active. Re-engage the others before it goes quiet.`,
      evidence: { total: d.stakeholderCount, engaged: d.engagedCount, stage: d.stage },
    }));
  },
};
