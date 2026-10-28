// Cause-and-effect links between facts (GET-1053): the model's `caused_by` positions held to the
// rules, stamped into refs before anything is filtered, mapped to the claims the facts became (or
// repeat), written once per conversation, and never in the way of extraction when the table is missing.
//
// Run: node --test apps/worker/tests/causeLinks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

for (const k of ['OPENROUTER_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL', 'NOUS_DEFAULT_TIMEZONE']) delete process.env[k];

const { registerAnthropicClient } = await import('@nous/core');
const {
  validCauses, stampCauses, CauseLedger, linksAmong, saveCauseLinks, CAUSE_RULES, CAUSED_BY_FIELD, MAX_CAUSES,
} = await import('../src/signals/causeLinks.mjs');
const { extractionSystemPrompt, buildActivitySignalsPrompt, buildMeetingSignalsMessages, extractFactsFromText, persistFacts } = await import('../src/signals/index.mjs');
const { saveOurSideFacts } = await import('../src/signals/ourSide.mjs');
const { repairTurn } = await import('../src/signals/extractionReply.mjs');
const { fakeDb } = await import('./fakeDb.mjs');

/** A fake model: `answer(params)` decides the text. */
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

// ── 1. validation ───────────────────────────────────────────────────────────────────────────

test('validCauses: only earlier, whole, distinct positions, at most two', () => {
  const table = [
    // [raw, own position, kept]
    [[0], 1, [0]],
    [[0, 1], 2, [0, 1]],
    [[0, 1, 2], 3, [0, 1]],                    // capped at MAX_CAUSES
    [[1], 1, []],                              // itself
    [[2], 1, []],                              // a later fact
    [[5], 2, []],                              // out of range
    [[-1], 2, []],                             // negative
    [[0.5], 2, []],                            // not a whole number
    [['0'], 2, [0]],                           // a quoted number counts
    [['zero', null, {}, true], 3, []],         // not numbers
    [[0, 0, 1], 3, [0, 1]],                    // duplicates once
    [[1, 1, 1, 0], 3, [1, 0]],                 // duplicates do not use up the cap
    [0, 1, [0]],                               // a lone number is a one-item list
    [undefined, 3, []],
    [null, 3, []],
    [[], 3, []],
    [[0], 0, []],                              // the first fact can have no cause
    [[NaN, Infinity], 4, []],
  ];
  for (const [raw, pos, want] of table) assert.deepEqual(validCauses(raw, pos), want, `${JSON.stringify(raw)} at ${pos}`);
  assert.equal(MAX_CAUSES, 2);
});

test('stampCauses: every object fact gets a ref, valid causes become refs, caused_by is gone', () => {
  const out = stampCauses([
    { content: 'CFO left', category: 'staff_change' },
    'not a fact',
    { content: 'Budget frozen', category: 'blocker', caused_by: [0, 2, 1] },   // 2 is itself, 1 the string (still a position)
    { content: 'Hiring SDRs', category: 'goal', caused_by: [7] },
  ], 'r1');
  assert.deepEqual(out[0], { content: 'CFO left', category: 'staff_change', fact_ref: 'r1:0' });
  assert.equal(out[1], 'not a fact', 'a non-object passes through for factProblem to drop');
  assert.deepEqual(out[2].caused_by_refs, ['r1:0', 'r1:1']);
  assert.equal('caused_by' in out[2], false);
  assert.equal(out[3].caused_by_refs, undefined, 'an invalid index leaves no cause');
  assert.equal(stampCauses(null), null);
  // Two reads never share a ref.
  const [a] = stampCauses([{ content: 'x' }]), [b] = stampCauses([{ content: 'x' }]);
  assert.notEqual(a.fact_ref, b.fact_ref);
});

test('the prompt: the rule and its sales examples in the shared system prompt, the field in both JSON shapes', () => {
  const sys = extractionSystemPrompt();
  assert.ok(sys.includes(CAUSE_RULES));
  assert.match(sys, /froze the budget after our CFO left/);
  assert.match(sys, /"status": "resolved", at position 1 with "caused_by": \[0\]/);
  assert.match(sys, /buying_signal\) at position 1 with "caused_by": \[0\]/);
  assert.match(sys, /Never guess/);
  const one = buildActivitySignalsPrompt({ contactName: 'Ines Halloran', company: 'Brindle', type: 'email_reply', summary: 'x' });
  const room = buildMeetingSignalsMessages({ roster: '1. Ines Halloran (Brindle)', transcript: 'x', maxFacts: 8 });
  for (const u of [one.user, room.user]) {
    assert.ok(u.includes(CAUSED_BY_FIELD));
    assert.match(u, /an index smaller than this fact's own position/);
  }
  assert.match(repairTurn({ status: 'unparseable', facts: [], problems: [], keys: [] }), /"caused_by"/);
});

