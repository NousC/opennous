// llm-judge.mjs
//
// The phase-2 scoring upgrade: a blind, rubric-based LLM judge for OPEN-ENDED answers
// (a drafted email, a written recommendation) where set/substring scoring can't tell a
// good answer from a lucky one. Three properties make it credible:
//
//   1. Published rubric. Each criterion is a fixed, disclosed yes/no question — no vibes.
//   2. Absolute, not comparative. Each answer is graded on its own against the rubric, so
//      the judge is never shown the other arm's answer.
//   3. Blind to the arm. judgeAnswer() is never told which arm produced the text. The
//      caller scores each arm's answer with the same call and the same rubric; the judge
//      cannot favour "the graph" because it does not know which one it is reading.
//
// buildJudgePrompt() and parseVerdict() are PURE so the dry-run can validate the rubric
// plumbing (does the parser separate a passing verdict from a failing one) with canned
// judge output and no network — the same discipline the heuristic scorers already follow.

import Anthropic from '@anthropic-ai/sdk';

// A capable, FIXED judge model so grading quality stays constant even when the ARM model
// is varied with --model. Override with --judge-model=<id> if needed.
export const JUDGE_MODEL = 'claude-sonnet-5';

const PASS_THRESHOLD = 0.67; // fraction of rubric criteria that must be met to "pass"

const JUDGE_SYSTEM =
  'You are an impartial grader. You score a single answer against a fixed rubric of yes/no ' +
  'criteria. Judge ONLY what the answer actually says — do not reward intent, do not invent ' +
  'facts it did not state, do not penalise style. Return strict JSON and nothing else.';

/** Pure: build the judge user prompt from the question, the answer under test, and the rubric. */
export function buildJudgePrompt(question, answer, rubric) {
  const criteria = rubric
    .map((c, i) => `${i + 1}. key="${c.key}" — ${c.description}`)
    .join('\n');
  return (
    `The task that was asked:\n${question}\n\n` +
    `The answer to grade (author unknown — grade it on its own merits):\n"""\n${answer}\n"""\n\n` +
    `Rubric — for EACH criterion decide met=true only if the answer clearly satisfies it:\n${criteria}\n\n` +
    `Return strict JSON, no prose, no code fences:\n` +
    `{"criteria":[{"key":"<key>","met":true|false,"why":"<short reason>"}],"summary":"<one sentence>"}`
  );
}

/**
 * Pure: parse a judge response against the rubric. Robust to the model wrapping JSON in
 * prose or fences. Only rubric keys count; a key the judge omitted is treated as not met.
 * Returns { score (0..1), passed, met, total, criteria, detail }.
 */
export function parseVerdict(text, rubric) {
  const parsed = extractJson(text);
  const byKey = new Map();
  for (const c of parsed?.criteria ?? []) {
    if (c && typeof c.key === 'string') byKey.set(c.key, { met: c.met === true, why: c.why ?? '' });
  }
  const criteria = rubric.map((c) => {
    const v = byKey.get(c.key);
    return { key: c.key, met: v?.met === true, why: v?.why ?? '' };
  });
  const total = rubric.length;
  const met = criteria.filter((c) => c.met).length;
  const score = total === 0 ? 0 : met / total;
  const missed = criteria.filter((c) => !c.met).map((c) => c.key);
  const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';
  return {
    score,
    passed: score >= PASS_THRESHOLD,
    met,
    total,
    criteria,
    detail: `${met}/${total} rubric criteria met${missed.length ? ` (missed: ${missed.join(', ')})` : ''}${summary ? ` — ${summary}` : ''}`,
  };
}

/** Find and parse the first balanced JSON object in a string; null if none parses. */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Grade one answer with the model. Blind by construction: receives only the question, the
 * answer text, and the rubric — never the arm name. Returns the parsed verdict.
 */
export async function judgeAnswer({ question, answer, rubric, model = JUDGE_MODEL, apiKey }) {
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 512,
    temperature: 0,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: buildJudgePrompt(question, answer, rubric) }],
  });
  const text = (resp.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return parseVerdict(text, rubric);
}
