// Close the loop — turn the engine's grade of its own advice into the rank of its next
// advice. `recEffectiveness` (jobs/recEffectiveness.mjs) learns which rec CATEGORIES and
// CHANNELS actually convert; this reads that learned observation and turns it into a
// per-recommendation multiplier the matcher writes back onto each rec. That is the hop
// the audit called out as missing: the loop measured effectiveness but never fed it back
// into selection. Now it does.
//
// The discipline is the same honest-at-small-N rule the whole engine follows: below
// MIN_SAMPLE acted-on recs in a bucket, we do NOT re-weight — a thin sample must not
// move the worklist. A multiplier only appears once there is enough evidence to earn it.

import { MIN_SAMPLE } from './types.mjs';
import { REC_EFFECTIVENESS_KEY } from './jobs/recEffectiveness.mjs';

const STRONG_SAMPLE = MIN_SAMPLE * 2;   // suppression needs decisive evidence, not just enough
const SUPPRESS_RATIO = 0.35;            // a category converting at ≤35% of the overall rate is dropped
const MULT_MIN = 0.5;                   // never bury a rec more than 2x
const MULT_MAX = 2.0;                   // never float one more than 2x — keep the worklist legible

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Load the latest learned rec-effectiveness for a workspace as a fast lookup. Reads the
 * single `outbound.rec_effectiveness` observation and unpacks its evidence (overall rate
 * + per-category + per-channel conversion). `hasData` is false until there is an honest
 * overall sample, so a fresh workspace re-weights nothing.
 */
export async function loadEffectiveness(supabase, workspaceId) {
  const { data } = await supabase
    .from('ri_observations')
    .select('sample_size, effect, evidence')
    .eq('workspace_id', workspaceId)
    .eq('question_key', REC_EFFECTIVENESS_KEY)
    .maybeSingle();

  const ev = data?.evidence ?? {};
  const overallRate = Number(ev.overall_rate ?? data?.effect ?? 0);
  const total = Number(ev.total ?? data?.sample_size ?? 0);

  const toMap = (arr) => {
    const m = new Map();
    for (const r of arr ?? []) {
      m.set(String(r.key), {
        acted: Number(r.acted) || 0,
        converted: Number(r.converted) || 0,
        rate: Number(r.rate) || 0,
      });
    }
    return m;
  };

  return {
    hasData: total >= MIN_SAMPLE && overallRate > 0,
    overallRate,
    total,
    byCategory: toMap(ev.by_category),
    byChannel: toMap(ev.by_channel),
  };
}

/**
 * Score one recommendation draft against the learned effectiveness. Returns:
 *   priority      — the rank multiplier written to ri_recommendations.priority (1.0 = neutral)
 *   suppress      — true when this category converts so poorly, on strong sample, that the rec
 *                   should not be emitted at all (the matcher then lets it expire off the worklist)
 *   effectiveness — the reasoning, stored in evidence.effectiveness so the surface can explain
 *                   "prioritized because this category converts at X%"
 *
 * baseImpact (a deal $ value on some jobs) is intentionally NOT folded in — priority is a
 * pure effectiveness weight, orthogonal to impact_estimate.
 */
export function scoreRec({ category, channel } = {}, eff) {
  const neutral = (reason) => ({ priority: 1, suppress: false, effectiveness: { applied: false, reason } });
  if (!eff?.hasData) return neutral('no learned effectiveness yet');

  const cat = category != null ? eff.byCategory.get(String(category)) : null;
  const chan = channel != null ? eff.byChannel.get(String(channel)) : null;

  const catReady = cat && cat.acted >= MIN_SAMPLE;
  const chanReady = chan && chan.acted >= MIN_SAMPLE;
  if (!catReady && !chanReady) return neutral('not enough acted-on data for this category yet');

  // Multiplier is the product of the buckets we have honest data for, then clamped so no
  // single rec can dominate or vanish from the worklist.
  let multiplier = 1;
  if (catReady) multiplier *= clamp(cat.rate / eff.overallRate, MULT_MIN, MULT_MAX);
  if (chanReady) multiplier *= clamp(chan.rate / eff.overallRate, MULT_MIN, MULT_MAX);
  multiplier = clamp(multiplier, MULT_MIN, MULT_MAX);

  // Suppress only on decisive, well-sampled underperformance — this pulls a category off
  // the worklist, so the bar is deliberately high.
  const suppress = !!catReady && cat.acted >= STRONG_SAMPLE && cat.rate <= eff.overallRate * SUPPRESS_RATIO;

  return {
    priority: round4(multiplier),
    suppress,
    effectiveness: {
      applied: true,
      category: category ?? null,
      category_rate: catReady ? round4(cat.rate) : null,
      category_sample: cat?.acted ?? 0,
      channel: channel ?? null,
      channel_rate: chanReady ? round4(chan.rate) : null,
      overall_rate: round4(eff.overallRate),
      multiplier: round4(multiplier),
      suppressed: suppress,
    },
  };
}
