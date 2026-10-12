// The last two flag concepts, as engine lenses — so the engine covers 100% of what
// the legacy flag sweep does and the sweep can be retired.
//
//   leakage.fit_cold  — a strong-fit deal whose health is slipping (was the fit_cold flag)
//   leakage.cooling   — engagement dropping vs the month before (was engagement_cooling)
//
// Both deterministic (asserted rules, high confidence). fit-cold is health-based (not
// recency), so it does not collide with pipeline.stall which is quiet-based.

import { listDeals } from '../deals.mjs';
import { accountContext } from '../accountContext.mjs';
import { getActiveObservations } from '../db.mjs';

// ── leakage.fit_cold ──────────────────────────────────────────────────────────
const FC = 'leakage.fit_cold';
const FIT_FLOOR = 55;      // ICP fit that makes a deal worth saving
const HEALTH_CEIL = 50;    // deal health below which it's slipping

export const leakageFitCold = {
  key: FC, category: 'leakage', type: 'deterministic', cadence: 'nightly',
  question: 'Which strong-fit deals are slipping on health?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'deal.health', outcomeKey: 'closed_won',
      sampleSize: open.length, effect: HEALTH_CEIL, confidence: 'high',
      recommendationTemplate: 'A strong-fit deal with slipping health is worth saving.',
      evidence: { fit_floor: FIT_FLOOR, health_ceil: HEALTH_CEIL },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'leakage')).find((o) => o.question_key === FC);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId))
      .filter((d) => d.isOpen && d.name && d.icpScore != null && d.icpScore >= FIT_FLOOR && d.dealHealth != null && d.dealHealth < HEALTH_CEIL)
      .sort((a, b) => (a.dealHealth ?? 0) - (b.dealHealth ?? 0))
      .slice(0, 50);
    return deals.map((d) => ({
      category: 'leakage', recKey: FC, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
      text: `${d.name} is a strong fit (ICP ${d.icpScore}) but deal health is ${d.dealHealth} — a good fit slipping. Re-engage before it's lost.`,
      evidence: { icp: d.icpScore, health: d.dealHealth, stage: d.stage },
    }));
  },
};

// ── leakage.cooling ───────────────────────────────────────────────────────────
const CO = 'leakage.cooling';
const COOL_RATIO = 0.6;    // recent < 60% of prior = cooling

export const leakageCooling = {
  key: CO, category: 'leakage', type: 'deterministic', cadence: 'nightly',
  question: 'Which deals are cooling — engagement dropping vs the month before?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'account.engagement_trend', outcomeKey: 'closed_won',
      sampleSize: open.length, effect: COOL_RATIO, confidence: 'high',
      recommendationTemplate: 'Re-warm a deal before its engagement fully cools.',
      evidence: { cool_ratio: COOL_RATIO },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'leakage')).find((o) => o.question_key === CO);
    const accCtx = await accountContext(ctx.supabase, ctx.workspaceId);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.name);
    const out = [];
    for (const d of deals) {
      const a = accCtx.get(d.id);
      if (!a || a.recent <= 0 || a.prior <= 0) continue;         // need a real prior to compare against
      if (a.recent >= a.prior * COOL_RATIO) continue;            // not cooling
      out.push({
        category: 'leakage', recKey: CO, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
        text: `${d.name}'s engagement is cooling — ${a.recent} touch${a.recent === 1 ? '' : 'es'} in the last 30 days vs ${a.prior} the month before. Re-warm it.`,
        evidence: { recent: a.recent, prior: a.prior, stage: d.stage },
      });
    }
    return out.slice(0, 50);
  },
};