// ── 2. extraction: refs survive the read ────────────────────────────────────────────────────

test('extractFactsFromText: a buyer fact can name our reply as its cause; refs survive routing and grounding', async () => {
  const text = `Ines Halloran: My worry is security, recordings cannot leave the EU.
Theo Bramwell: Every recording stays in our Frankfurt region, the security doc spells it out.
Ines Halloran: That settles it for me.`;
  fakeModel(JSON.stringify([
    { home: 'our_side', category: 'our_reply', content: 'Answered the EU data concern with the Frankfurt region.', answers: 'EU data', quote: 'Every recording stays in our Frankfurt region', speaker: 'Theo Bramwell' },
    { home: 'claim', importance: 'high', category: 'objection', status: 'resolved', hardness: 'hard', about: 'person', content: 'Ines Halloran was worried that recordings would leave the EU, and is now satisfied.', quote: 'That settles it for me.', speaker: 'Ines Halloran', caused_by: [0] },
    { home: 'claim', importance: 'high', category: 'goal', about: 'person', content: 'Ines Halloran wants to finish the review.', quote: '', caused_by: [5] },
  ]));
  const out = await extractFactsFromText({
    contactName: 'Ines Halloran', company: 'Brindle', type: 'meeting_held', text, check: false, fallback: false,
    ourSide: { companyName: 'Corvane', ownerName: 'Theo Bramwell', teamNames: [] }, ourNames: ['Theo Bramwell'],
  });
  assert.equal(out.ours.length, 1);
  const objection = out.facts.find(f => f.category === 'objection');
  assert.ok(objection, 'the objection is kept');
  assert.deepEqual(objection.caused_by_refs, [out.ours[0].fact_ref]);
  assert.equal(out.facts.find(f => f.category === 'goal').caused_by_refs, undefined, 'a forward index is dropped');
  const links = linksAmong([...out.facts, ...out.ours]);
  assert.deepEqual(links.map(l => [l.from.category, l.to.category]), [['objection', 'our_reply']]);
});

// ── 3. the ledger: refs → claims ────────────────────────────────────────────────────────────

test('CauseLedger: ADD, a repeat lands on the claim it repeats, a dropped end drops the link', () => {
  const [cfo, budget, hiring, repeat, dropped, effectOfDropped] = stampCauses([
    { content: 'CFO left' },
    { content: 'Budget frozen', caused_by: [0] },
    { content: 'Hiring SDRs' },
    { content: 'Budget frozen again', caused_by: [0] },        // will be a repeat of a claim on file
    { content: 'Dropped by a guard' },
    { content: 'Paused', caused_by: [4, 2] },
  ], 't');
  const L = new CauseLedger();
  L.claim(cfo, 'c-cfo');
  L.claim(budget, 'c-budget');
  L.claim(hiring, 'c-hiring');
  L.claim(repeat, 'c-on-file');          // SKIP: corroborates the claim on file
  // `dropped` never reaches a claim
  L.claim(effectOfDropped, 'c-paused');
  assert.deepEqual(L.links(), [
    { fromClaimId: 'c-budget', toClaimId: 'c-cfo', kind: 'caused_by' },
    { fromClaimId: 'c-on-file', toClaimId: 'c-cfo', kind: 'caused_by' },
    { fromClaimId: 'c-paused', toClaimId: 'c-hiring', kind: 'caused_by' },   // its link to the dropped fact is gone
  ]);
  assert.ok(dropped.fact_ref);
});

test('CauseLedger: a dropped SOURCE drops its links; two facts on one claim are no link; duplicates once', () => {
  const [a, b, c] = stampCauses([{ content: 'a' }, { content: 'b', caused_by: [0] }, { content: 'c', caused_by: [0, 1] }], 'u');
  const L = new CauseLedger();
  L.claim(a, 'same');
  L.claim(b, 'same');        // both repeat one claim: a claim is never its own cause
  // c was dropped by the signal check: never claimed
  assert.deepEqual(L.links(), []);
  const M = new CauseLedger();
  M.claim(a, 'x'); M.claim(b, 'y'); M.claim(b, 'y'); M.claim(c, 'y');
  assert.deepEqual(M.links(), [{ fromClaimId: 'y', toClaimId: 'x', kind: 'caused_by' }]);
  // No ref or no id: ignored.
  M.claim({ content: 'no ref' }, 'z'); M.claim(a, null);
  assert.equal(M.links().length, 1);
});

