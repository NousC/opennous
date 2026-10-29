// Lift: which account attributes actually predicted a win here.
//
// Arithmetic, not a model. For every feature we compute P(won | feature) against the base
// rate, with a confidence interval, and report how many deals are behind it. That last number
// is the one that matters most: at 40 closed deals almost nothing will be significant, and a
// scorecard that says so is the thing that makes its confident lines believable.
//
// Weight of evidence is what credit scoring uses, for our reasons exactly: small samples, and
// a hard requirement to be able to say WHY. A gradient-boosted model on 40 deals would overfit
// on contact, and no rep can be told "78, because the model says so".
//
// Nothing here writes to the scoring model. This is the instrument you read BEFORE deciding
// whether to fit anything to it.

import { pageAll } from './pageAll.mjs';
import { getSupabaseClient } from '@nous/core';

/**
 * Wilson score interval for a binomial proportion.
 *
 * Not the normal approximation, which is wrong in exactly the situation we are always in:
 * few trials and a proportion near 0 or 1. Three wins out of three under the normal formula
 * is "100%, ±0" — a certainty conjured from three data points. Wilson gives (0.44, 1.0),
 * which is the honest reading, and it is what stops this page inventing findings.
 */
function wilson(successes, trials, z = 1.96) {
  if (!trials) return { lo: 0, hi: 1, p: 0 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return {
    p,
    lo: Math.max(0, (centre - spread) / denom),
    hi: Math.min(1, (centre + spread) / denom),
  };
}

// ── Fisher's exact test ─────────────────────────────────────────────────────
//
// The right test for a 2×2 table with small counts, which is the only kind we will ever have.
// A chi-square or two-proportion z-test needs expected cell counts around 5+; at "0 wins from
// 4 enterprise deals" they are simply wrong, and wrong in the confident direction.
//
// Computed in log space so factorials of a few thousand don't overflow.

const LN_FACT_CACHE = [0, 0];
function lnFactorial(n) {
  if (n < 2) return 0;
  for (let i = LN_FACT_CACHE.length; i <= n; i++) LN_FACT_CACHE[i] = LN_FACT_CACHE[i - 1] + Math.log(i);
  return LN_FACT_CACHE[n];
}

/** Probability of exactly this table under the null, hypergeometric. */
function lnHypergeom(a, b, c, d) {
  const n = a + b + c + d;
  return lnFactorial(a + b) + lnFactorial(c + d) + lnFactorial(a + c) + lnFactorial(b + d)
       - lnFactorial(n) - lnFactorial(a) - lnFactorial(b) - lnFactorial(c) - lnFactorial(d);
}

/**
 * Two-sided Fisher's exact p: the total probability of every table at least as extreme as the
 * one observed. `a` = won with the feature, `b` = lost with it, `c` = won without, `d` =
 * lost without.
 */
function fisherExact(a, b, c, d) {
  const rowA = a + b, rowB = c + d, colA = a + c, colB = b + d;
  const n = rowA + rowB;
  if (!n || !rowA || !rowB || !colA || !colB) return 1;
  const observed = lnHypergeom(a, b, c, d);
  const lo = Math.max(0, colA - rowB);
  const hi = Math.min(rowA, colA);
  let p = 0;
  // A tiny tolerance, because two tables that are equally extreme differ in the last bits of
  // a float and dropping one of them biases the p downward.
  const tol = 1e-9;
  for (let x = lo; x <= hi; x++) {
    const lp = lnHypergeom(x, rowA - x, colA - x, rowB - (colA - x));
    if (lp <= observed + tol) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/**
 * Benjamini–Hochberg false-discovery-rate control.
 *
 * The correction this instrument cannot do without. Testing ~40 features at p<0.05 produces
 * two false positives by chance ALONE — which is exactly how many "significant" findings the
 * first real run produced. Without this, the page is a random-finding generator that happens
 * to be dressed as statistics, and the first thing anyone would do with it is rewrite their
 * ICP around noise.
 *
 * BH rather than Bonferroni because Bonferroni at 40 tests would demand p<0.00125, which no
 * workspace with 12 deals can ever reach — it would trade false findings for no findings.
 * BH controls the PROPORTION of findings that are false, which is the question actually being
 * asked: "of the lines you are showing me, how many are junk?"
 */
function benjaminiHochberg(pValues, fdr = 0.10) {
  const m = pValues.length;
  if (!m) return { threshold: 0, expectedFalse: 0 };
  const sorted = [...pValues].sort((x, y) => x - y);
  let threshold = 0, k = 0;
  for (let i = 0; i < m; i++) {
    if (sorted[i] <= ((i + 1) / m) * fdr) { threshold = sorted[i]; k = i + 1; }
  }
  return { threshold, expectedFalse: Math.round(k * fdr * 10) / 10 };
}

/**
 * The evidence table for one workspace.
 *
 * `no_decision` deals are excluded from the win rate but counted separately: a deal nobody
 * decided on failed differently from one lost to a competitor, and treating indecision as
 * rejection is how a model learns to avoid the accounts that simply took a while.
 */
export async function icpEvidence(workspaceId, {
  supabase = getSupabaseClient(),
  minDeals = 3,      // a feature seen fewer times than this is an anecdote
} = {}) {
  // Paged (GET-270): `.limit(20000)` is silently 1,000 rows from PostgREST, so a workspace with
  // thousands of closed deals trained its evidence on an arbitrary fifth of them.
  const rows = await pageAll(() => supabase
    .from('deal_outcomes')
    .select('id, outcome, features_at, value_usd, closed_at')
    .eq('workspace_id', workspaceId)
    .order('id', { ascending: true }));

  const decided = (rows ?? []).filter(r => r.outcome === 'won' || r.outcome === 'lost');
  const undecided = (rows ?? []).filter(r => r.outcome === 'no_decision');

  const total = decided.length;
  const wonTotal = decided.filter(r => r.outcome === 'won').length;
  const baseRate = total ? wonTotal / total : 0;

  // Every (feature, value) pair that appears, with its win count.
  //
  // `measured` is the other half and the one that keeps this honest: for each FEATURE, how many
  // deals carried it at all. A deal whose feature is absent was not measured — it is not a deal
  // that scored `no`. The ledger now omits meeting and email features for deals it cannot place
  // in time (GET-353), and without a per-feature denominator every one of those omissions would
  // land on the negative side of the test, which is the same lie one level up.
  const counts = new Map();
  const measured = new Map();
  for (const r of decided) {
    const f = r.features_at ?? {};
    for (const [k, v] of Object.entries(f)) {
      if (v === null || v === undefined || v === '') continue;
      const key = `${k}=${v}`;
      const e = counts.get(key) ?? { feature: k, value: String(v), deals: 0, won: 0 };
      e.deals += 1;
      if (r.outcome === 'won') e.won += 1;
      counts.set(key, e);
      const m = measured.get(k) ?? { deals: 0, won: 0 };
      m.deals += 1;
      if (r.outcome === 'won') m.won += 1;
      measured.set(k, m);
    }
  }

  const tested = [...counts.values()].filter(e => e.deals >= minDeals);

  // One Fisher test per feature, against the deals that DON'T have it.
  const scored = tested.map(e => {
    const ci = wilson(e.won, e.deals);
    // Compared against the deals where this feature WAS measured and took another value — not
    // against every deal in the dataset, most of which may never have been asked the question.
    const m = measured.get(e.feature) ?? { deals: total, won: wonTotal };
    const withoutDeals = m.deals - e.deals;
    const withoutWon = m.won - e.won;
    const p = fisherExact(e.won, e.deals - e.won, withoutWon, withoutDeals - withoutWon);
    // Lift is against the cohort's own base rate for the same reason.
    const featureBase = m.deals > 0 ? m.won / m.deals : 0;
    return { ...e, ci, p, measured: m.deals, lift: featureBase > 0 ? ci.p / featureBase : null };
  });

  // The correction. Testing forty features at p<0.05 yields two false positives by chance
  // alone — which is precisely how many "findings" the uncorrected version produced on its
  // first real run. Everything below reads off `fdr_significant`, never the raw p.
  const { threshold, expectedFalse } = benjaminiHochberg(scored.map(f => f.p), 0.10);

  const features = scored
    .map(e => {
      const fdrSignificant = threshold > 0 && e.p <= threshold;
      return {
        feature: e.feature,
        value: e.value,
        deals: e.deals,
        won: e.won,
        // How many decided deals could be asked this question at all. A feature measured on 1,156
        // of 5,425 deals is a real finding about a quarter of the data, and saying so is the
        // difference between a coverage statement and a claim about the customer's business.
        measured: e.measured,
        win_rate: Number(e.ci.p.toFixed(3)),
        ci_low: Number(e.ci.lo.toFixed(3)),
        ci_high: Number(e.ci.hi.toFixed(3)),
        lift: e.lift === null ? null : Number(e.lift.toFixed(2)),
        p_value: Number(e.p.toFixed(4)),
        // Survived the multiple-comparisons correction. This is the only flag a consumer
        // should ever branch on.
        fdr_significant: fdrSignificant,
        // Whether it may be turned into a WEIGHT, which is a higher bar than being real:
        // a true finding on a dataset too thin to fit a model is still a finding you cannot
        // fit a model on. Keeping these apart is what stops "significant" being read as
        // "safe to act on".
        // Against the cohort that carried the feature, not the whole dataset.
        fittable: fdrSignificant && e.measured >= 60 && e.deals >= 8,
      };
    })
    .sort((a, b) =>
      (b.fdr_significant - a.fdr_significant)
      || a.p_value - b.p_value
      || b.deals - a.deals);

  // The verdict on the dataset itself, so a caller never has to invent one. Under ~20 decided
  // deals no scorecard fitted here would mean anything, and saying that is the point.
  const strength = total >= 60 ? 'good' : total >= 20 ? 'thin' : 'insufficient';

  return {
    deals: {
      decided: total,
      won: wonTotal,
      lost: total - wonTotal,
      no_decision: undecided.length,
      base_win_rate: Number(baseRate.toFixed(3)),
    },
    strength,
    // What a caller should DO with it, in one line, rather than each caller re-deriving it.
    verdict:
      strength === 'good'
        ? 'Enough decided deals to fit weights on the features marked fittable.'
        : strength === 'thin'
          ? 'Enough to read as a signal, not enough to fit a model on. Treat as a prior, not a finding.'
          : 'Too few decided deals for any of this to mean anything yet. Report the count, not the pattern.',
    // Both numbers, because they answer different questions: how many lines survived the
    // correction, and how many of those we still expect to be junk.
    significant: features.filter(f => f.fdr_significant).length,
    fittable: features.filter(f => f.fittable).length,
    expected_false_positives: expectedFalse,
    tested: features.length,
    features,
  };
}
