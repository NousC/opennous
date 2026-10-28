// When it happened vs when it was said (GET-1051): the anchor and the rules in the prompt, the
// validation of fact_kind / occurred_start / occurred_end, the relative-phrase fallback, and that
// persistFacts stores them in the claim's metadata while the said date stays the claim's clock.
// No network: the model is a registered fake client, the database tests/fakeDb.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['OPENROUTER_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL', 'NOUS_DEFAULT_TIMEZONE']) delete process.env[k];

const { registerAnthropicClient } = await import('@nous/core');
const {
  renderAnchor, anchorLine, strictIsoDate, normalizeOccurred, relativeOccurred, occurredMetaFor, OCCURRED_RULES, YEARS_BACK, YEARS_AHEAD,
} = await import('../src/signals/occurredDates.mjs');
const {
  buildActivitySignalsPrompt, buildMeetingSignalsMessages, extractionSystemPrompt, extractFactsFromText, persistFacts,
} = await import('../src/signals/index.mjs');
const { fakeDb } = await import('./fakeDb.mjs');

/** A fake model: answers in order, recording what it was sent. */
function fakeModel(answer) {
  const sent = [];
  registerAnthropicClient({
    messages: {
      create: async (params) => {
        sent.push(params);
        const text = typeof answer === 'function' ? answer(params) : answer;
        return { model: params.model, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: 'end_turn' };
      },
    },
  }, { acceptsFeature: false });
  return sent;
}

// ── the prompt ──────────────────────────────────────────────────────────────────────────────

test('the anchor is rendered with its weekday and ISO date', () => {
  assert.equal(renderAnchor('2024-06-10'), 'Monday, June 10, 2024 (2024-06-10)');
  assert.equal(renderAnchor('2026-10-16'), 'Friday, October 16, 2026 (2026-10-16)');
  assert.equal(renderAnchor('2026-02-30'), null);
  assert.equal(renderAnchor(null), null);
  assert.equal(anchorLine(null), '', 'no anchor, no line');
});

