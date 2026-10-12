// Job: meeting.qualification (category meeting) — the coaching lens, built from the
// claims we ALREADY extract (pain, timeline, budget, authority), NOT fresh transcript
// LLM calls. An advanced deal that hasn't qualified the essentials gets flagged. This
// is the recommendation half of meeting intelligence; the credit-spending coaching
// brief is deliberately not built yet.

import { listDeals } from '../deals.mjs';
import { accountContext } from '../accountContext.mjs';
import { getActiveObservations } from '../db.mjs';
import { STAGE_RANK } from '@nous/core';

const KEY = 'meeting.qualification';
const DISCOVERY = STAGE_RANK.discovery ?? 4;
// The essentials a winning deal establishes, and the human phrasing for each.
const QUAL = [['pain', 'the pain'], ['timeline', 'a timeline'], ['budget', 'budget'], ['authority', 'a decision-maker']];

export const meetingQualification = {
  key: KEY, category: 'meeting', type: 'deterministic', cadence: 'nightly',
  question: 'Which advanced deals have not qualified pain, timeline, budget, and authority?',
  async learn(ctx) {
    const open = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.rank >= DISCOVERY);
    if (!open.length) return [];
    return [{
      conditions: {}, behaviorKey: 'deal.qualification', outcomeKey: 'closed_won',
      sampleSize: open.length, effect: null, confidence: 'high',
      recommendationTemplate: 'Winning deals qualify pain, timeline, budget and a decision-maker.',
      evidence: { open_sample: open.length },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'meeting')).find((o) => o.question_key === KEY);
    const accCtx = await accountContext(ctx.supabase, ctx.workspaceId);
    const deals = (await listDeals(ctx.supabase, ctx.workspaceId)).filter((d) => d.isOpen && d.name && d.rank >= DISCOVERY);
    const out = [];
    for (const d of deals) {
      const cats = accCtx.get(d.id)?.categories ?? new Set();
      const missing = QUAL.filter(([k]) => !cats.has(k)).map(([, label]) => label);
      if (missing.length < 2) continue;                 // only surface a real qualification gap
      const list = missing.length === 2
        ? `${missing[0]} and ${missing[1]}`
        : `${missing.slice(0, -1).join(', ')}, and ${missing[missing.length - 1]}`;
      out.push({
        category: 'meeting', recKey: KEY, targetType: 'deal', targetId: d.id, observationId: obs?.id ?? null,
        text: `${d.name} is in ${d.stage.replace(/_/g, ' ')} but ${list} haven't come up. Qualify these before it advances.`,
        evidence: { missing, stage: d.stage },
      });
    }
    return out.slice(0, 50);
  },
};
