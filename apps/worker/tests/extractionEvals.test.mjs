// The extraction eval harness (GET-1048): its deterministic parts, and the runner with a fake
// extractor and a fake judge. No network and no keys: the one test that drives the real read
// (extract.mjs) does it through a registered fake Anthropic client and the in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  CASE_CATEGORIES, validateCase, loadCases, selectCases, renderClaim, renderClaims, deterministicChecks, allowedYears, oursExpectProblems, oursProblems,
} from '../evals/extraction/checks.mjs';
import { parseVerdict, judgeTrap, judgeMust, judgeCase, modelFamily, judgeModelFor, buildJudgePrompt, createModelJudge } from '../evals/extraction/judge.mjs';
import { runEval, parseArgs, summaryLines } from '../evals/extraction/run.mjs';
import { scrubProductionEnv } from '../evals/extraction/safeEnv.mjs';

const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../evals/extraction/cases');

const OUR = { company: 'Corvane', names: ['Theo Bramwell'], offer: 'Corvane turns a sales team\'s calls and emails into account intelligence on every record.' };
const aCase = (over = {}) => ({
  id: 'demo-case', category: 'selectivity', origin: 'A test case.',
  input: { kind: 'email', saidAt: '2026-10-14', account: { name: 'Brindle' }, people: [{ name: 'Ines Halloran' }], ourSide: OUR, text: 'Thursday works for me, see you then. Ines' },
  must: [], traps: [], expect: { maxClaims: 0 },
  ...over,
});
const claim = (over = {}) => ({ category: 'tech_stack', content: 'Brindle runs support on Tallyhook.', subject: { kind: 'account', name: 'Brindle' }, saidAt: '2026-10-14', tags: { tool: 'Tallyhook' }, ...over });

// ── the shipped cases ───────────────────────────────────────────────────────────────────────

test('every shipped case is valid, and the set covers each category with a minimum subset', async () => {
  const cases = await loadCases(CASES_DIR);
  assert.ok(cases.length >= 20 && cases.length <= 37, `${cases.length} cases`);   // 34: + four our-side cases (GET-1052); 37: + three cause-link cases (GET-1053)
  for (const cat of CASE_CATEGORIES) assert.ok(cases.some(c => c.category === cat), `no ${cat} case`);
  const minimum = cases.filter(c => c.minimum);
  assert.ok(minimum.length >= 5 && minimum.length <= 8, `${minimum.length} minimum cases`);
  // The minimum set is what runs before a prompt change merges: one per category at least.
  for (const cat of CASE_CATEGORIES) assert.ok(minimum.some(c => c.category === cat), `no minimum ${cat} case`);
});

// ── case shape ──────────────────────────────────────────────────────────────────────────────

test('validateCase accepts a well-formed case', () => {
  assert.deepEqual(validateCase(aCase()), []);
});

test('validateCase names what is wrong', () => {
  const has = (c, re) => assert.ok(validateCase(c).some(e => re.test(e)), `${JSON.stringify(validateCase(c))} lacks ${re}`);
  has(aCase({ maxClaim: 0 }), /unknown key "maxClaim"/);
  has(aCase({ category: 'vibes' }), /category must be one of/);
  has(aCase({ origin: '' }), /origin/);
  has(aCase({ id: 'Bad Id' }), /id must be/);
  has(aCase({ minimum: 'yes' }), /minimum must be/);
  has(aCase({ input: { ...aCase().input, saidAt: 'last tuesday' } }), /saidAt/);
  has(aCase({ input: { ...aCase().input, kind: 'sms' } }), /kind/);
  has(aCase({ input: { ...aCase().input, text: 'hi' } }), /at least 20/);
  has(aCase({ input: { ...aCase().input, people: [{ name: 'A B' }, { name: 'C D' }] } }), /exactly one person/);
  has(aCase({ input: { ...aCase().input, ourSide: { names: [] } } }), /ourSide/);
  has(aCase({ expect: { maxClaims: -1 } }), /maxClaims/);
  has(aCase({ expect: { categories: ['competitors'] } }), /unknown claim category "competitors"/);
  has(aCase({ expect: { maxClaims: 0, contains: ['x'] } }), /contradicts/);
  has(aCase({ expect: { contains: [1] } }), /contains must be/);
  has(aCase({ expect: { tolerance: 1 } }), /unknown expect key/);
  has(aCase({ must: [''] }), /must must be an array/);
  has(aCase({ expect: {} }), /at least one must, trap or expect/);
});

