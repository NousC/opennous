// Decision quality — the engine learning about its own ADVICE, and saying it in a sentence
// the agent can act on (GET-70).
//
// recEffectiveness already asks which recommendation CATEGORIES convert, and writes a ranking
// back onto the worklist. This asks a different question: given everything we recommended and
// what the humans did with it, what should we tell the next agent before it drafts anything?
//
// Three patterns, because three are honestly available from ri_decisions today:
//
//   Rewrites   — advice that is consistently corrected before it goes out. The fastest signal
//                we have, because an edit lands at n=1 where an outcome needs volume.
//   Rejections — advice that gets turned down outright. Different from a rewrite: the angle
//                was wrong, not the wording.
//   Drop-off   — advice accepted and then never acted on. The intent-to-action gap. Usually
//                means we are proposing something bigger than the moment deserves.
//
// Everything here is written as a note to the next agent, not as a metric. A rule that reads
// like a dashboard tile gets ignored in a prompt.

import { confidenceForSample } from '../types.mjs';

const KEY = 'decision.quality';

// Stricter than the reporting floor on purpose. Showing a person a thin number they can
// interpret is fine; telling an agent to change how it writes is not.
const MIN_PER_CATEGORY = 30;

// How lopsided a pattern has to be before it is worth a line of the agent's context. Below
// this it is noise wearing a percentage.
const REWRITE_FLOOR = 0.5;
const REJECT_FLOOR = 0.3;
const DROPOFF_FLOOR = 0.3;

const pct = (n) => `${Math.round(n * 100)}%`;

/** The three rules a category's counts can justify. Returns at most one per shape. */
export function rulesFor(category, c) {
  const out = [];
  const label = category === 'uncategorized' ? 'recommendations' : `${category} recommendations`;

  // Rewrites, measured only over decisions where we could actually check (GET-68). An
  // unverified row cannot tell us whether the human changed anything, and counting it as
  // verbatim would let a broken input produce a confident "your drafts are perfect".
  if (c.verified >= MIN_PER_CATEGORY) {
    const rate = c.verified_edited / c.verified;
    if (rate >= REWRITE_FLOOR) {
      out.push({
        shape: 'rewrite',
        n: c.verified,
        text: `Drafts for ${label} are rewritten before sending ${pct(rate)} of the time. Write shorter and plainer than feels finished, and leave the specifics for the human to add.`,
      });
    }
  }

  if (c.total >= MIN_PER_CATEGORY) {
    const rejectRate = c.rejected / c.total;
    if (rejectRate >= REJECT_FLOOR) {
      out.push({
        shape: 'reject',
        n: c.total,
        text: `${pct(rejectRate)} of ${label} are turned down outright. The angle is landing wrong rather than the wording — check the account for a reason not to reach out before proposing one.`,
      });
    }

    // Only decisions that got as far as a yes can drop off, so the denominator is the ones
    // that were agreed to, not everything proposed.
    const agreed = c.confirmed + c.unconfirmed;
    if (agreed >= MIN_PER_CATEGORY) {
      const dropRate = c.unconfirmed / agreed;
      if (dropRate >= DROPOFF_FLOOR) {
        out.push({
          shape: 'dropoff',
          n: agreed,
          text: `${pct(dropRate)} of agreed ${label} never actually happen. Propose one smaller thing that can be done in the moment rather than the right thing that waits for a better day.`,
        });
      }
    }
  }
  return out;
}

export const decisionQuality = {
  key: KEY,
  category: 'decision',
  type: 'correlational',
  cadence: 'weekly',
  question: 'What should we tell the next agent about how its advice actually lands here?',

  async learn(ctx) {
    const { data: rows } = await ctx.supabase.from('ri_decisions')
      .select('category, verdict, status, edit_verified')
      .eq('workspace_id', ctx.workspaceId)
      .limit(5000);
    if (!rows?.length) return [];

    const byCat = new Map();
    for (const d of rows) {
      const k = d.category || 'uncategorized';
      if (!byCat.has(k)) byCat.set(k, { total: 0, rejected: 0, confirmed: 0, unconfirmed: 0, verified: 0, verified_edited: 0 });
      const c = byCat.get(k);
      c.total += 1;
      if (d.verdict === 'rejected') c.rejected += 1;
      if (d.status === 'confirmed') c.confirmed += 1;
      else if (d.status === 'unconfirmed') c.unconfirmed += 1;
      if (d.edit_verified) {
        c.verified += 1;
        if (d.verdict === 'edited') c.verified_edited += 1;
      }
    }

    const observations = [];
    for (const [category, c] of byCat) {
      for (const rule of rulesFor(category, c)) {
        const confidence = confidenceForSample(rule.n);
        // The engine refuses to emit what it cannot stand behind. An instruction lands in the
        // agent's context as a rule of the house, so a hedged version of a weak finding is
        // worse than silence — the hedge is the first thing a model drops.
        if (confidence === 'learning' || confidence === 'low') continue;
        observations.push({
          question_key: `${KEY}:${rule.shape}:${category}`,
          category: 'decision',
          job_type: 'correlational',
          behavior_key: `decision.${rule.shape}`,
          outcome_key: 'decision.verdict',
          conditions: { category },
          sample_size: rule.n,
          effect: null,
          confidence,
          status: 'active',
          recommendation_template: rule.text,
          evidence: { shape: rule.shape, counts: c },
        });
      }
    }
    return observations;
  },
};