test('the shared system prompt carries the temporal rules; the user message carries the anchor', () => {
  const sys = extractionSystemPrompt();
  assert.ok(sys.includes(OCCURRED_RULES));
  assert.match(sys, /"fact_kind": "event" for something that happens or happened/);
  assert.match(sys, /write the resolved date into "content" too/);
  assert.match(sys, /"in Q1 2027" is 2027-01-01 to 2027-03-31/);
  assert.match(sys, /"in 2025" is 2025-01-01 to 2025-12-31/);
  assert.match(sys, /nearest sensible year relative to the anchor/);
  assert.match(sys, /never write a placeholder year \(0001, 9999/);
  assert.match(sys, /Open-ended .* set only the bound the text gives/);
  assert.match(sys, /Never invent a date the text does not state/);

  const one = buildActivitySignalsPrompt({ contactName: 'Ines Halloran', company: 'Brindle', type: 'email_reply', summary: 'We moved off Marrowdesk in March.', anchor: '2024-06-10' });
  assert.match(one.user, /This conversation is dated Monday, June 10, 2024 \(2024-06-10\)\. That is the ANCHOR/);
  assert.match(one.user, /"fact_kind": "event\|state", "occurred_start": "<YYYY-MM-DD, events only>", "occurred_end"/);
  assert.equal(one.system, sys, 'the anchor never enters the shared system prompt');
  assert.doesNotMatch(buildActivitySignalsPrompt({ contactName: 'Ines Halloran', type: 'email_reply', summary: 'x' }).user, /This conversation is dated/);

  const room = buildMeetingSignalsMessages({ roster: '1. Ines Halloran (Brindle)', transcript: 'x', maxFacts: 8, anchor: '2026-10-14' });
  assert.match(room.user, /This conversation is dated Wednesday, October 14, 2026 \(2026-10-14\)/);
  assert.match(room.user, /"occurred_start": "<YYYY-MM-DD, events only>"/);
  assert.equal(room.system, sys);
});

test('extractFactsFromText sends the anchor it is given, read in the workspace zone', async () => {
  const sent = fakeModel('[]');
  // 23:30 in Los Angeles on Oct 15 is already Oct 16 in UTC: the zone decides the calendar day.
  await extractFactsFromText({ contactName: 'Ruairi Doyle', company: 'Atlas Freight', type: 'email_received', text: 'Our trial ends next Friday, decision before then.', fallback: false, check: false,
    anchor: '2026-10-16T06:30:00.000Z', timeZone: 'America/Los_Angeles' });
  assert.match(String(sent[0].messages[0].content), /dated Thursday, October 15, 2026 \(2026-10-15\)/);
});

// ── validation ──────────────────────────────────────────────────────────────────────────────

test('strictIsoDate takes YYYY-MM-DD calendar dates only', () => {
  assert.equal(strictIsoDate('2026-03-01'), '2026-03-01');
  assert.equal(strictIsoDate(' 2026-03-01 '), '2026-03-01');
  for (const bad of ['2026-02-30', '2026-3-1', '2026-03-01T00:00:00Z', 'March 2026', '', null, 20260301]) assert.equal(strictIsoDate(bad), null, String(bad));
});

const ev = (over = {}) => ({ content: 'Brindle moved off Marrowdesk in March 2026.', category: 'tech_stack', fact_kind: 'event', ...over });

test('placeholder and absurd years are dropped; the window is the anchor -120y..+20y', () => {
  assert.equal(YEARS_BACK, 120); assert.equal(YEARS_AHEAD, 20);
  const a = '2026-10-14';
  assert.deepEqual(occurredMetaFor(normalizeOccurred(ev({ occurred_start: '0001-01-01', occurred_end: '9999-12-31' }), a)), { fact_kind: 'event' });
  assert.deepEqual(occurredMetaFor(normalizeOccurred(ev({ occurred_start: '1906-01-01', occurred_end: '2046-12-31' }), a)),
    { fact_kind: 'event', occurred_start: '1906-01-01', occurred_end: '2046-12-31' }, 'the edges of the window hold');
  assert.deepEqual(occurredMetaFor(normalizeOccurred(ev({ occurred_start: '1905-12-31', occurred_end: '2047-01-01' }), a)), { fact_kind: 'event' });
  assert.deepEqual(occurredMetaFor(normalizeOccurred(ev({ occurred_start: '2026-02-30' }), a)), { fact_kind: 'event' }, 'not a calendar date');
});

test('an end before its start is swapped; one bound stays one bound', () => {
  const a = '2026-10-14';
  const swapped = normalizeOccurred(ev({ occurred_start: '2026-03-31', occurred_end: '2026-03-01' }), a);
  assert.deepEqual([swapped.occurred_start, swapped.occurred_end], ['2026-03-01', '2026-03-31']);
  const open = normalizeOccurred(ev({ occurred_start: '2024-01-01' }), a);
  assert.deepEqual(occurredMetaFor(open), { fact_kind: 'event', occurred_start: '2024-01-01' }, 'open-ended: only the known bound');
});

test('a state carries no dates; an unknown kind is removed; dates alone make an event', () => {
  const a = '2026-10-14';
  const st = normalizeOccurred({ content: 'Brindle has forty account executives.', fact_kind: 'State', occurred_start: '2026-10-14', occurred_end: '2026-10-14' }, a);
  assert.equal(st.fact_kind, 'state');
  assert.equal('occurred_start' in st || 'occurred_end' in st, false);
  assert.deepEqual(occurredMetaFor(st), { fact_kind: 'state' });
  // A state is never dated by the fallback either, whatever its words.
  assert.deepEqual(occurredMetaFor(normalizeOccurred({ content: 'Ines Halloran uses Tallyhook today.', fact_kind: 'state' }, a)), { fact_kind: 'state' });

  const odd = normalizeOccurred({ content: 'x', fact_kind: 'milestone' }, a);
  assert.equal('fact_kind' in odd, false);
  const inferred = normalizeOccurred({ content: 'x', occurred_start: '2027-01-01', occurred_end: '2027-03-31' }, a);
  assert.deepEqual(occurredMetaFor(inferred), { fact_kind: 'event', occurred_start: '2027-01-01', occurred_end: '2027-03-31' });
  assert.deepEqual(normalizeOccurred({ content: 'x', quote: 'y' }, a), { content: 'x', quote: 'y' }, 'nothing temporal, nothing added');
});

test('normalizeOccurred changes nothing but the three temporal keys', () => {
  const f = ev({ occurred_start: '2026-03-01', occurred_end: '2026-03-31', quote: 'We moved off Marrowdesk in March', speaker: 'Ines Halloran', saidAt: '2026-10-14T12:00:00.000Z' });
  const out = normalizeOccurred(f, '2026-10-14');
  for (const k of ['content', 'category', 'quote', 'speaker', 'saidAt']) assert.equal(out[k], f[k], k);
});

// ── the fallback ────────────────────────────────────────────────────────────────────────────

test('relativeOccurred: the plain phrases against the anchor', () => {
  const a = '2026-10-14';   // a Wednesday
  const table = [
    ['They signed yesterday.', '2026-10-13', '2026-10-13'],
    ['They signed today.', '2026-10-14', '2026-10-14'],
    ['Finance decides tomorrow.', '2026-10-15', '2026-10-15'],
    ['Odile joined last week.', '2026-10-07', '2026-10-07'],
    ['The pilot starts next week.', '2026-10-21', '2026-10-21'],
    ['They switched last month.', '2026-09-01', '2026-09-30'],
    ['The rollout is next month.', '2026-11-01', '2026-11-30'],
    ['The trial ends in 3 days.', '2026-10-17', '2026-10-17'],
    ['The trial ends in two weeks.', '2026-10-28', '2026-10-28'],
    ['The trial ends in a week.', '2026-10-21', '2026-10-21'],
    ['Wren left 10 days ago.', '2026-10-04', '2026-10-04'],
    ['Wren left two weeks ago.', '2026-09-30', '2026-09-30'],
  ];
  for (const [text, start, end] of table) assert.deepEqual(relativeOccurred(text, a), { start, end }, text);
  // Month and year edges.
  assert.deepEqual(relativeOccurred('They switched last month.', '2026-01-12'), { start: '2025-12-01', end: '2025-12-31' });
  assert.deepEqual(relativeOccurred('Renewal is next month.', '2026-12-31'), { start: '2027-01-01', end: '2027-01-31' });
  assert.deepEqual(relativeOccurred('Decision tomorrow.', '2026-12-31'), { start: '2027-01-01', end: '2027-01-01' });
});

test('relativeOccurred abstains: no phrase, two dates, or nothing to count from', () => {
  const a = '2026-10-14';
  assert.equal(relativeOccurred('They moved off Marrowdesk in March.', a), null, 'a named month is the model\'s job');
  assert.equal(relativeOccurred('The trial ends next Friday.', a), null, 'a weekday is the model\'s job');
  assert.equal(relativeOccurred('Signed yesterday, starts next week.', a), null, 'two different dates: not ours to pick');
  assert.deepEqual(relativeOccurred('Signed yesterday. Yes, yesterday.', a), { start: '2026-10-13', end: '2026-10-13' }, 'the same date twice is one');
  assert.equal(relativeOccurred('in a few days', a), null);
  assert.equal(relativeOccurred('in 0 days', a), null);
  assert.equal(relativeOccurred('yesterday', null), null);
  assert.equal(relativeOccurred('', a), null);
});

test('the fallback fills an undated event from its content, then its quote — never over the model\'s dates', () => {
  const a = '2026-10-14';
  const fromContent = normalizeOccurred(ev({ content: 'Brindle signed the order form yesterday.' }), a);
  assert.deepEqual(occurredMetaFor(fromContent), { fact_kind: 'event', occurred_start: '2026-10-13', occurred_end: '2026-10-13' });
  const fromQuote = normalizeOccurred(ev({ content: 'Brindle starts its pilot.', quote: 'we start the pilot next week' }), a);
  assert.deepEqual(occurredMetaFor(fromQuote), { fact_kind: 'event', occurred_start: '2026-10-21', occurred_end: '2026-10-21' });
  const kept = normalizeOccurred(ev({ content: 'Brindle signed yesterday.', occurred_start: '2026-10-12', occurred_end: '2026-10-12' }), a);
  assert.equal(kept.occurred_start, '2026-10-12', 'the model\'s own valid date wins');
  // A placeholder dropped leaves the event undated, and then the fallback may date it.
  const replaced = normalizeOccurred(ev({ content: 'Brindle signed yesterday.', occurred_start: '0001-01-01' }), a);
  assert.equal(replaced.occurred_start, '2026-10-13');
});

// ── persistence ─────────────────────────────────────────────────────────────────────────────

const WS = '00000000-0000-4000-8000-000000000001';
const CONTACT = '00000000-0000-4000-8000-000000000002';
const COMPANY = '00000000-0000-4000-8000-000000000003';
const seed = () => ({
  workspaces: [{ id: WS, name: 'Corvane' }],
  contacts: [{ id: CONTACT, workspace_id: WS, first_name: 'Ines', last_name: 'Halloran', company: 'Brindle', company_id: COMPANY }],
  entities: [{ id: CONTACT, workspace_id: WS, type: 'person' }, { id: COMPANY, workspace_id: WS, type: 'company' }],
});
const facts = () => [
  { content: 'Brindle moved off Marrowdesk in March 2026.', category: 'tech_stack', about: 'company', tool: 'Marrowdesk', quote: '', fact_kind: 'event', occurred_start: '2026-03-31', occurred_end: '2026-03-01', contactId: CONTACT, companyId: COMPANY, activityId: null },
  { content: 'Brindle has forty account executives.', category: 'firmographic', about: 'company', quote: '', fact_kind: 'state', occurred_start: '2026-10-14', contactId: CONTACT, companyId: COMPANY, activityId: null },
  { content: 'Ines Halloran signs the order form tomorrow.', category: 'buying_signal', about: 'person', quote: '', fact_kind: 'event', contactId: CONTACT, companyId: COMPANY, activityId: null },
];
const SAID = '2026-10-14T15:00:00.000Z';

test('persistFacts (dry run) returns each fact with its occurred dates validated and its said date untouched', async () => {
  fakeModel('[]');
  const db = fakeDb(seed());
  const out = await persistFacts(db, WS, facts(), { type: 'meeting_held', source: 'test', dryRun: true, occurredAt: SAID });
  const by = Object.fromEntries(out.map(f => [f.category, f]));
  assert.deepEqual([by.tech_stack.occurred_start, by.tech_stack.occurred_end], ['2026-03-01', '2026-03-31'], 'swapped');
  assert.equal(by.firmographic.fact_kind, 'state');
  assert.equal(by.firmographic.occurred_start, undefined, 'a state is not dated');
  assert.deepEqual([by.buying_signal.occurred_start, by.buying_signal.occurred_end], ['2026-10-15', '2026-10-15'], 'the fallback, from the said day');
  for (const f of out) assert.equal(f.saidAt, undefined, 'no said date is invented on the fact; the source\'s stays the one');
});

test('persistFacts stores fact_kind and occurred_* in the claim metadata, and files it under when it was SAID', async () => {
  fakeModel('[]');
  const db = fakeDb(seed());
  await persistFacts(db, WS, facts(), { type: 'meeting_held', source: 'test', occurredAt: SAID });
  const notes = (db.tables.claims ?? []).filter(c => String(c.property ?? '').startsWith('note.'));
  const by = Object.fromEntries(notes.map(c => [c.value?.category, c]));
  assert.ok(by.tech_stack && by.firmographic && by.buying_signal, `three claims written (got ${notes.map(c => c.value?.category).join(', ')})`);
  const meta = (c) => c.value.metadata;
  assert.deepEqual([meta(by.tech_stack).fact_kind, meta(by.tech_stack).occurred_start, meta(by.tech_stack).occurred_end], ['event', '2026-03-01', '2026-03-31']);
  assert.equal(meta(by.firmographic).fact_kind, 'state');
  assert.equal('occurred_start' in meta(by.firmographic), false);
  assert.equal(meta(by.buying_signal).occurred_start, '2026-10-15');
  // The said date is the claim's clock (GET-770), untouched: March is when it happened, not when it was said.
  for (const c of notes) assert.equal(c.valid_from, SAID, `${c.value.category} filed under the said date`);
});

// ── the eval's deterministic check ──────────────────────────────────────────────────────────

test('expect.occurred: valid shapes pass, malformed ones are named', async () => {
  const { occurredExpectProblems } = await import('../evals/extraction/checks.mjs');
  assert.deepEqual(occurredExpectProblems([{ contains: 'portal', start: '2027-01-01', end: '2027-03-31' }, { contains: ['forty', '40'], none: true }]), []);
  assert.ok(occurredExpectProblems([]).length);
  assert.ok(occurredExpectProblems([{ contains: 'x', start: '2027-03-31', end: '2027-01-01' }]).some(p => /before its start/.test(p)));
  assert.ok(occurredExpectProblems([{ contains: 'x', none: true, start: '2027-01-01' }]).some(p => /none and a date/.test(p)));
  assert.ok(occurredExpectProblems([{ contains: 'x', start: 'March' , end: '2027-01-01' }]).some(p => /start must be/.test(p)));
  assert.ok(occurredExpectProblems([{ contains: 'x', start: '2027-01-01', end: '2027-01-01', when: 1 }]).some(p => /unknown key "when"/.test(p)));
});

test('occurredProblems: the range must match exactly; a state must carry none', async () => {
  const { occurredProblems, deterministicChecks, renderClaim } = await import('../evals/extraction/checks.mjs');
  const q1 = { category: 'timeline', content: 'Atlas Freight launches its carrier portal in Q1 2027.', tags: {}, occurred: { start: '2027-01-01', end: '2027-03-31' } };
  const team = { category: 'firmographic', content: 'Brindle has forty account executives.', tags: {} };
  assert.deepEqual(occurredProblems([q1, team], [{ contains: 'portal', start: '2027-01-01', end: '2027-03-31' }, { contains: 'forty', none: true }]), []);
  assert.equal(occurredProblems([q1], [{ contains: 'portal', start: '2027-01-01', end: '2027-01-01' }]).length, 1, 'a day is not the quarter');
  assert.equal(occurredProblems([], [{ contains: 'portal', start: '2027-01-01', end: '2027-03-31' }]).length, 1, 'no claim to check is not a pass');
  assert.deepEqual(occurredProblems([], [{ contains: 'forty', none: true }]), [], 'no state recorded dated nothing');
  assert.equal(occurredProblems([{ ...team, occurred: { start: '2026-10-14', end: '2026-10-14' } }], [{ contains: 'forty', none: true }]).length, 1);
  const c = { expect: { occurred: [{ contains: 'portal', start: '2027-01-01', end: '2027-03-31' }] }, input: { saidAt: '2026-11-03', text: 'We launch the portal in Q1.' } };
  assert.equal(deterministicChecks([q1], c).pass, true);
  assert.match(renderClaim(q1), /\[happened 2027-01-01 to 2027-03-31\]/);
  assert.match(renderClaim({ ...q1, occurred: { start: '2026-10-23', end: '2026-10-23' } }), /\[happened 2026-10-23\]/);
  assert.doesNotMatch(renderClaim(team), /happened/);
});

test('the temporal cases load and include the four GET-1051 cases, one of them minimum', async () => {
  const { loadCases } = await import('../evals/extraction/checks.mjs');
  const cases = await loadCases(new URL('../evals/extraction/cases/', import.meta.url).pathname);
  const ours = cases.filter(c => c.id.startsWith('tmp-occurred-'));
  assert.deepEqual(ours.map(c => c.id), ['tmp-occurred-past-event', 'tmp-occurred-coarse-quarter', 'tmp-occurred-next-friday', 'tmp-occurred-state-undated']);
  assert.deepEqual(ours.filter(c => c.minimum).map(c => c.id), ['tmp-occurred-state-undated']);
  assert.ok(ours.every(c => c.category === 'temporal' && c.expect.occurred?.length));
});

test('the eval claim carries the occurred range persistFacts would store', async () => {
  const { toEvalClaim } = await import('../evals/extraction/extract.mjs');
  const people = [{ id: CONTACT, name: 'Ines Halloran' }];
  const c = toEvalClaim({ category: 'tech_stack', about: 'company', content: 'x', fact_kind: 'event', occurred_start: '2026-03-01', occurred_end: '2026-03-31', contactId: CONTACT }, { people, account: { name: 'Brindle' }, saidAt: '2026-10-14' });
  assert.deepEqual([c.fact_kind, c.occurred], ['event', { start: '2026-03-01', end: '2026-03-31' }]);
  assert.equal(c.saidAt, '2026-10-14');
  const s = toEvalClaim({ category: 'firmographic', about: 'company', content: 'y', fact_kind: 'state', contactId: CONTACT }, { people, account: { name: 'Brindle' }, saidAt: '2026-10-14' });
  assert.equal(s.occurred, undefined);
});