test('selectCases: --minimum keeps the minimum cases, --case picks one, an unknown id throws', () => {
  const cases = [aCase({ id: 'a', minimum: true }), aCase({ id: 'b' })];
  assert.deepEqual(selectCases(cases, { minimum: true }).map(c => c.id), ['a']);
  assert.deepEqual(selectCases(cases, {}).map(c => c.id), ['a', 'b']);
  assert.deepEqual(selectCases(cases, { caseId: 'b', minimum: true }).map(c => c.id), ['b']);
  assert.throws(() => selectCases(cases, { caseId: 'zzz' }), /no case with id "zzz"/);
});

// ── rendering ───────────────────────────────────────────────────────────────────────────────

test('renderClaim: category, text, tags, said date, and the record it lands on', () => {
  assert.equal(renderClaim(claim()), '- [tech_stack] Brindle runs support on Tallyhook. (tool=Tallyhook) [2026-10-14] {account: Brindle}');
  assert.equal(
    renderClaim(claim({ category: 'competitor', content: 'Ines Halloran is trialling Lanternly.', subject: { kind: 'person', name: 'Ines Halloran' }, tags: { stance: 'evaluating', entity: 'Lanternly' } })),
    '- [competitor] Ines Halloran is trialling Lanternly. (entity=Lanternly; stance=evaluating) [2026-10-14] {person: Ines Halloran}',
  );
  assert.equal(renderClaim(claim({ tags: {}, saidAt: null, subject: { kind: 'person', name: null } })), '- [tech_stack] Brindle runs support on Tallyhook. [undated] {unattributed}');
  assert.equal(renderClaims([]), '(no claims were recorded)');
  assert.equal(renderClaims([claim(), claim()]).split('\n').length, 2);
});

// ── deterministic checks ────────────────────────────────────────────────────────────────────

test('deterministicChecks: a clean set passes', () => {
  const c = aCase({ expect: { maxClaims: 2, categories: ['tech_stack'], notCategories: ['competitor'], contains: ['tallyhook'] } });
  assert.deepEqual(deterministicChecks([claim()], c), { pass: true, reasons: [] });
});

test('deterministicChecks: every failing check is reported, not just the first', () => {
  const c = aCase({ expect: { maxClaims: 0, notCategories: ['tech_stack'] } });
  const r = deterministicChecks([claim(), claim()], c);
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /maxClaims: 2 claim\(s\), at most 0/);
  assert.match(r.reasons[1], /notCategories: 2 \[tech_stack\]/);
});

test('deterministicChecks: categories present, and contains with alternatives, tags included', () => {
  const c = aCase({ expect: { categories: ['competitor'], contains: [['Lanternly', 'lanternly.io'], 'Pipmate'] } });
  const r = deterministicChecks([claim()], c);
  assert.deepEqual(r.reasons, [
    'categories: no [competitor] claim',
    'contains: no claim mentions "Lanternly" or "lanternly.io"',
    'contains: no claim mentions "Pipmate"',
  ]);
  // A tag value counts: the competitor's entity is what the competitor board shows.
  const tagged = claim({ category: 'competitor', content: 'Ines Halloran is trialling a call tool.', tags: { entity: 'Lanternly' } });
  assert.deepEqual(deterministicChecks([tagged], aCase({ expect: { contains: ['lanternly'] } })).reasons, []);
});

