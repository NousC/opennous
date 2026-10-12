// Recommendation effectiveness — the engine grading its OWN advice. It reads the
// decision traces (rec-linked actions + their outcomes) and learns which rec categories
// and which channels actually convert — so we know a re-engage rec beats a multithread
// rec, or that email responses book more than LinkedIn. A trace-learning job: it learns
// from what happened after our recommendations, not from the deal's attributes.

import { confidenceForSample } from '../types.mjs';

const KEY = 'outbound.rec_effectiveness';
// Exported so the recommendation matcher (effectiveness.mjs) reads this learned observation
// back and re-ranks the next round of recs by what actually converts. This is the closed loop.
export const REC_EFFECTIVENESS_KEY = KEY;
const MIN_TRACES = 8;   // below this, no honest conversion rate
const round4 = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${Math.round(n * 100)}%`;

const channelOf = (prop) =>
  String(prop ?? '').includes('linkedin') ? 'linkedin'
  : String(prop ?? '').includes('email') ? 'email'
  : 'other';

// A win is a positive reply or a meeting. Everything else the trace can resolve to —
// bounced, opted_out, objection, no_response — is a FAILURE, and now counts as such. This
// is the fix for the old `outcome != null` rule that scored an unsubscribe as a conversion.
const POSITIVE_OUTCOMES = new Set(['meeting', 'replied']);

/**
 * Summarize DECIDED traces into a learned observation — pure, so the conversion math is
 * testable without a database. `decided` is traces whose outcome has resolved (a pending,
 * too-soon-to-tell trace is excluded from the denominator so recent sends don't drag the
 * rate down). Rate = positive outcomes / decided.
 */
export function summarizeEffectiveness(decided, catById) {
  const byCat = new Map(), byChan = new Map(), byOutcome = new Map();
  const bump = (map, key, won) => { const v = map.get(key) ?? { n: 0, won: 0 }; v.n += 1; if (won) v.won += 1; map.set(key, v); };
  let won = 0;
  for (const t of decided) {
    const isWin = POSITIVE_OUTCOMES.has(t.outcome);
    if (isWin) won += 1;
    bump(byCat, catById.get(t.rec_id) || 'other', isWin);
    bump(byChan, channelOf(t.action_property), isWin);
    byOutcome.set(t.outcome, (byOutcome.get(t.outcome) ?? 0) + 1);
  }
  const total = decided.length;
  const shape = (map) => [...map].map(([k, v]) => ({ key: k, acted: v.n, converted: v.won, rate: round4(v.won / v.n) })).sort((a, b) => b.rate - a.rate);
  return {
    conditions: {},
    behaviorKey: 'recommendation',
    outcomeKey: 'converted',
    sampleSize: total,
    effect: round4(won / total),
    confidence: confidenceForSample(total),
    recommendationTemplate: `Of the recommendations that have resolved, ${pct(won / total)} led to a positive reply or a meeting.`,
    evidence: {
      total,
      converted: won,
      overall_rate: round4(won / total),
      by_category: shape(byCat),
      by_channel: shape(byChan),
      by_outcome: [...byOutcome].map(([k, n]) => ({ key: k, count: n })).sort((a, b) => b.count - a.count),
    },
  };
}

export const recEffectiveness = {
  key: KEY,
  category: 'outbound',
  type: 'correlational',
  cadence: 'weekly',
  question: 'Which of our recommendations actually convert — by category and by channel?',

  async learn(ctx) {
    const { data: traces } = await ctx.supabase.from('ri_decision_traces')
      .select('rec_id, action_property, outcome')
      .eq('workspace_id', ctx.workspaceId).not('rec_id', 'is', null)
      .limit(5000);

    // Only DECIDED traces count — a pending (too-soon) trace is not yet a win or a loss, so
    // it must not sit in the denominator. no_response resolution (decisionTraces.mjs) is what
    // matures a silent trace into a countable failure.
    const decided = (traces ?? []).filter((t) => t.outcome != null);
    if (decided.length < MIN_TRACES) return [];

    // The rec category behind each decided trace.
    const recIds = [...new Set(decided.map((t) => t.rec_id).filter(Boolean))];
    const catById = new Map();
    for (let i = 0; i < recIds.length; i += 200) {
      const { data: recs } = await ctx.supabase.from('ri_recommendations').select('id, category').in('id', recIds.slice(i, i + 200));
      for (const r of recs ?? []) catById.set(r.id, r.category);
    }

    return [summarizeEffectiveness(decided, catById)];
  },
  // No recommend() of its own — this is cross-cutting knowledge about our advice, so it
  // does not match to accounts. Instead the recommendation matcher consumes it (see
  // effectiveness.mjs): every job's drafts are re-ranked by this job's learned per-category
  // conversion, and decisively low-converting categories are suppressed. That is the hop
  // that closes the loop — outcomes now change which recs surface, not just a summary.
};
