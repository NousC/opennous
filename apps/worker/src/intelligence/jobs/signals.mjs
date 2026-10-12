// Job: signals.buying (category signals) — accounts showing buying signals right now.
// Reads the buying_signal claims we already extract, aggregated to the account. This
// is the engine's generalization of the buying_signal flag (the eventual replacement).

import { listDeals } from '../deals.mjs';
import { accountContext } from '../accountContext.mjs';
import { getActiveObservations } from '../db.mjs';

const KEY = 'signals.buying';

export const signalsBuying = {
  key: KEY, category: 'signals', type: 'deterministic', cadence: 'nightly',
  question: 'Which accounts are showing buying signals right now?',
  async learn(ctx) {
    const acc = await accountContext(ctx.supabase, ctx.workspaceId);
    let withSignals = 0;
    for (const v of acc.values()) if (v.buyingSignals > 0) withSignals += 1;
    return [{
      conditions: {}, behaviorKey: 'account.buying_signals', outcomeKey: 'intent',
      sampleSize: acc.size, effect: withSignals, confidence: 'high',
      recommendationTemplate: 'Accounts showing buying signals should be contacted now.',
      evidence: { accounts_with_signals: withSignals },
    }];
  },
  async recommend(ctx) {
    const obs = (await getActiveObservations(ctx.supabase, ctx.workspaceId, 'signals')).find((o) => o.question_key === KEY);
    const acc = await accountContext(ctx.supabase, ctx.workspaceId);
    const byId = new Map((await listDeals(ctx.supabase, ctx.workspaceId)).map((d) => [d.id, d]));
    const out = [];
    for (const [cid, v] of acc) {
      if (v.buyingSignals <= 0) continue;
      const d = byId.get(cid);
      if (!d || !d.name || d.isWon) continue;
      out.push({
        category: 'signals', recKey: KEY, targetType: 'deal', targetId: cid, observationId: obs?.id ?? null,
        text: `${d.name} is showing ${v.buyingSignals} buying signal${v.buyingSignals === 1 ? '' : 's'} — reach out now while it's warm.`,
        evidence: { buying_signals: v.buyingSignals, stage: d.stage },
      });
    }
    return out.slice(0, 50);
  },
};