test('placeholder-year check: a year the text never gave, far from the said date, fails', () => {
  const c = aCase({ input: { ...aCase().input, saidAt: '2026-10-14', text: 'We want it live next quarter, the 2019 contract ends then.' }, expect: {} });
  assert.deepEqual([...allowedYears(c.input)].sort(), ['2019', '2025', '2026', '2027']);
  assert.equal(deterministicChecks([claim({ content: 'Brindle wants it live by Q1 2027.' })], c).pass, true);
  assert.equal(deterministicChecks([claim({ content: 'Their 2019 contract ends next quarter.' })], c).pass, true);
  const stale = deterministicChecks([claim({ content: 'Brindle wants it live by Q1 2024.' })], c);
  assert.equal(stale.pass, false);
  assert.match(stale.reasons[0], /year 2024 is neither in the text nor near the said date/);
  assert.match(deterministicChecks([claim({ content: 'Renewal is due in 20XX.' })], c).reasons[0], /placeholder date/);
  assert.match(deterministicChecks([claim({ content: 'Decision on [date].' })], c).reasons[0], /placeholder date/);
});

// ── the judge ───────────────────────────────────────────────────────────────────────────────

test('parseVerdict: one JSON object with a boolean, else null (a failing verdict)', () => {
  assert.deepEqual(parseVerdict('{"meets_criteria": true, "reasoning": "yes"}'), { meets: true, reasoning: 'yes' });
  assert.deepEqual(parseVerdict('```json\n{"meets_criteria": false, "reasoning": "no"}\n```'), { meets: false, reasoning: 'no' });
  assert.equal(parseVerdict('I think it does.').meets, null);
  assert.equal(parseVerdict('{"meets_criteria": "true"}').meets, null);
  assert.equal(parseVerdict('[{"meets_criteria": true}]').meets, null);
  assert.equal(parseVerdict('').meets, null);
});

/** A fake judge that answers from a script, recording every question it was asked. */
function scripted(answers) {
  const asked = [];
  const ask = async (args) => {
    asked.push({ kind: args.kind, criterion: args.criterion, temperature: args.temperature });
    const next = answers.length ? answers.shift() : false;
    return { meets: next, reasoning: `said ${next}` };
  };
  return { ask, asked };
}

test('judgeTrap: a "not met" stands; a "met" is a hit only when the second read confirms it', async () => {
  let j = scripted([false]);
  assert.equal((await judgeTrap(j.ask, { criterion: 't' })).hit, false);
  assert.deepEqual(j.asked.map(a => a.temperature), [0]);

  j = scripted([true, false]);
  assert.equal((await judgeTrap(j.ask, { criterion: 't' })).hit, false, 'an unconfirmed trap is a false alarm');
  assert.deepEqual(j.asked.map(a => a.temperature), [0, 0.5]);

  j = scripted([true, true]);
  assert.equal((await judgeTrap(j.ask, { criterion: 't' })).hit, true);

  // An unreadable answer is never evidence that the output is safe.
  j = scripted([null, null]);
  assert.equal((await judgeTrap(j.ask, { criterion: 't' })).hit, true);
  assert.ok(j.asked.every(a => a.kind === 'trap'));
});

test('judgeMust: a pass at 0 stands; a fail is asked twice more at 0.5 and two of three decide', async () => {
  let j = scripted([true]);
  assert.equal((await judgeMust(j.ask, { criterion: 'm' })).met, true);
  assert.equal(j.asked.length, 1);

  j = scripted([false, true, true]);
  assert.equal((await judgeMust(j.ask, { criterion: 'm' })).met, true);
  assert.deepEqual(j.asked.map(a => a.temperature), [0, 0.5, 0.5]);

  j = scripted([false, true, false]);
  assert.equal((await judgeMust(j.ask, { criterion: 'm' })).met, false);

  // Non-JSON is a failing verdict for a must.
  j = scripted([null, true, null]);
  assert.equal((await judgeMust(j.ask, { criterion: 'm' })).met, false);
});

test('judgeCase: traps are judged first, and a confirmed trap fails the case without asking its musts', async () => {
  const c = aCase({ traps: ['wrong fact'], must: ['right fact'], expect: {} });
  let j = scripted([true, true]);
  let r = await judgeCase(j.ask, c, '(no claims were recorded)');
  assert.equal(r.pass, false);
  assert.match(r.reasons[0], /^trap hit: wrong fact/);
  assert.deepEqual(j.asked.map(a => a.kind), ['trap', 'trap']);
  assert.deepEqual(r.musts, []);

  j = scripted([false, true]);
  r = await judgeCase(j.ask, c, '(no claims were recorded)');
  assert.equal(r.pass, true);
  assert.deepEqual(j.asked.map(a => `${a.kind}:${a.criterion}`), ['trap:wrong fact', 'must:right fact']);
});

