// Job: journey.no_meeting (category journey) — a deal that advanced without a real
// conversation. With the touch data we have (meetings, email), the strongest journey
// gap is an advanced-stage deal that has never had a meeting held. When richer path
// data lands (web, LinkedIn) this category widens to full path analysis.

import { listDeals } from '../deals.mjs';
import { accountContext } from '../accountContext.mjs';
import { getActiveObservations } from '../db.mjs';
import { STAGE_RANK } from '@nous/core';

const KEY = 'journey.no_meeting';
const DISCOVERY = STAGE_RANK.discovery ?? 4;

export const journeyNoMeeting = {
  key: KEY, category: 'journey', type: 'deterministic', cadence: 'nightly',
  question: 'Which advanced deals have progressed without a real meeting?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.rank >= DISCOVERY);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'account.meetings_held', outcomeKey: 'closed_won',
      sampleSize: open.length, effect: null, confidence: 'high',
      recommendationTemplate: 'A deal should have a real conversation before it advances.',
      evidence: { open_sample: open.length },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'journey')).find((o) => o.question_key === KEY);
    const accCtx = await accountContext(ctx.supabase, ctx.workspaceId);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.name && d.rank >= DISCOVERY);
    const out = [];
    for (const d of deals) {
      if ((accCtx.get(d.id)?.meetings ?? 0) > 0) continue;
      out.push({
        category: 'journey', recKey: KEY, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
        text: `${d.name} reached ${d.stage.replace(/_/g, ' ')} but no meeting has happened yet. Book the conversation before it stalls.`,
        evidence: { meetings: 0, stage: d.stage },
      });
    }
    return out.slice(0, 50);
  },
};
