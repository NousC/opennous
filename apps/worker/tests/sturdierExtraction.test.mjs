// Sturdier extraction (GET-1050): the repair turn, an error that is never a zero, the split on
// overflow, categories held to the list, the shared system prompt, the person fact re-filed on its
// account, and the delta skip. No network: the model is a registered fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['OPENROUTER_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL']) delete process.env[k];

const { registerAnthropicClient } = await import('@nous/core');
const {
  readReply, needsRepair, repairTurn, readWithRepair, usableFacts, isKnownCategory, splitOnOverflow, factProblem, OVERFLOW_FLOOR,
} = await import('../src/signals/extractionReply.mjs');
const {
  extractFactsFromText, buildActivitySignalsPrompt, buildMeetingSignalsMessages, buildMeetingSignalsPrompt, extractionSystemPrompt,
  sourceTextHash, alreadyReadSameText,
} = await import('../src/signals/index.mjs');

const good = (over = {}) => ({ home: 'claim', importance: 'high', category: 'tech_stack', about: 'company', tool: 'Tallyhook', content: 'Harborline runs its CRM on Tallyhook.', quote: '', ...over });

/** A fake model: answers in order, recording what it was sent. */
function fakeModel(answers) {
  const sent = [];
  registerAnthropicClient({
    messages: {
      create: async (params) => {
        sent.push(params);
        const a = answers[Math.min(sent.length - 1, answers.length - 1)];
        const { text, stop = 'end_turn' } = typeof a === 'function' ? a(params) : typeof a === 'string' ? { text: a } : a;
        return { model: params.model, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: stop };
      },
    },
  }, { acceptsFeature: false });
  return sent;
}

const read = (text, over = {}) => extractFactsFromText({
  contactName: 'Sabeline Kroft', company: 'Harborline', type: 'email_received', text, fallback: false, check: false, ...over,
});

// ── reading one answer ──────────────────────────────────────────────────────────────────────

test('readReply tells facts, an explicit [], no array and a cut-off answer apart', () => {
  assert.equal(readReply(JSON.stringify([good()])).status, 'facts');
  assert.equal(readReply('[]').status, 'empty');
  assert.equal(readReply('Nothing worth recording here.').status, 'unparseable');
  assert.equal(readReply('').status, 'unparseable');
  assert.equal(readReply('[{"content": "Harborline runs', { truncated: true }).status, 'truncated');
  // Lenient: a trailing comma, a wrapped array, one bare fact.
  assert.equal(readReply(`[${JSON.stringify(good())},]`).facts.length, 1);
  assert.equal(readReply(JSON.stringify({ facts: [good()] })).facts.length, 1);
  assert.equal(readReply(JSON.stringify(good())).facts.length, 1);
});

test('the repair turn triggers on no array, or on more than a fifth of the facts malformed', () => {
  assert.equal(needsRepair(readReply('no json here')), true);
  assert.equal(needsRepair(readReply('[]')), false, 'an explicit [] is an answer');
  const five = (bad) => JSON.stringify([...Array(5 - bad)].map(() => good()).concat([...Array(bad)].map(() => ({ fact: 'x', type: 'stack' }))));
  assert.equal(needsRepair(readReply(five(1))), false, '1 of 5 is 20%, not more');
  assert.equal(needsRepair(readReply(five(2))), true);
  const turn = repairTurn(readReply(five(2)));
  assert.match(turn, /2 of your 5 facts could not be used/);
  assert.match(turn, /You used the keys: .*fact.*type/);
  assert.match(turn, /Reply exactly with a JSON array \[\.\.\.\]/);
  assert.match(turn, /tech_stack/, 'the valid categories are named');
});