test('the judge prompt carries the source, the rendered claims and one criterion', () => {
  const c = aCase();
  const p = buildJudgePrompt({ criterion: 'No claim names Lanternly.', kind: 'trap', input: c.input, rendered: '- [competitor] x [2026-10-14] {account: Brindle}' });
  assert.match(p, /Thursday works for me/);
  assert.match(p, /- \[competitor\] x/);
  assert.match(p, /a FAILURE to look for\): No claim names Lanternly\./);
  assert.match(p, /said 2026-10-14/);
});

test('createModelJudge: temperature 0 through the door, no fallback model, usage summed', async () => {
  const calls = [];
  const createMessage = async (p) => {
    calls.push(p);
    return { content: [{ type: 'text', text: '{"meets_criteria": true, "reasoning": "ok"}' }], usage: { input_tokens: 100, output_tokens: 9 }, cost_usd: 0.001 };
  };
  const judge = createModelJudge({ createMessage, model: 'openai/gpt-4.1-mini' });
  const v = await judge.ask({ criterion: 'c', kind: 'must', input: aCase().input, rendered: '(no claims were recorded)', temperature: 0 });
  assert.equal(v.meets, true);
  assert.equal(calls[0].temperature, 0);
  assert.equal(calls[0].fallback, false);
  assert.equal(calls[0].model, 'openai/gpt-4.1-mini');
  assert.match(calls[0].system, /Judge ONLY the criterion/);
  assert.deepEqual(judge.usage, { calls: 1, input_tokens: 100, output_tokens: 9, cost_usd: 0.001 });
});

test('the judge is never the family it grades', () => {
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'anthropic');
  assert.equal(modelFamily('anthropic/claude-haiku-4.5'), 'anthropic');
  assert.equal(modelFamily('openai/gpt-4.1-mini'), 'openai');
  assert.equal(modelFamily('z-ai/glm-5.2'), 'z-ai');
  assert.equal(judgeModelFor({ graded: ['claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4.5'], env: {} }), 'z-ai/glm-5.2');
  // The default never grades the extractor's own family (deepseek) or the check pass's (anthropic).
  assert.equal(judgeModelFor({ graded: ['deepseek/deepseek-v4.1-flash', 'anthropic/claude-haiku-4.5'], env: {} }), 'z-ai/glm-5.2');
  assert.equal(judgeModelFor({ graded: ['claude-haiku-4-5-20251001'], env: { EVAL_JUDGE_MODEL: 'google/gemini-2.5-flash' } }), 'google/gemini-2.5-flash');
  assert.throws(() => judgeModelFor({ graded: ['claude-haiku-4-5-20251001'], env: { EVAL_JUDGE_MODEL: 'anthropic/claude-sonnet-4.5' } }), /same family/);
});

// ── the runner ──────────────────────────────────────────────────────────────────────────────

test('parseArgs: the three flags, and nothing else', () => {
  assert.deepEqual(parseArgs([]), { minimum: false, caseId: null, out: null });
  assert.deepEqual(parseArgs(['--minimum', '--out', 'r.json']), { minimum: true, caseId: null, out: 'r.json' });
  assert.deepEqual(parseArgs(['--case', 'sel-small-talk-meeting']), { minimum: false, caseId: 'sel-small-talk-meeting', out: null });
  assert.throws(() => parseArgs(['--minimun']), /unknown argument/);
  assert.throws(() => parseArgs(['--case']), /needs a value/);
});

