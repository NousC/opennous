// The judged half of the extraction eval (GET-1048). Ported from hindsight-system-evals (MIT),
// judge.py: one criterion per question, a JSON verdict, and the voting rules below.
//
// WHY ANOTHER MODEL FAMILY. The extractor and its signal check both run on Claude (pipelineModel(),
// insightBoardModel()). A judge from the same family shares its blind spots and grades its own
// reading as correct, so the judge must come from another provider. judgeModelFor() refuses one
// that does not.
//
// THE RULES (from the issue):
//   - Traps first: a wrong fact is worse than a missing one. A trap counts as HIT only when it is
//     confirmed: a "met" verdict is asked once more (at 0.5), and both must say met. A false alarm costs a
//     re-run; a confirmed trap fails the case and its criteria are not asked (the case already failed).
//   - A must that fails at temperature 0 is asked twice more at 0.5, and the majority of the three wins.
//   - The reply is one JSON object {"meets_criteria": true|false, "reasoning": "..."}. Anything else
//     is a failing verdict: for a must, not met; for a trap, met (an unreadable answer is never
//     evidence that the output is safe), so it still has to survive the confirming ask.
//
// The `ask` function is injected: createModelJudge() wraps the model door, and the tests pass a fake.

export const JUDGE_SYSTEM = `You grade the output of a CRM fact extractor against ONE criterion.

You are given the source conversation the extractor read, and the claims it recorded, one per line:
- [category] claim text (tags) [date said] {person or account the claim is filed on}

Judge ONLY the criterion you are given. Ignore every other quality of the output, good or bad. Use only what the source and the claims say; do not assume anything that is not written there.

Reply with ONE JSON object and nothing else:
{"meets_criteria": true or false, "reasoning": "one or two sentences"}`;

/** The user turn for one criterion. A trap is phrased as the failure to look for. */
export function buildJudgePrompt({ criterion, kind, input, rendered }) {
  const question = kind === 'trap'
    ? `CRITERION (a FAILURE to look for): ${criterion}\n\nmeets_criteria is true if the recorded claims DO exhibit this failure, false if they do not.`
    : `CRITERION (what the output must do): ${criterion}\n\nmeets_criteria is true if the recorded claims satisfy it, false if they do not.`;
  return `SOURCE (${input.kind}, said ${input.saidAt}; account: ${input.account?.name}; people: ${(input.people ?? []).map(p => p.name).join(', ')}; our side, the seller: ${input.ourSide?.company} — ${(input.ourSide?.names ?? []).join(', ')}):
<<<
${input.text}
>>>

RECORDED CLAIMS:
${rendered}

${question}`;
}

/** One verdict from a reply: { meets: true|false|null, reasoning }. null means it was not one JSON
 *  object with a boolean meets_criteria; callers decide what that counts as. */
export function parseVerdict(text) {
  const raw = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');   // a fenced object is still one object
  let v = null;
  try { v = JSON.parse(raw); } catch { return { meets: null, reasoning: `not JSON: ${raw.slice(0, 200)}` }; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.meets_criteria !== 'boolean') {
    return { meets: null, reasoning: `no boolean meets_criteria: ${raw.slice(0, 200)}` };
  }
  return { meets: v.meets_criteria, reasoning: typeof v.reasoning === 'string' ? v.reasoning : '' };
}

/** A trap: asked at 0; a met (or unreadable) verdict is asked again, and is a hit only if confirmed. */
export async function judgeTrap(ask, args) {
  const first = await ask({ ...args, kind: 'trap', temperature: 0 });
  const verdicts = [first];
  if (first.meets === false) return { hit: false, verdicts };
  // At 0.5, so the confirmation is a second read and not the first one replayed.
  const second = await ask({ ...args, kind: 'trap', temperature: 0.5 });
  verdicts.push(second);
  return { hit: second.meets !== false, verdicts };
}

