// Deal signals read in context (GET-1033): the account brief the extractor reads with, and the
// second read that keeps, rewrites or drops each deal signal. A failed check keeps every signal.
//
// Run: cd apps/worker && node --test tests/signalCheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountBrief, accountBriefBlock } from '../src/signals/accountBrief.mjs';
import { buildSignalCheckPrompt, applyVerdicts, checkSignals, READ_IN_CONTEXT } from '../src/signals/signalCheck.mjs';
import { buildActivitySignalsPrompt, buildMeetingSignalsPrompt } from '../src/signals/index.mjs';

const notes = [
  { category: 'tech_stack', content: 'Brindle runs its own sales bot, Tallyhook, built in-house.', metadata: { tool: 'Tallyhook' }, said_at: '2026-10-07' },
  { category: 'tech_stack', content: 'Brindle keeps every deal in HubSpot.', metadata: { tool: 'HubSpot' }, said_at: '2026-10-08' },
  { category: 'tech_stack', content: 'Brindle built Tallyhook on top of a model API.', metadata: { tool: 'Tallyhook' }, said_at: '2026-10-01' },
  { category: 'goal', content: 'Brindle wants Tallyhook to answer deal questions from one account record.', said_at: '2026-10-09' },
  { category: 'goal', content: 'An old goal that was replaced.', superseded_by: 'x', said_at: '2026-10-10' },
  { category: 'pain', content: 'Reps re-type call notes into HubSpot.', said_at: '2026-10-02' },
];

test('the brief names the account, the people, their own tools once each, and what they do with us', () => {
  const b = buildAccountBrief({ account: { name: 'Brindle', stage: 'demo', industry: 'Software' },
    people: [{ name: 'Iva Brindle', job_title: 'CTO' }, { name: 'Rui Okafor' }], notes });
  assert.match(b, /^Account: Brindle \(Software, deal stage: demo\)/);
  assert.match(b, /People on file: Iva Brindle, CTO; Rui Okafor/);
  assert.equal((b.match(/Tallyhook/g) ?? []).length, 2, 'one stack line per tool, plus the goal that names it');
  assert.match(b, /- \[2026-10-09\] Brindle wants Tallyhook to answer deal questions/);
  assert.doesNotMatch(b, /An old goal that was replaced/);
});

test('no brief, no block; a brief is framed as context, never a source', () => {
  assert.equal(buildAccountBrief({}), '');
  assert.equal(accountBriefBlock(''), '');
  assert.match(accountBriefBlock('Account: Brindle'), /context only: never record a fact from it/);
});

test('both extraction prompts carry the brief and the read-in-context rules, and no client example', () => {
  const a = buildActivitySignalsPrompt({ contactName: 'Iva Brindle', type: 'email_received', summary: 'hi', accountBrief: 'Account: Brindle' });
  const m = buildMeetingSignalsPrompt({ roster: '1. Iva Brindle (Brindle)', transcript: 'hi', maxFacts: 8, accountBrief: 'Account: Brindle' });
  for (const p of [a.prompt, m]) {
    assert.match(p, /ACCOUNT CONTEXT[\s\S]*Account: Brindle/);
    assert.ok(p.includes(READ_IN_CONTEXT));
    assert.match(p, /own build \(a bot or agent they made\)/);
    assert.match(p, /NOT a fragment of their words/);
    assert.doesNotMatch(p, /GrokBot/);
  }
});

const signals = [
  { category: 'competitor', label: 'Tallyhook', content: 'Iva Brindle is evaluating Tallyhook against us.', entity: 'Tallyhook', stance: 'evaluating', quote: 'tallyhook vs your data' },
  { category: 'objection', label: 'Not a silver bullet', content: 'Iva Brindle says no tool is a silver bullet.', status: 'open', hardness: 'soft' },
  { category: 'buying_signal', label: 'Ready to show stakeholders', content: 'Iva Brindle wants to present it to the CRO.' },
];

test('the check prompt numbers the signals with their chips, tags and quotes, and holds the conversation', () => {
  const p = buildSignalCheckPrompt({ signals, text: 'Iva: tallyhook vs your data', brief: 'Account: Brindle', offer: 'An account record for agents.' });
  assert.match(p, /1\. \[competitor\] chip "Tallyhook" — Iva Brindle is evaluating Tallyhook against us\. \(entity: Tallyhook, stance: evaluating\)\n   quote: "tallyhook vs your data"/);
  assert.match(p, /WHAT WE SELL:\nAn account record for agents\./);
  assert.match(p, /CONVERSATION they were read from:\n<<<\nIva: tallyhook vs your data\n>>>/);
});

