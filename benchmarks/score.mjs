// score.mjs
//
// Heuristic scorers for v0. Simple, transparent string and set matching against
// planted ground truth. This is deliberately mechanical so the numbers are
// reproducible and auditable.
//
// NOTE: open-ended answers (for example task 4, a drafted email) want an LLM-judge
// with a published rubric, scored blind to which arm produced the answer. That is
// the phase-2 upgrade. For v0 we only score tasks with a clean ground truth
// (identity, buried fact, focus set, consistency) using the helpers below.

// Normalize text for loose substring matching: lowercase, collapse whitespace.
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// setOverlap: how many of the expected names appear (as substrings) in gotText.
// Returns { hits, total, score (0..1), matched, missed }.
export function setOverlap(expected, gotText) {
  const hay = norm(gotText);
  const matched = [];
  const missed = [];
  for (const name of expected) {
    // Match on the name, tolerant of case and surrounding punctuation.
    if (hay.includes(norm(name))) matched.push(name);
    else missed.push(name);
  }
  const total = expected.length;
  const hits = matched.length;
  return { hits, total, score: total === 0 ? 0 : hits / total, matched, missed };
}

// containsFact: do ALL required substrings appear in gotText?
// Used for the buried-fact task. factSubstrings are ANDed: the answer must hit
// every one to count as surfacing the fact. Returns { passed, matched, missed }.
export function containsFact(factSubstrings, gotText) {
  const hay = norm(gotText);
  const matched = [];
  const missed = [];
  for (const sub of factSubstrings) {
    if (hay.includes(norm(sub))) matched.push(sub);
    else missed.push(sub);
  }
  return { passed: missed.length === 0, matched, missed };
}

// countDistinct: given an array of answer texts, extract a canonical "focus set"
// signature from each and count how many DISTINCT signatures appear.
// 1 means perfectly consistent across repeats.
//
// signatureFn maps an answer text to a comparable, order-independent key. If not
// provided, the raw normalized text is used (a blunt fallback).
export function countDistinct(answers, signatureFn) {
  const sigs = answers.map((a) => (signatureFn ? signatureFn(a) : norm(a)));
  const distinct = new Set(sigs);
  return { distinct: distinct.size, total: answers.length, signatures: sigs };
}

// focusSignature: an order-independent signature of which of the candidate focus
// account names a given answer mentions. Used by the consistency task so that
// "Acme, Globex, Pied Piper" and "Pied Piper, Acme, Globex" count as the same set.
export function focusSignature(candidateNames, answerText) {
  const hay = norm(answerText);
  const present = candidateNames.filter((n) => hay.includes(norm(n)));
  return present.map((n) => norm(n)).sort().join('|');
}