test('runEval with a fake extractor and judge: checks first, then the judge, scored by category', async () => {
  const cases = [
    aCase({ id: 'quiet', expect: { maxClaims: 0 } }),                                                    // passes on checks alone
    aCase({ id: 'padded', expect: { maxClaims: 0 }, traps: ['never asked'] }),                           // fails on checks: judge skipped
    aCase({ id: 'judged', category: 'category', expect: { notCategories: ['competitor'] }, traps: ['t'], must: ['m'] }),
    aCase({ id: 'trapped', category: 'category', expect: {}, traps: ['t'] }),
    aCase({ id: 'broken', category: 'temporal', expect: { maxClaims: 0 } }),                              // the extractor throws
  ];
  const outputs = { quiet: [], padded: [claim()], judged: [claim()], trapped: [claim()] };
  const extract = async (c) => {
    if (c.id === 'broken') throw new Error('model unavailable');
    return { claims: outputs[c.id], usage: { 'claude-haiku-4-5-20251001': { calls: 1, input_tokens: 1000, output_tokens: 50 } } };
  };
  const asked = [];
  const ask = async ({ criterion, kind, rendered }) => {
    asked.push(`${kind}:${criterion}`);
    assert.match(rendered, /\[tech_stack\] Brindle runs support on Tallyhook\./);
    // "judged": trap not met, must met. "trapped": the trap is met twice.
    return { meets: kind === 'must' ? true : asked.filter(a => a === 'trap:t').length > 1, reasoning: 'fake' };
  };
  const lines = [];
  const r = await runEval({ cases, extract, ask, meta: { judge: { model: 'fake' }, judgeUsage: { calls: 4 } }, log: (l) => lines.push(l) });

  const by = Object.fromEntries(r.cases.map(x => [x.id, x]));
  assert.equal(by.quiet.status, 'pass');
  assert.equal(by.quiet.judge, null, 'no criteria: no judge call');
  assert.equal(by.padded.status, 'fail');
  assert.equal(by.padded.judge, null, 'a case the checks failed is not judged');
  assert.match(by.padded.reasons[0], /maxClaims/);
  assert.equal(by.judged.status, 'pass');
  assert.deepEqual(by.judged.claims, ['- [tech_stack] Brindle runs support on Tallyhook. (tool=Tallyhook) [2026-10-14] {account: Brindle}']);
  assert.equal(by.trapped.status, 'fail');
  assert.match(by.trapped.reasons[0], /^trap hit: t/);
  assert.equal(by.broken.status, 'error');
  assert.match(by.broken.reasons[0], /model unavailable/);
  assert.ok(!asked.includes('trap:never asked'));

  assert.deepEqual(r.totals, { pass: 2, total: 5, errors: 1 });
  assert.deepEqual(r.by_category, { selectivity: { pass: 1, total: 2 }, category: { pass: 1, total: 2 }, temporal: { pass: 0, total: 1 } });
  assert.deepEqual(r.usage.extraction, { 'claude-haiku-4-5-20251001': { calls: 4, input_tokens: 4000, output_tokens: 200 } });
  assert.deepEqual(r.usage.judge, { calls: 4 });
  assert.deepEqual(r.judge, { model: 'fake' });
  assert.equal(lines.length, 5);
  assert.deepEqual(summaryLines(r).slice(0, 2), ['[EVAL] 2/5 passed (1 errored)', '[EVAL]   selectivity        1/2']);
  // The result is plain JSON: it is written to --out and compared across prompt versions.
  assert.deepEqual(JSON.parse(JSON.stringify(r)).totals, r.totals);
});

test('scrubProductionEnv removes database, API and telemetry settings and keeps the model keys', () => {
  const env = { SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', WORKER_INTERNAL_SECRET: 'x', API_URL: 'x', OPENAI_API_KEY: 'x', LEAK_KEY: 'x', OPENROUTER_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', EXTRACTION_MODEL: 'm', PATH: '/bin' };
  assert.deepEqual(scrubProductionEnv(env).sort(), ['API_URL', 'LEAK_KEY', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'WORKER_INTERNAL_SECRET']);
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'EXTRACTION_MODEL', 'OPENROUTER_API_KEY', 'PATH']);
});

// ── the real read, offline ──────────────────────────────────────────────────────────────────
//
// extract.mjs drives the production entry points with the in-memory database. The model is the
// only thing faked, by registering a client on the door, so this pins the WIRING: our side and the
// people reach the prompt, the facts come back through grounding and persistFacts' guards, and each
// lands on the right record.