test('verdicts rewrite, move category with only that category\'s fields, and drop', () => {
  const out = applyVerdicts(signals, [
    { n: 1, verdict: 'rewrite', category: 'tech_stack', tool: 'Tallyhook', label: 'Own sales bot', content: 'Iva Brindle is testing Brindle\'s own bot, Tallyhook, on HubSpot data against ours.' },
    { n: 2, verdict: 'drop', why: 'general view about tools' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { category: 'tech_stack', label: 'Tallyhook', content: 'Iva Brindle is testing Brindle\'s own bot, Tallyhook, on HubSpot data against ours.', quote: 'tallyhook vs your data', tool: 'Tallyhook', checked: 'rewritten' });
  assert.equal(out[1], null);
  assert.equal(out[2], signals[2], 'no verdict: kept as it was');
});

test('a move to competitor with no name, or to an unknown category, keeps the category', () => {
  const [a, b] = applyVerdicts(signals.slice(1), [
    { n: 1, verdict: 'rewrite', category: 'competitor', label: 'Vendor doubts' },
    { n: 2, verdict: 'rewrite', category: 'vibes' },
  ]);
  assert.equal(a.category, 'objection');
  assert.equal(a.label, 'Vendor doubts');
  assert.equal(b.category, 'buying_signal');
});

test('no deal signals: no call, the facts come back as they were', async () => {
  const facts = [{ category: 'tech_stack', content: 'x' }];
  assert.equal(await checkSignals(facts, { text: 't' }), facts);
});

test('a note reads as a fact with its tags, and only a real change is a rewrite', async () => {
  const { noteAsFact, rewriteOf } = await import('../src/signals/recheckSignals.mjs');
  const n = { id: 'c1', category: 'competitor', label: 'Tallyhook', content: 'Iva Brindle is evaluating Tallyhook.', metadata: { entity: 'Tallyhook', stance: 'evaluating', quote: 'q', speaker: 'Iva' } };
  const f = noteAsFact(n);
  assert.deepEqual(f, { id: 'c1', category: 'competitor', label: 'Tallyhook', content: 'Iva Brindle is evaluating Tallyhook.', quote: 'q', entity: 'Tallyhook', stance: 'evaluating' });
  assert.equal(rewriteOf(n, f), null);
  assert.equal(rewriteOf(n, { ...f, category: 'tech_stack', entity: undefined, stance: undefined, tool: 'Tallyhook' }).category, 'tech_stack');
  assert.equal(rewriteOf(n, null), null);
});

test('a long text is cut to windows around each quote, never just its start', async () => {
  const { excerptFor } = await import('../src/signals/signalCheck.mjs');
  const text = `${'a'.repeat(20_000)} the CRO has to sign off ${'b'.repeat(20_000)}`;
  const out = excerptFor(text, [{ quote: 'the CRO has to sign off' }]);
  assert.ok(out.length <= 16_000);
  assert.match(out, /the CRO has to sign off/);
  assert.equal(excerptFor('short', [{ quote: 'x' }]), 'short');
});

test('a move needs its new category\'s tags, carries only those, and never a code-built chip', async () => {
  const [a, b, c] = applyVerdicts([
    { category: 'competitor', label: 'Tallyhook', content: 'x', entity: 'Tallyhook', stance: 'evaluating' },
    { category: 'buying_signal', label: 'More seats', content: 'y' },
    { category: 'expansion_signal', label: 'More seats', content: 'z', product: 'Seats', stance: 'asked' },
  ], [
    { n: 1, verdict: 'rewrite', category: 'tech_stack', tool: 'Tallyhook', label: 'Own bot' },
    { n: 2, verdict: 'rewrite', category: 'expansion_signal', stance: 'asked' },
    { n: 3, verdict: 'rewrite', category: 'competitor', entity: 'Brightlist', stance: 'asked' },
  ]);
  assert.deepEqual([a.category, a.tool, a.entity, a.stance, a.label], ['tech_stack', 'Tallyhook', undefined, undefined, 'Tallyhook'], 'code builds the tech_stack chip');
  assert.equal(b.category, 'buying_signal', 'expansion needs a product');
  assert.equal(c.category, 'expansion_signal', '"asked" is not a competitor stance');
});

test('a code-built chip is not a rewrite on its own; a checked note is skipped', async () => {
  const { rewriteOf } = await import('../src/signals/recheckSignals.mjs');
  const n = { category: 'competitor', label: 'Brightlist', content: 'x', metadata: { entity: 'Brightlist', stance: 'evaluating' } };
  assert.equal(rewriteOf(n, { category: 'competitor', label: 'Evaluating Brightlist', content: 'x', entity: 'Brightlist', stance: 'evaluating' }), null);
});

test('a chip that would be cut, or reads "X vs Y", is refused and the old chip kept', async () => {
  const { goodChip } = await import('../src/signals/signalCheck.mjs');
  assert.equal(goodChip('Ready to present to leadership'), true);
  assert.equal(goodChip('Conditional pricing acceptance pending product fit'), false);
  assert.equal(goodChip('Testing Nous MCP vs. HubSpot'), false);
  const [a] = applyVerdicts([{ category: 'objection', label: 'Old chip', content: 'x' }],
    [{ n: 1, verdict: 'rewrite', label: 'Adoption friction: trust as people problem' }]);
  assert.equal(a.label, 'Old chip');
});
