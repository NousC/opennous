// The ICP model as prior and posterior, never as a switch.
//
// A new workspace has no closed deals, so its scoring model is built from its website: what
// the company says about itself. That is the honest answer on day one and it has to keep
// working, because "we can't score anything until you've closed sixty deals" is useless to
// someone who just signed up.
//
// The wrong way to improve on it is a fallback with a switch — you run on the website version
// until one day you flip to the "real" one. That fails twice. It makes the website version
// feel like a placeholder nobody should trust, and it makes the changeover a cliff: the day
// the sixtieth deal closes every score jumps and the team stops believing the number.
//
// So: one score, always, and what changes is where it comes from. The website ICP is the
// PRIOR. Deal evidence updates it. For a feature with prior weight w0 and n deals of evidence
// behind an observed weight ŵ:
//
//     w = (k·w0 + n·ŵ) / (k + n)
//
// `k` is a pseudo-count — how many deals of evidence the prior is worth. At k=15: nothing
// moves at 3 deals, things shift at 30, evidence dominates by 100, and a feature nobody has
// closed against (n=0) keeps the prior untouched. No cliff, and the provenance of every score
// is a number rather than a claim.

import { getSupabaseClient, listSignals } from '@nous/core';
import { icpEvidence } from './icpEvidence.mjs';

// How many closed deals the website-derived prior is worth. Chosen so a workspace's first
// dozen deals inform without overturning: at n=12 the posterior is still ~55% prior, which is
// the right amount of humility for twelve coin flips.
export const PSEUDO_COUNT = 15;

/** The feature/value a signal's rule actually tests, in the ledger's vocabulary. */
function featureKeyOf(signal) {
  const r = signal?.rule ?? {};
  const feature = String(r.feature ?? '').trim();
  if (!feature) return null;
  // The ledger stores bucketed, normalised values (`employee_range=50-199`); a rule may hold
  // a scalar, a list, or a range. Only an exact single value can be matched to a feature —
  // anything else is a rule the evidence has no opinion about, and guessing a match would put
  // a number behind a comparison nobody made.
  const v = r.value;
  if (v === null || v === undefined || Array.isArray(v) || typeof v === 'object') return null;
  const norm = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return `${feature.replace(/^icp\./, '')}=${norm}`;
}

/**
 * Blend the current (prior) scorecard with whatever the closed deals say.
 *
 * Idempotent and non-destructive by design:
 *  - a MANUAL signal is never touched. A human set that weight deliberately, and quietly
 *    moving it is how a person stops trusting the whole model.
 *  - a feature the evidence has never seen keeps its prior weight exactly (n = 0).
 *  - only features that survived the FDR correction contribute at all. An uncorrected
 *    "finding" across forty tests is noise, and shrinking toward noise is worse than not
 *    shrinking.
 */