test('extractCase runs the production read into the in-memory database (fake model)', async () => {
  scrubProductionEnv();
  for (const k of ['OPENROUTER_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL']) delete process.env[k];
  const { extractCase, extractorInfo, seedFor } = await import('../evals/extraction/extract.mjs');
  const { registerAnthropicClient } = await import('@nous/core');
  const prompts = [];
  registerAnthropicClient({
    messages: {
      create: async (params) => {
        const prompt = params.messages[0].content;
        prompts.push(prompt);
        const meeting = /EXTERNAL ATTENDEES/.test(prompt);
        const facts = meeting
          ? [
            { person: 2, home: 'claim', importance: 'high', category: 'authority', about: 'person', role: 'economic_buyer', content: 'Odile Ferrant signs off on anything over twenty thousand a year.', quote: 'I sign off on anything over twenty thousand a year', speaker: 'Odile Ferrant' },
            { person: 1, home: 'claim', importance: 'high', category: 'tech_stack', about: 'company', tool: 'Tallyhook', content: 'Brindle runs its CRM on Tallyhook.', quote: 'our CRM is Tallyhook', speaker: 'Ines Halloran' },
          ]
          : [
            { home: 'claim', importance: 'high', category: 'tech_stack', about: 'company', tool: 'Tallyhook', content: 'Brindle moved its support team onto Tallyhook.', quote: 'we moved the support team onto Tallyhook', speaker: 'Ines Halloran' },
            // A fact resting on our own rep's words: the our-side guard must drop it.
            { home: 'claim', importance: 'high', category: 'budget', about: 'company', content: 'Brindle finds seven hundred dollars a month expensive.', quote: 'seven hundred dollars a month would feel expensive', speaker: 'Theo Bramwell' },
          ];
        // The signal check (a second read of deal signals): no verdicts, so it keeps what it is shown.
        const isCheck = prompt.startsWith('You check the deal signals');
        const text = isCheck ? '[]' : JSON.stringify(facts);
        return { model: params.model, content: [{ type: 'text', text }], usage: { input_tokens: 500, output_tokens: 80 }, stop_reason: 'end_turn' };
      },
    },
  }, { acceptsFeature: false });

  const one = {
    id: 'wiring-one', category: 'attribution', origin: 'wiring', must: [], traps: [], expect: {},
    input: {
      kind: 'meeting', saidAt: '2026-10-14', account: { name: 'Brindle', industry: 'Payroll' }, people: [{ name: 'Ines Halloran', title: 'Head of Revenue Operations' }],
      ourSide: { ...OUR, names: ['Theo Bramwell'] },
      text: 'Theo Bramwell: I guess seven hundred dollars a month would feel expensive?\nInes Halloran: Not sure. Big news is we moved the support team onto Tallyhook.',
    },
  };
  const got = await extractCase(one);
  assert.match(prompts[0], /Ines Halloran/);
  assert.match(prompts[0], /WHAT CORVANE SELLS/, 'our offer reached the prompt from the positioning foundation');
  assert.match(prompts[0], /Account: Brindle/, 'the account brief was built from the seeded rows');
  assert.deepEqual(got.claims.map(c => c.content), ['Brindle moved its support team onto Tallyhook.']);
  assert.deepEqual(got.claims[0].subject, { kind: 'account', name: 'Brindle' });
  assert.deepEqual(got.claims[0].tags, { tool: 'Tallyhook' });
  assert.equal(got.claims[0].saidAt, '2026-10-14');
  assert.ok(Object.values(got.usage).every(u => u.calls >= 1 && u.input_tokens >= 500));

  const two = {
    ...one, id: 'wiring-two',
    input: {
      ...one.input, people: [{ name: 'Ines Halloran' }, { name: 'Odile Ferrant' }],
      text: 'Ines Halloran: Yes, our CRM is Tallyhook.\nOdile Ferrant: I sign off on anything over twenty thousand a year.',
    },
  };
  const both = await extractCase(two);
  const odile = both.claims.find(c => c.category === 'authority');
  assert.deepEqual(odile?.subject, { kind: 'person', name: 'Odile Ferrant' }, 'the meeting path files a fact on the attendee it names');
  assert.ok(both.claims.some(c => c.category === 'tech_stack' && c.subject.name === 'Brindle'));

  // Each case gets its own workspace, so no cache carries one case into the next.
  assert.notEqual(seedFor(one).workspaceId, seedFor(one).workspaceId);
  const info = extractorInfo();
  assert.equal(info.models.extraction, 'claude-haiku-4-5-20251001');
  assert.match(info.prompts.activity, /^[0-9a-f]{12}$/);
});