// ── 4. persistence ──────────────────────────────────────────────────────────────────────────

const WS = '00000000-0000-4000-8000-000000000001';
const CONTACT = '00000000-0000-4000-8000-000000000002';
const COMPANY = '00000000-0000-4000-8000-000000000003';
const SAID = '2026-10-23T15:00:00.000Z';

/** fakeDb with real uuids for new claims (links need them), and a claim_links table that can be "missing". */
function db({ missing = false, claims = [] } = {}) {
  const d = fakeDb({
    workspaces: [{ id: WS, name: 'Corvane' }],
    contacts: [{ id: CONTACT, workspace_id: WS, first_name: 'Ines', last_name: 'Halloran', company: 'Brindle', company_id: COMPANY }],
    entities: [{ id: CONTACT, workspace_id: WS, type: 'person' }, { id: COMPANY, workspace_id: WS, type: 'company' }],
    claims,
  });
  const from = d.from;
  d.from = (t) => {
    const q = from(t);
    if (t === 'claims') {
      const insert = q.insert;
      q.insert = (v) => insert((Array.isArray(v) ? v : [v]).map(r => ({ id: randomUUID(), invalid_at: null, ...r })));
    }
    if (t === 'claim_links' && missing) {
      const fail = { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.claim_links' in the schema cache" } };
      q.upsert = () => ({ then: (res) => Promise.resolve(fail).then(res) });
    }
    return q;
  };
  return d;
}
const buyer = (over) => ({ about: 'company', quote: '', contactId: CONTACT, companyId: COMPANY, activityId: null, ...over });

test('persistFacts + saveOurSideFacts + saveCauseLinks: links between the claims the facts became', async () => {
  fakeModel('[]');
  const sb = db();
  const [reply, cfo, budget, objection] = stampCauses([
    { category: 'our_reply', content: 'Answered the EU data concern with the Frankfurt region.', quote: 'Frankfurt region', speaker: 'Theo Bramwell' },
    { category: 'staff_change', change: 'left', content: "Brindle's CFO, Wendell Ashcombe, left the company." },
    { category: 'blocker', status: 'open', content: 'Brindle froze its budget for new tools.', caused_by: [1] },
    { category: 'objection', status: 'resolved', hardness: 'hard', content: 'Brindle was worried recordings would leave the EU, now resolved.', caused_by: [0] },
  ], 'p');
  const L = new CauseLedger();
  await persistFacts(sb, WS, [cfo, budget, objection].map(buyer), { type: 'meeting_held', source: 'test', occurredAt: SAID, links: L });
  await saveOurSideFacts(sb, WS, [{ ...reply, contactId: CONTACT, companyId: COMPANY, activityId: null }], { type: 'meeting_held', source: 'test', sourceRef: 'source://test/m1', occurredAt: SAID, links: L });
  assert.equal(await saveCauseLinks(sb, WS, L), 2);
  // By category: the wording pass may rephrase a sentence on its way in.
  const idOf = (cat) => sb.tables.claims.find(c => c.value?.category === cat)?.id;
  const rows = sb.tables.claim_links.map(l => [l.from_claim_id, l.to_claim_id, l.kind, l.archived_at]);
  assert.ok(['staff_change', 'blocker', 'objection', 'our_reply'].every(idOf), 'every fact filed');
  assert.deepEqual(new Set(rows.map(JSON.stringify)), new Set([
    [idOf('blocker'), idOf('staff_change'), 'caused_by', null],
    [idOf('objection'), idOf('our_reply'), 'caused_by', null],
  ].map(JSON.stringify)));
  assert.ok(sb.tables.claim_links.every(l => l.workspace_id === WS));
  // Nothing of the refs reaches the stored claim.
  for (const c of sb.tables.claims) assert.equal(JSON.stringify(c.value).includes('fact_ref') || JSON.stringify(c.value).includes('caused_by'), false);
});

test('a fact the merge judges a repeat links through the claim it corroborates', async () => {
  const onFile = randomUUID();
  // The live blocker on file that the new one repeats (a deal topic: offered to the merge model).
  const claims = [{ id: onFile, workspace_id: WS, entity_id: COMPANY, property: 'note.on-file', invalid_at: null, valid_from: '2026-10-20T00:00:00.000Z',
    value: { category: 'blocker', content: 'Brindle froze its budget for new tools.', metadata: { about: 'company', status: 'open' } }, supporting_observation_ids: [] }];
  fakeModel(({ messages }) => (String(messages?.[0]?.content ?? '').includes('atomic fact memory store') ? `[{"n":1,"decision":"SKIP:${onFile}"}]` : '[]'));
  const sb = db({ claims });
  const [cfo, budget] = stampCauses([
    { category: 'staff_change', change: 'left', content: "Brindle's CFO, Wendell Ashcombe, left the company." },
    { category: 'blocker', status: 'open', content: 'Brindle has frozen its budget for new tools.', caused_by: [0] },
  ], 'q');
  const L = new CauseLedger();
  const out = await persistFacts(sb, WS, [cfo, budget].map(buyer), { type: 'meeting_held', source: 'test', occurredAt: SAID, links: L });
  const skipped = out.find(f => f.category === 'blocker');
  assert.equal(skipped?.action, 'SKIP', `the blocker is a repeat (got ${out.map(f => `${f.category}:${f.action}`).join(', ')})`);
  await saveCauseLinks(sb, WS, L);
  const cfoId = sb.tables.claims.find(c => c.value?.category === 'staff_change').id;
  assert.deepEqual(sb.tables.claim_links.map(l => [l.from_claim_id, l.to_claim_id]), [[onFile, cfoId]]);
});

test('a fact a guard drops takes its links with it', async () => {
  fakeModel('[]');
  const sb = db();
  const [cfo, budget] = stampCauses([
    // Never names Brindle or Ines: the subject guard drops it.
    { category: 'staff_change', change: 'left', content: 'The CFO left last month.' },
    { category: 'blocker', status: 'open', content: 'Brindle froze its budget for new tools.', caused_by: [0] },
  ], 'g');
  const L = new CauseLedger();
  await persistFacts(sb, WS, [cfo, budget].map(f => buyer({ ...f, about: 'company' })), { type: 'meeting_held', source: 'test', occurredAt: SAID, links: L });
  assert.equal(sb.tables.claims.filter(c => c.value?.category === 'staff_change').length, 0, 'the guard dropped the cause');
  assert.equal(await saveCauseLinks(sb, WS, L), 0);
  assert.equal((sb.tables.claim_links ?? []).length, 0);
});

test('our side: a reply repeated from the same source links through the claim on file', async () => {
  fakeModel('[]');
  const onFile = randomUUID();
  const sb = db({ claims: [{ id: onFile, workspace_id: WS, entity_id: COMPANY, property: 'note.r', invalid_at: null,
    'value->metadata->>side': 'ours', 'value->metadata->>source_ref': 'source://test/m1',
    value: { category: 'our_reply', content: 'Answered the EU data concern with the Frankfurt region.', metadata: { side: 'ours', source_ref: 'source://test/m1' } } }] });
  const [reply] = stampCauses([{ category: 'our_reply', content: 'Answered the EU data concern with the Frankfurt region.', quote: 'Frankfurt', speaker: 'Theo Bramwell' }], 'o');
  const L = new CauseLedger();
  const written = await saveOurSideFacts(sb, WS, [{ ...reply, contactId: CONTACT, companyId: COMPANY }], { sourceRef: 'source://test/m1', links: L });
  assert.equal(written.length, 0, 'nothing filed twice');
  assert.equal(L.claimOf.get(reply.fact_ref), onFile);
});

test('fail-safe: without the claim_links table, extraction files its claims as before and nothing throws', async () => {
  fakeModel('[]');
  const sb = db({ missing: true });
  const [cfo, budget] = stampCauses([
    { category: 'staff_change', change: 'left', content: "Brindle's CFO, Wendell Ashcombe, left the company." },
    { category: 'blocker', status: 'open', content: 'Brindle froze its budget for new tools.', caused_by: [0] },
  ], 'm');
  const L = new CauseLedger();
  const out = await persistFacts(sb, WS, [cfo, budget].map(buyer), { type: 'meeting_held', source: 'test', occurredAt: SAID, links: L });
  assert.equal(out.filter(f => f.action !== 'SKIP').length, 2);
  assert.equal(L.links().length, 1, 'the link was resolved');
  assert.equal(await saveCauseLinks(sb, WS, L), 0, 'and quietly not written');
  assert.equal(sb.tables.claims.filter(c => String(c.property).startsWith('note.')).length, 2);
  // A dry run writes nothing at all.
  assert.equal(await saveCauseLinks(db(), WS, L, { dryRun: true }), 0);
});

test('a link to a claim filed already retired is written archived', async () => {
  fakeModel('[]');
  const sb = db();
  const L = new CauseLedger();
  const [x, y] = stampCauses([{ content: 'x' }, { content: 'y', caused_by: [0] }], 'z');
  const live = randomUUID(), retired = randomUUID();
  sb.tables.claims.push({ id: live, workspace_id: WS, invalid_at: null }, { id: retired, workspace_id: WS, invalid_at: '2026-10-23T00:00:00.000Z' });
  L.claim(x, retired); L.claim(y, live);
  assert.equal(await saveCauseLinks(sb, WS, L), 1);
  assert.ok(sb.tables.claim_links[0].archived_at, 'archived: its cause is history');
});

// ── 5. the eval's deterministic check ───────────────────────────────────────────────────────

test('expect.links: valid shapes pass, malformed ones are named', async () => {
  const { linksExpectProblems, validateCase } = await import('../evals/extraction/checks.mjs');
  assert.deepEqual(linksExpectProblems([{ from: 'blocker', to: 'staff_change' }, { from: 'objection', to: 'our_reply' }]), []);
  assert.deepEqual(linksExpectProblems([]), [], '[] means "no link"');
  assert.ok(linksExpectProblems({}).length);
  assert.ok(linksExpectProblems([{ from: 'blocker', to: 'nope' }]).some(p => /"nope" is not/.test(p)));
  assert.ok(linksExpectProblems([{ from: 'blocker', to: 'staff_change', why: 1 }]).some(p => /unknown key "why"/.test(p)));
  assert.ok(validateCase({ id: 'x', category: 'attribution', origin: 'o', input: { kind: 'meeting', saidAt: '2026-10-23', account: { name: 'A' }, people: [{ name: 'P Q' }], ourSide: { company: 'C', names: [] }, text: 'x'.repeat(30) }, must: [], traps: [], expect: { links: [{ from: 'x', to: 'y' }] } })
    .some(e => /expect\.links/.test(e)));
});

test('linkProblems: present, absent, none expected; a link to a fact not filed does not count', async () => {
  const { linkProblems, deterministicChecks } = await import('../evals/extraction/checks.mjs');
  const cfo = { category: 'staff_change', content: 'CFO left', ref: 'r:0' };
  const budget = { category: 'blocker', content: 'Budget frozen', ref: 'r:1', causedBy: ['r:0'] };
  const reply = { category: 'our_reply', content: 'Sent the security doc', ref: 'r:2' };
  const objection = { category: 'objection', content: 'Security resolved', ref: 'r:3', causedBy: ['r:2'] };
  assert.deepEqual(linkProblems([cfo, budget, objection], [reply], [{ from: 'blocker', to: 'staff_change' }, { from: 'objection', to: 'our_reply' }]), []);
  assert.equal(linkProblems([cfo, budget], [], [{ from: 'objection', to: 'our_reply' }]).length, 1);
  assert.match(linkProblems([cfo, budget], [], [])[0], /expected none, got 1/);
  assert.deepEqual(linkProblems([budget], [], []), [], 'its cause was not filed: no link');
  assert.deepEqual(linkProblems([cfo, budget], [], undefined), [], 'no expectation, no check');
  const c = { input: { saidAt: '2026-10-23', text: '' }, expect: { links: [] } };
  assert.equal(deterministicChecks([cfo, budget], c, []).pass, false);
});

test('the eval claim and our side\'s fact carry their ref and causes', async () => {
  const { toEvalClaim, toEvalOurs } = await import('../evals/extraction/extract.mjs');
  const people = [{ id: CONTACT, name: 'Ines Halloran' }];
  const c = toEvalClaim({ category: 'blocker', about: 'company', content: 'x', contactId: CONTACT, fact_ref: 'r:1', caused_by_refs: ['r:0'] }, { people, account: { name: 'Brindle' }, saidAt: '2026-10-23' });
  assert.deepEqual([c.ref, c.causedBy], ['r:1', ['r:0']]);
  const o = toEvalOurs({ category: 'our_reply', content: 'y', fact_ref: 'r:0' });
  assert.deepEqual([o.ref, o.causedBy], ['r:0', undefined]);
});