export async function blendScorecardWithEvidence(workspaceId, {
  supabase = getSupabaseClient(),
  pseudoCount = PSEUDO_COUNT,
  dryRun = false,
} = {}) {
  const prior = await listSignals(supabase, workspaceId);
  if (!prior.length) {
    return { status: 'no_prior', note: 'Nothing to blend into — seed the scorecard from the website first.' };
  }

  const evidence = await icpEvidence(workspaceId, { supabase, minDeals: 2 });
  const decided = evidence.deals.decided;

  // Only corrected findings are allowed to move a weight. Everything else is the shape of a
  // small sample, and this function exists precisely so that small samples don't get to
  // rewrite the model.
  const real = new Map();
  for (const f of evidence.features) {
    if (!f.fdr_significant) continue;
    real.set(`${f.feature}=${String(f.value).toLowerCase()}`, f);
  }

  if (!real.size) {
    return {
      status: 'prior_only',
      decided_deals: decided,
      strength: evidence.strength,
      // Said plainly, because "we didn't change anything" needs a reason attached or it reads
      // as a failure rather than as the model declining to guess.
      note: decided
        ? `${decided} decided deal${decided === 1 ? '' : 's'} so far, none of it strong enough to move a weight. Scoring stays on the website-derived model.`
        : 'No closed deals yet. Scoring runs on the website-derived model, which is what it is for.',
      signals: prior.length,
      prior_share: 1,
    };
  }

  // The scale the prior is written on, so an evidence-implied weight is comparable rather than
  // an absolute number invented here.
  const maxWeight = Math.max(...prior.map(s => Math.abs(Number(s.weight) || 0)), 5);

  let evidenceMass = 0, totalMass = 0;
  // Only the rows whose weight actually changes. Writing the whole set back through
  // seedSignals would be wrong twice over: it DELETES seed-origin rows and re-inserts them,
  // dropping `manual` and `added_in` in the process — so a hand-set weight and a
  // learning-loop weight would both come back as fresh seed rows. A targeted update touches
  // one column and nothing else.
  const updates = [];

  const blended = prior.map(s => {
    const w0 = Number(s.weight) || 0;
    totalMass += Math.abs(w0) || 1;

    if (s.manual) return s;                       // a human's number stays a human's number
    const key = featureKeyOf(s);
    const f = key ? real.get(key) : null;
    if (!f) return s;                             // untested here → n = 0 → w = w0

    // Lift → a weight on the prior's own scale. lift 2 is "twice the base rate" and earns a
    // full positive weight; lift 0 earns a full negative one; lift 1 says the feature does
    // not discriminate, and the honest evidence weight for that is zero.
    const observed = Math.max(-maxWeight, Math.min(maxWeight, maxWeight * ((f.lift ?? 1) - 1)));
    const n = f.deals;
    const w = (pseudoCount * w0 + n * observed) / (pseudoCount + n);
    const rounded = Math.round(w);
    if (rounded !== w0) updates.push({ id: s.id, key: s.key, from: w0, to: rounded, deals: n, lift: f.lift });
    evidenceMass += (Math.abs(w0) || 1) * (n / (pseudoCount + n));

    return { ...s, weight: rounded };
  });

  if (!dryRun) {
    for (const u of updates) {
      const { error } = await supabase
        .from('scorecard_signals').update({ weight: u.to, updated_at: new Date().toISOString() })
        .eq('id', u.id).eq('workspace_id', workspaceId);
      // One weight failing to move must not abort the rest — a half-blended model is still a
      // coherent model, where a thrown error mid-loop leaves nobody knowing what applied.
      if (error) console.error('[ICP_BLEND] weight update failed', u.key, error.message);
    }
  }

  // What share of this model now comes from deals rather than from the website. This is the
  // number that goes on a score's provenance line, so "based on your site + 12 deals" is a
  // measurement rather than a claim.
  const evidenceShare = totalMass ? Number((evidenceMass / totalMass).toFixed(3)) : 0;

  return {
    status: dryRun ? 'preview' : 'blended',
    decided_deals: decided,
    strength: evidence.strength,
    findings: real.size,
    signals: blended.length,
    weights_moved: updates.length,
    // The actual moves, so a preview is reviewable rather than a count to be trusted.
    moves: updates.slice(0, 40),
    evidence_share: evidenceShare,
    prior_share: Number((1 - evidenceShare).toFixed(3)),
    pseudo_count: pseudoCount,
  };
}

/**
 * One line a person can read, and the agent can say out loud. Provenance stated on the score
 * is the same rule the ICP document follows: a model that doesn't say where it came from is
 * one nobody can argue with.
 */
export function provenanceLine(result) {
  if (!result || result.status === 'no_prior') return 'No scoring model yet.';
  if (result.status === 'prior_only') {
    return result.decided_deals
      ? `Scored from your website. ${result.decided_deals} closed deals so far — not yet enough to change a weight.`
      : 'Scored from your website, until deals start closing.';
  }
  const pct = Math.round((result.evidence_share ?? 0) * 100);
  return `Scored from your website and ${result.decided_deals} closed deals — about ${pct}% of the model now comes from what actually closed.`;
}