// ── our side's facts (GET-1052) ─────────────────────────────────────────────────────────────

test('expect.ours is validated against the our-side categories', () => {
  assert.deepEqual(oursExpectProblems({ categories: ['our_reply'], max: 2, contains: ['review queue'] }), []);
  assert.ok(oursExpectProblems({ categories: ['objection'] }).some(e => /unknown our-side category "objection"/.test(e)));
  assert.ok(oursExpectProblems({ maxx: 1 }).some(e => /unknown key "maxx"/.test(e)));
  assert.ok(oursExpectProblems({ max: 0, categories: ['pitch_line'] }).some(e => /contradicts/.test(e)));
});

test('our side\'s facts are checked by code, apart from the buyer\'s claims', () => {
  const ours = [
    { category: 'our_reply', content: 'Answered the sync worry with the review queue.', answers: 'HubSpot sync' },
    { category: 'our_commitment', content: 'Promised the security doc by Friday, October 23, 2026.', occurred: { start: '2026-10-23', end: '2026-10-23' } },
  ];
  assert.deepEqual(oursProblems(ours, { categories: ['our_reply', 'our_commitment'], contains: [['hubspot']], occurred: [{ contains: 'security doc', start: '2026-10-23', end: '2026-10-23' }] }), []);
  assert.deepEqual(oursProblems(ours, { max: 0 }), ['ours.max: 2 of our side\'s fact(s), at most 0 expected']);
  assert.match(oursProblems(ours, { notCategories: ['our_reply'] })[0], /^ours\.notCategories: 1 \[our_reply\]/);
  assert.match(oursProblems([], { categories: ['pitch_line'] })[0], /no \[pitch_line\] fact of ours/);
  assert.deepEqual(oursProblems(ours, undefined), []);
  const c = { input: { saidAt: '2026-10-20', text: 'x' }, expect: { ours: { max: 0 } } };
  assert.equal(deterministicChecks([], c, ours).pass, false);
  assert.equal(deterministicChecks([], c).pass, true, 'no facts of ours, none expected');
});

// A link may accept either of two categories where both fit the same fact (a budget freeze is a
// budget or a blocker fact); the link itself is what the case measures.
test('a link expectation accepts "a|b", and still names an unknown category', async () => {
  const { linkProblems, linksExpectProblems } = await import('../evals/extraction/checks.mjs');
  const claims = [{ ref: 'a', category: 'budget', content: 'Froze the budget.', causedBy: ['b'] }, { ref: 'b', category: 'staff_change', content: 'The CFO left.' }];
  assert.deepEqual(linkProblems(claims, [], [{ from: 'blocker|budget', to: 'staff_change' }]), []);
  assert.equal(linkProblems(claims, [], [{ from: 'blocker', to: 'staff_change' }]).length, 1);
  assert.deepEqual(linksExpectProblems([{ from: 'blocker|budget', to: 'staff_change' }]), []);
  assert.match(linksExpectProblems([{ from: 'blocker|bugdet', to: 'staff_change' }])[0], /"bugdet" is not a claim/);
});

test('judgeCase: with no claims recorded, traps are not asked (none can be hit)', async () => {
  const c = aCase({ traps: ['wrong fact'], must: [], expect: {} });
  const j = scripted([true, true]);
  const r = await judgeCase(j.ask, c, '(no claims were recorded)', { claimCount: 0 });
  assert.equal(r.pass, true);
  assert.deepEqual(j.asked, []);
});

test('the check pass keeps a doubted condition an objection, resolved when settled', async () => {
  const { READ_IN_CONTEXT } = await import('../src/signals/signalCheck.mjs');
  assert.match(READ_IN_CONTEXT, /A condition they DOUBT we meet .* is an objection, not a requirement/);
  assert.match(READ_IN_CONTEXT, /Never move such an objection to requirement because it was satisfied/);
});
