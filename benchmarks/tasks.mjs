// tasks.mjs
//
// The task suite. Each task is one prompt run against both arms, scored against
// planted ground truth. These are the "fair fights" from the spec: both arms can
// attempt them, and we measure the gap.
//
// A task is:
//   { id, prompt, repeats, metric, score(answerText, armName) -> { passed|score, detail } }
//
// score() is pure and mechanical (see score.mjs). For the consistency task the
// scoring happens across the whole set of repeats, so t5 exposes scoreSet() that
// run.mjs calls with all K answers for an arm.

import { GROUND_TRUTH } from './fixture.mjs';
import { setOverlap, containsFact, countDistinct, focusSignature } from './score.mjs';

// A superset of candidate account names the consistency task watches for, so a
// distinct-set signature is meaningful (not just the 3 correct ones).
const FOCUS_CANDIDATES = [
  'Acme Corp',
  'Globex',
  'Pied Piper',
  'Initech',
  'Cyberdyne Systems',
  'Hooli',
  'Massive Dynamic',
  'Umbrella Analytics',
];

export const TASKS = [
  {
    id: 't1_full_account',
    prompt: 'Give me the complete picture of Acme Corp.',
    repeats: 1,
    metric: 'coverage + tokens',
    // Coverage: did the answer surface the buried fact (CFO owns budget, >$50k needs sign-off)?
    score(answerText /*, armName */) {
      const fact = containsFact(GROUND_TRUTH.acmeBuriedFact.factSubstrings, answerText);
      return {
        passed: fact.passed,
        detail: fact.passed
          ? 'surfaced the buried fact (CFO / $50k sign-off)'
          : `missed buried fact, matched ${JSON.stringify(fact.matched)}, missing ${JSON.stringify(fact.missed)}`,
      };
    },
  },

  {
    id: 't2_who_to_focus',
    prompt: 'Which 3 accounts should I prioritize today, and why? Name them explicitly.',
    repeats: 1,
    metric: 'decision quality (set overlap)',
    // Decision quality: overlap between named accounts and the planted focus set.
    score(answerText /*, armName */) {
      const overlap = setOverlap(GROUND_TRUTH.focusAccounts, answerText);
      return {
        score: overlap.score,
        detail: `matched ${overlap.hits}/${overlap.total} focus accounts (${overlap.matched.join(', ') || 'none'}); missed ${overlap.missed.join(', ') || 'none'}`,
      };
    },
  },

  {
    id: 't3_identity',
    prompt:
      'What do we know about Sarah Chen? Is she one person or several distinct people? List the identifiers and sources.',
    repeats: 1,
    metric: 'coverage / accuracy',
    // Accuracy: did the answer conclude ONE person AND reference the three identifiers?
    score(answerText /*, armName */) {
      const hay = String(answerText || '').toLowerCase();
      // "one person" signal: says one / single / same person, and does NOT primarily
      // claim they are several. Heuristic: presence of a one-person phrase.
      const saysOne =
        /\bone person\b/.test(hay) ||
        /\bsingle person\b/.test(hay) ||
        /\bsame person\b/.test(hay) ||
        /\bone individual\b/.test(hay);
      const idOverlap = setOverlap(GROUND_TRUTH.identity.identifiers, answerText);
      // Pass if it says one person and references at least 2 of the 3 identifiers.
      const passed = saysOne && idOverlap.hits >= 2;
      return {
        passed,
        detail: `${saysOne ? 'concluded one person' : 'did NOT clearly conclude one person'}; identifiers matched ${idOverlap.hits}/${idOverlap.total}`,
      };
    },
  },

  {
    id: 't5_consistency',
    // Reuses t2's prompt, run K times per arm.
    prompt: 'Which 3 accounts should I prioritize today, and why? Name them explicitly.',
    repeats: 5,
    metric: 'consistency (distinct focus-sets, 1 = perfectly consistent)',
    // Per-answer scoring is not the point here; the metric is across the repeats.
    // run.mjs calls scoreSet() with all K answers for one arm.
    score() {
      return { detail: 'consistency is scored across all repeats via scoreSet()' };
    },
    scoreSet(answerTexts /*, armName */) {
      const sig = (t) => focusSignature(FOCUS_CANDIDATES, t);
      const { distinct, total, signatures } = countDistinct(answerTexts, sig);
      return {
        distinctSets: distinct,
        repeats: total,
        // Lower is better; 1 = identical every run.
        score: distinct,
        detail: `${distinct} distinct focus-set(s) across ${total} runs`,
        signatures,
      };
    },
  },
];