/** A must: asked at 0; a failing verdict is asked twice more at 0.5, and two of three decide. */
export async function judgeMust(ask, args) {
  const first = await ask({ ...args, kind: 'must', temperature: 0 });
  const verdicts = [first];
  if (first.meets === true) return { met: true, verdicts };
  for (let n = 0; n < 2; n++) verdicts.push(await ask({ ...args, kind: 'must', temperature: 0.5 }));
  const yes = verdicts.filter(v => v.meets === true).length;
  return { met: yes >= 2, verdicts };
}

/**
 * Judge one case's claims. Traps first; a confirmed trap fails the case without asking its musts.
 * @returns {{ pass: boolean, reasons: string[], traps: object[], musts: object[] }}
 */
export async function judgeCase(ask, c, rendered) {
  const base = { input: c.input, rendered };
  const reasons = [];
  const traps = [];
  for (const criterion of c.traps ?? []) {
    const r = await judgeTrap(ask, { ...base, criterion });
    traps.push({ criterion, ...r });
    if (r.hit) reasons.push(`trap hit: ${criterion} — ${r.verdicts.at(-1).reasoning}`);
  }
  const musts = [];
  if (!reasons.length) {
    for (const criterion of c.must ?? []) {
      const r = await judgeMust(ask, { ...base, criterion });
      musts.push({ criterion, ...r });
      if (!r.met) reasons.push(`must not met: ${criterion} — ${r.verdicts.at(-1).reasoning}`);
    }
  }
  return { pass: reasons.length === 0, reasons, traps, musts };
}

// ── The model judge ───────────────────────────────────────────────────────────────────────────

/** The provider family of a model id: "openai/gpt-4.1-mini" → openai, "claude-haiku-…" → anthropic. */
export function modelFamily(model) {
  const m = String(model ?? '').toLowerCase().trim();
  if (!m) return null;
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'anthropic';
  return m.includes('/') ? m.split('/')[0] : m.split(/[-:]/)[0];
}

// An OpenRouter id (it bills where the pipeline bills): cheap, follows a JSON-only instruction,
// and not a reasoning model, so temperature 0 means what it says.
export const DEFAULT_JUDGE_MODEL = 'openai/gpt-4.1-mini';

/** The judge's model: EVAL_JUDGE_MODEL, else the default. Throws when it shares a family with a
 *  model it would be grading. */
export function judgeModelFor({ graded = [], env = process.env } = {}) {
  const model = String(env.EVAL_JUDGE_MODEL || '').trim() || DEFAULT_JUDGE_MODEL;
  const fam = modelFamily(model);
  const clash = graded.filter(Boolean).find(m => modelFamily(m) === fam);
  if (clash) throw new Error(`judge ${model} is the same family as ${clash}, which it grades; set EVAL_JUDGE_MODEL to another provider's model`);
  return model;
}

/**
 * The real `ask`: one call through the model door per verdict. `createMessage` is the door's
 * (lib/llm.mjs), passed in so this module never loads a client. Usage is summed into `usage`.
 */
export function createModelJudge({ createMessage, model, usage = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 } }) {
  const ask = async ({ criterion, kind, input, rendered, temperature }) => {
    const msg = await createMessage({
      feature: 'eval-extraction-judge',
      model,
      fallback: false,       // a verdict from some other model is not this judge's verdict
      temperature,
      max_tokens: 400,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: buildJudgePrompt({ criterion, kind, input, rendered }) }],
    });
    usage.calls++;
    usage.input_tokens += msg.usage?.input_tokens ?? 0;
    usage.output_tokens += msg.usage?.output_tokens ?? 0;
    usage.cost_usd += typeof msg.cost_usd === 'number' ? msg.cost_usd : 0;
    const text = msg.content?.find?.(b => b.type === 'text')?.text ?? '';
    return { ...parseVerdict(text), temperature };
  };
  return { ask, usage, model };
}