test('readWithRepair sends one repair turn with the first answer, and reads the corrected one', async () => {
  const calls = [];
  const answers = [JSON.stringify([{ fact: 'Harborline runs its CRM on Tallyhook.', type: 'stack' }]), JSON.stringify([good()])];
  const metered = [];
  const out = await readWithRepair({
    ask: async (p) => { calls.push(p); return { model: 'm', content: [{ type: 'text', text: answers[calls.length - 1] }] }; },
    system: 'SYS', user: 'USER', onCall: (m) => metered.push(m), log: () => {},
  });
  assert.equal(calls.length, 2);
  assert.equal(out.repaired, true);
  assert.equal(out.reply.status, 'facts');
  assert.equal(out.reply.facts[0].content, 'Harborline runs its CRM on Tallyhook.');
  assert.deepEqual(calls[1].messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(calls[1].system, 'SYS');
  assert.equal(metered.length, 2, 'the repair turn is metered too');
  // A clean answer costs one call.
  calls.length = 0; answers.splice(0, 2, JSON.stringify([good()]));
  await readWithRepair({ ask: async (p) => { calls.push(p); return { model: 'm', content: [{ type: 'text', text: answers[0] }] }; }, system: 'S', user: 'U', log: () => {} });
  assert.equal(calls.length, 1);
});

// ── never zero silently ─────────────────────────────────────────────────────────────────────

test('an explicit [] is zero facts and no failure; an unusable answer after the repair is a failure', async () => {
  let sent = fakeModel(['[]']);
  const empty = await read('Thanks Avery, Thursday works. Sabeline');
  assert.deepEqual(empty.facts, []);
  assert.equal(empty.failedParts, 0);
  assert.equal(sent.length, 1);

  sent = fakeModel(['I could not find anything.', 'Still nothing to say.']);
  const failed = [];
  const lost = await read('Thanks Avery, Thursday works. Sabeline', { onPart: (f) => { if (f === null) failed.push(1); } });
  assert.equal(sent.length, 2, 'one repair turn, then it stops');
  assert.equal(lost.failedParts, 1);
  assert.equal(failed.length, 1, 'the failure reaches onPart(null), which records the pipeline event');

  fakeModel(['prose', 'more prose']);
  await assert.rejects(read('Thanks Avery, Thursday works. Sabeline', { strict: true }), /unparseable extraction output/);
});

test('an answer whose facts are all unusable, and stay so after the repair, is a failure, not zero', async () => {
  const wrong = JSON.stringify([{ fact: 'Harborline runs its CRM on Tallyhook.', kind: 'stack' }]);
  const sent = fakeModel([wrong, wrong]);
  const got = await read('We run everything on Tallyhook as our CRM, have done for years.');
  assert.equal(sent.length, 2);
  assert.equal(got.failedParts, 1);
  fakeModel([wrong, wrong]);
  await assert.rejects(read('We run everything on Tallyhook as our CRM.', { strict: true }), /unusable extraction output/);
});

test('a repair that is worse than the first answer does not replace it', async () => {
  const first = JSON.stringify([good(), good({ content: 'Harborline has 40 reps.', category: 'firmographic' }), { fact: 'x' }]);
  const answers = [first, JSON.stringify([{ fact: 'y' }])];
  let n = 0;
  const out = await readWithRepair({ ask: async () => ({ model: 'm', content: [{ type: 'text', text: answers[n++] }] }), system: 'S', user: 'U', log: () => {} });
  assert.equal(out.reply.facts.length - out.reply.problems.length, 2);
});

test('a cut-off answer is never read leniently as its first complete fact', () => {
  const cut = `[${JSON.stringify(good())},{"content":"Harborline is rolling out to`;
  assert.equal(readReply(cut, { truncated: true }).status, 'truncated');
  assert.equal(readReply(cut).status, 'unparseable', 'and without the flag it is no answer, so the door tries the fallback');
});

test('an answer with every fact on the wrong keys is repaired, not read as nothing', async () => {
  const sent = fakeModel([
    JSON.stringify([{ fact: 'Harborline runs its CRM on Tallyhook.', kind: 'stack' }]),
    JSON.stringify([good()]),
  ]);
  const got = await read('We run everything on Tallyhook as our CRM, have done for years.');
  assert.equal(sent.length, 2);
  assert.deepEqual(got.facts.map(f => f.content), ['Harborline runs its CRM on Tallyhook.']);
  assert.match(sent[1].messages[2].content, /You used the keys: fact, kind/);
});

// ── overflow ────────────────────────────────────────────────────────────────────────────────

const transcript = (turns) => [...Array(turns)].map((_, i) => `${i % 2 ? 'Sabeline Kroft' : 'Avery Lund'}: ${'We talked through the rollout plan and the renewal at length. '.repeat(3)}${i}`).join('\n');

test('splitOnOverflow cuts at a speaker turn near the middle, each half above the floor', () => {
  const t = transcript(20);
  const [a, b] = splitOnOverflow(t);
  assert.ok(a.length >= OVERFLOW_FLOOR && b.length >= OVERFLOW_FLOOR);
  assert.match(b, /^(Avery Lund|Sabeline Kroft): /, 'the second half starts on a turn');
  assert.equal(a.length + b.length + 1, t.length, 'nothing lost, nothing read twice');
  assert.equal(splitOnOverflow('x'.repeat(2 * OVERFLOW_FLOOR - 1)), null, 'below the floor: no split');
  // No line breaks: a sentence end.
  const prose = 'We use Tallyhook for everything. '.repeat(60);
  const [p1] = splitOnOverflow(prose);
  assert.match(p1, /\.$/);
});

test('an answer cut off at the token limit is read again as two halves, and both halves count', async () => {
  const text = transcript(20);
  const sent = fakeModel([(params) => {
    const user = params.messages[0].content;
    if (user.includes(' 0\n') && user.includes(' 19')) return { text: '[{"content": "Harborline is rolling', stop: 'max_tokens' };
    const n = user.includes(' 19') ? 2 : 1;
    return { text: JSON.stringify([good({ content: `Harborline renewal point ${n}.`, category: 'timeline', about: 'company' })]) };
  }]);
  const got = await read(text, { type: 'meeting_held' });
  assert.equal(sent.length, 3, 'the whole, then each half');
  const ceiling = (p) => Number(/Hard ceiling of (\d+) facts/.exec(p.messages[0].content)[1]);
  assert.ok(ceiling(sent[1]) < ceiling(sent[0]), 'a half shares the fact budget, it does not get all of it');
  assert.equal(got.failedParts, 0);
  assert.deepEqual(got.facts.map(f => f.content).sort(), ['Harborline renewal point 1.', 'Harborline renewal point 2.']);
});

test('an overflow on a piece below the floor fails instead of splitting forever', async () => {
  const sent = fakeModel([{ text: '[{"content": "cut', stop: 'max_tokens' }]);
  const got = await read('Sabeline Kroft: We use Tallyhook for the CRM and nothing else at all.');
  assert.equal(sent.length, 1);
  assert.equal(got.failedParts, 1);
});

// ── categories as an enum ───────────────────────────────────────────────────────────────────

test('a category outside the list is dropped and logged; keys, aliases and general are kept', () => {
  assert.equal(isKnownCategory('tech_stack'), true);
  assert.equal(isKnownCategory('general'), true);
  assert.equal(isKnownCategory('churn risk'), true, 'an alias the taxonomy maps stays valid');
  assert.equal(isKnownCategory('vibes'), false);
  assert.equal(isKnownCategory(''), false);
  const logs = [];
  const kept = usableFacts([good(), good({ category: 'vibes' }), good({ category: undefined }), { home: 'our_product', content: 'Wants a date filter.', kind: 'feature' }], { log: (m) => logs.push(m) });
  assert.equal(kept.length, 2, 'the claim with a real category and the statement about us');
  assert.match(logs[0], /dropped 2 malformed/);
  assert.match(logs[0], /category "vibes" is not in the list/);
  assert.equal(factProblem({ home: 'market', content: 'Agents overclaim.' }), null, 'a statement about us needs no category');
});

// ── the system prompt ───────────────────────────────────────────────────────────────────────

test('the system prompt is identical across workspaces; their focus is in the user message', () => {
  const one = buildActivitySignalsPrompt({
    contactName: 'Sabeline Kroft', company: 'Harborline', type: 'meeting_held', summary: 'Sabeline Kroft: we run Tallyhook.',
    ourSide: { companyName: 'Fernpoint', ownerName: 'Avery Lund', teamNames: ['Avery Lund'], offer: 'Fernpoint sells route planning to freight teams.' },
    accountBrief: 'Account: Harborline (freight brokerage)',
  });
  const two = buildActivitySignalsPrompt({
    contactName: 'Bertram Ollivane', company: 'Quayside', type: 'email_received', summary: 'Bertram here, budget is frozen.',
    ourSide: { companyName: 'Quillmere', ownerName: 'Theo Marsh', teamNames: ['Theo Marsh'], offer: 'Quillmere checks identity documents for lenders.' },
    accountBrief: 'Account: Quayside (lending)',
  });
  assert.equal(one.system, two.system);
  assert.equal(one.system, extractionSystemPrompt());
  for (const s of ['Fernpoint', 'Quillmere', 'Harborline', 'Quayside', 'Sabeline', 'Bertram', 'Avery', 'Theo']) assert.ok(!one.system.includes(s), `${s} leaked into the system prompt`);
  assert.match(one.user, /Fernpoint sells route planning/);
  assert.match(two.user, /Quillmere checks identity documents/);
  assert.match(one.user, /Account: Harborline/);
  // The fixed rules moved, word for word, and are not repeated in the user message.
  assert.match(one.system, /ONLY WHAT MOVES THE DEAL/);
  assert.match(one.system, /WHERE EACH STATEMENT BELONGS/);
  assert.match(one.system, /would this matter for the deal or the account in 6 months/);
  assert.match(one.system, /Never emit an example's facts, names or dates unless the conversation itself has them/);
  assert.ok(!one.user.includes('ONLY WHAT MOVES THE DEAL'));
  assert.equal(one.prompt, `${one.system}\n\n${one.user}`);
  // The meeting prompt shares the same system prompt.
  const m = buildMeetingSignalsMessages({ roster: '1. Sabeline Kroft (Harborline)', transcript: 't', maxFacts: 8, ourSide: { companyName: 'Fernpoint', teamNames: ['Avery Lund'] } });
  assert.equal(m.system, one.system);
  assert.equal(buildMeetingSignalsPrompt({ roster: '1. Sabeline Kroft (Harborline)', transcript: 't', maxFacts: 8 }).startsWith(one.system), true);
});

test('the extractor sends the system prompt as system, the workspace focus as the user turn', async () => {
  const sent = fakeModel(['[]']);
  await read('Thanks Avery, Thursday works. Sabeline', { ourSide: { companyName: 'Fernpoint', teamNames: ['Avery Lund'], offer: 'Fernpoint sells route planning.' } });
  assert.equal(sent[0].system, extractionSystemPrompt());
  assert.match(sent[0].messages[0].content, /Fernpoint sells route planning/);
});

// ── Part A rules ────────────────────────────────────────────────────────────────────────────

test('the prompts say a test of their own tool on their CRM data versus ours is not a competitor evaluation', async () => {
  const { READ_IN_CONTEXT } = await import('../src/signals/signalCheck.mjs');
  assert.ok(!/the competitor is the OTHER source/.test(READ_IN_CONTEXT));
  assert.match(READ_IN_CONTEXT, /a test of US, not a competitor evaluation/);
  const { user } = buildActivitySignalsPrompt({ contactName: 'Sabeline Kroft', company: 'Harborline', type: 'meeting_held', summary: 'x' });
  assert.match(user, /Testing what feeds their own tool .* is a test of US/);
  assert.match(user, /who at their company decides, signs off or holds the budget .* "about": "company"/);
  assert.match(extractionSystemPrompt(), /Their own answer to it is theirs/);
});

test('a person fact that names the account but not the person is re-filed on the account, not dropped', async () => {
  const { scrubProductionEnv } = await import('../evals/extraction/safeEnv.mjs');
  scrubProductionEnv();
  const { extractCase } = await import('../evals/extraction/extract.mjs');
  const facts = [
    { home: 'claim', importance: 'high', category: 'authority', about: 'person', role: 'economic_buyer', content: "Wren, Harborline's CFO, makes the money call.", quote: "Money is Wren's call", speaker: 'Sabeline Kroft' },
    { home: 'claim', importance: 'high', category: 'authority', about: 'person', content: 'Wren reads everything on paper.', quote: 'She reads everything on paper', speaker: 'Sabeline Kroft' },
    // Only who decides and where the money sits is re-filed: a colleague's pain still names no subject.
    { home: 'claim', importance: 'high', category: 'pain', about: 'person', content: "Harborline's CFO is drowning in paper.", quote: 'She reads everything on paper', speaker: 'Sabeline Kroft' },
  ];
  fakeModel([(p) => ({ text: String(p.messages[0].content).startsWith('You check the deal signals') ? '[]' : JSON.stringify(facts) })]);
  const got = await extractCase({
    id: 'refile', category: 'attribution', origin: 'test', must: [], traps: [], expect: {},
    input: {
      kind: 'meeting', saidAt: '2026-10-14', account: { name: 'Harborline' }, people: [{ name: 'Sabeline Kroft' }],
      ourSide: { company: 'Fernpoint', names: ['Avery Lund'], offer: 'Fernpoint sells route planning.' },
      text: "Avery Lund: Would it feel expensive?\nSabeline Kroft: Money is Wren's call, she's our CFO.\nSabeline Kroft: She reads everything on paper.",
    },
  });
  assert.deepEqual(got.claims.map(c => c.content), ["Wren, Harborline's CFO, makes the money call."]);
  assert.deepEqual(got.claims[0].subject, { kind: 'account', name: 'Harborline' });
  assert.equal(got.claims[0].tags.role ?? null, null, 'the role described a person; on the account it is cleared');
});

// ── delta skip ──────────────────────────────────────────────────────────────────────────────

test('sourceTextHash ignores re-wrapping, not a change of words', () => {
  assert.equal(sourceTextHash('Sabeline: we run\nTallyhook.'), sourceTextHash('Sabeline: we run Tallyhook.  '));
  assert.notEqual(sourceTextHash('Sabeline: we run Tallyhook.'), sourceTextHash('Sabeline: we run Ledgerway.'));
});

test('alreadyReadSameText asks for a claim with this source and this text, and fails open', async () => {
  const seen = [];
  const db = (rows, failures = []) => ({ from: (t) => { const q = { select: () => q, in: () => q, eq: (c, v) => { seen.push([t, c, v]); return q; }, limit: async () => ({ data: t === 'claims' ? rows : failures }) }; return q; } });
  assert.equal(await alreadyReadSameText(db([{ id: 'c1' }]), 'ws', 'source://fireflies/abc', 'h1'), true);
  assert.deepEqual(seen.slice(1, 3), [['claims', 'value->metadata->>source_ref', 'source://fireflies/abc'], ['claims', 'value->metadata->>source_hash', 'h1']]);
  assert.equal(await alreadyReadSameText(db([{ id: 'c1' }], [{ id: 'e1' }]), 'ws', 'source://fireflies/abc', 'h1'), false,
    'an earlier read that lost a part is read again');
  assert.equal(await alreadyReadSameText(db([]), 'ws', 'source://fireflies/abc', 'h1'), false);
  assert.equal(await alreadyReadSameText(db([{ id: 'c1' }]), 'ws', null, 'h1'), false, 'no source, no skip');
  const broken = { from: () => { throw new Error('down'); } };
  assert.equal(await alreadyReadSameText(broken, 'ws', 'source://x/1', 'h1'), false);
});
