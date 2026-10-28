// Our side's words as their own facts (GET-1052). Speaker roles are explicit in every extraction
// input; what our side said comes back in its own home (our_side: our_reply, commitment,
// pitch_line), is checked on its own (a verbatim quote our side spoke), and is filed on the account
// flagged side = 'ours'. The buyer guards still hold: a rep's guess is never the buyer's fact.
// No network: the model is a registered fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const k of ['OPENROUTER_API_KEY', 'LLM_API_KEY', 'LLM_BASE_URL', 'EXTRACTION_MODEL', 'EXTRACTION_FALLBACK_MODEL', 'INSIGHT_BOARD_MODEL', 'OPENAI_API_KEY']) delete process.env[k];

const { registerAnthropicClient, OUR_SIDE } = await import('@nous/core');
const {
  extractFactsFromText, buildActivitySignalsPrompt, buildMeetingSignalsMessages, extractionSystemPrompt, routeFacts, splitOurs, markOurs,
} = await import('../src/signals/index.mjs');
const { speakerRolesLine, sellerNames, checkOurSide, isOurName, ourSideMetadata, saveOurSideFacts } = await import('../src/signals/ourSide.mjs');
const { factProblem } = await import('../src/signals/extractionReply.mjs');
const { buildAccountBrief } = await import('../src/signals/accountBrief.mjs');
const { checkSignals } = await import('../src/signals/signalCheck.mjs');

const OUR = { ownerName: 'Theo Bramwell', teamNames: ['Theo Bramwell', 'Mira Castell'], companyName: 'Quillfield', offer: null };

function fakeModel(answers) {
  const sent = [];
  registerAnthropicClient({
    messages: {
      create: async (params) => {
        sent.push(params);
        const text = answers[Math.min(sent.length - 1, answers.length - 1)];
        return { model: params.model, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: 'end_turn' };
      },
    },
  }, { acceptsFeature: false });
  return sent;
}

// ── the prompt ───────────────────────────────────────────────────────────────

test('every extraction input names who is the seller and who is the buyer', () => {
  assert.equal(speakerRolesLine(OUR, ['Ines Halloran']), 'SPEAKER ROLES: Theo Bramwell, Mira Castell (Quillfield) = seller (our side); Ines Halloran = buyer.');
  assert.equal(speakerRolesLine(null, []), 'SPEAKER ROLES: our team = seller (our side); everyone else = buyer.');
  const one = buildActivitySignalsPrompt({ contactName: 'Ines Halloran', company: 'Brindle', type: 'meeting_held', summary: 't', ourSide: OUR });
  assert.match(one.user, /SPEAKER ROLES: Theo Bramwell, Mira Castell \(Quillfield\) = seller \(our side\); Ines Halloran = buyer\./);
  const thread = buildActivitySignalsPrompt({ contactName: 'Ines Halloran', type: 'conversation_thread', summary: 't', ourSide: OUR });
  assert.match(thread.user, /= buyer\. Lines beginning "You:" are the seller's\./);
  const meeting = buildMeetingSignalsMessages({ roster: '1. Ines Halloran (Brindle)\n2. Odile Marsh (Brindle)', transcript: 't', maxFacts: 8, ourSide: OUR });
  assert.match(meeting.user, /= seller \(our side\); Ines Halloran, Odile Marsh = buyer\./);
});

test('the shared system prompt carries the our_side home and its rules', () => {
  const sys = extractionSystemPrompt();
  assert.match(sys, /home "our_side"/);
  for (const k of ['our_reply —', 'commitment —', 'pitch_line —']) assert.ok(sys.includes(k), `${k} is described`);
  assert.match(sys, /GUESS about the buyer \("you'd find \$700 expensive"/);
  assert.match(sys, /a pitch_line at most: never a fact about them, never home "claim"/);
  assert.match(sys, /two facts — the objection \(home "claim", their quote\) and our_reply \(home "our_side", our quote\)/);
  assert.match(sys, /Small talk, greetings, scheduling, and questions we asked are nothing/);
  // The buyer taxonomy never offers our categories.
  assert.doesNotMatch(sys.split('OUR SIDE\'S WORDS')[0], /our_reply|pitch_line/);
  const one = buildActivitySignalsPrompt({ contactName: 'Ines Halloran', type: 'meeting_held', summary: 't' });
  assert.match(one.user, /"home": "claim\|our_product\|market\|our_side"/);
  assert.match(one.user, /"answers": "<our_reply only/);
});

// ── routing and the light check ──────────────────────────────────────────────

test('our_side facts get their own list, outside the claims and the claims about us', () => {
  const { claims, aboutUs, ours, routed } = routeFacts([
    { home: 'claim', importance: 'high', category: 'objection', content: 'Ines Halloran doubts the HubSpot sync.' },
    { home: 'our_side', category: 'our_reply', content: 'Answered the sync doubt with the write-back demo.', answers: 'HubSpot sync', kind: 'stray' },
    // Filed under an our-side category with the wrong home: still ours, never a buyer claim.
    { home: 'claim', importance: 'high', category: 'pitch_line', content: 'Framed it as replacing two tools.' },
  ]);
  assert.deepEqual(claims.map(c => c.category), ['objection']);
  assert.equal(aboutUs.length, 0);
  assert.deepEqual(ours.map(c => c.category), ['our_reply', 'pitch_line']);
  assert.equal(ours[0].kind, undefined, 'no about-us fields');
  assert.equal(routed.our_side, 2);
  assert.equal(factProblem({ home: 'our_side', category: 'commitment', content: 'x' }), null);
  assert.match(factProblem({ home: 'our_side', category: 'objection', content: 'x' }), /not our_reply, commitment or pitch_line/);
  const { rest, ours: split } = splitOurs([{ content: 'a' }, markOurs({ content: 'b' })]);
  assert.deepEqual([rest.length, split.length], [1, 1]);
  assert.equal(Object.getOwnPropertySymbols(split[0]).length, 0);
});

const CALL = [
  'Ines Halloran: Honestly I am not sure the HubSpot sync keeps up with how fast we move.',
  'Theo Bramwell: Fair. The sync writes every task back within a minute, I can show you the log.',
  'Theo Bramwell: And I am guessing you would find seven hundred a month expensive for a team your size.',
  'Ines Halloran: We have not set a budget yet, our CFO decides that.',
  'Theo Bramwell: I will send the security doc by Friday.',
  'Theo Bramwell: How was the weekend, did you get out to the coast?',
].join('\n');

test('the light check: a verbatim quote our side spoke, or nothing', () => {
  const kept = checkOurSide([
    { category: 'our_reply', content: 'Answered the sync doubt.', quote: 'The sync writes every task back within a minute', speaker: 'Theo Bramwell' },
    // The buyer's words cannot be ours.
    { category: 'pitch_line', content: 'Said the sync keeps up.', quote: 'not sure the HubSpot sync keeps up', speaker: 'Theo Bramwell' },
    // A made-up quote.
    { category: 'pitch_line', content: 'Promised a discount.', quote: 'we will give you forty percent off', speaker: 'Theo Bramwell' },
    { category: 'commitment', content: 'Promised the security doc by Friday.', quote: 'I will send the security doc by Friday', speaker: 'Theo Bramwell' },
  ], { text: CALL, ourNames: sellerNames(OUR) });
  assert.deepEqual(kept.map(f => f.category), ['our_reply', 'our_commitment']);
  assert.deepEqual(checkOurSide([{ category: 'our_reply', content: 'x', quote: 'The sync writes every task back within a minute' }], { text: CALL, ourNames: [] }), [], 'no names, no way to tell');
  // No speaker labels in the text (a single message): the model's speaker must be ours.
  const note = 'I will send the security doc by Friday and the pricing sheet too.';
  assert.equal(checkOurSide([{ category: 'commitment', content: 'x', quote: 'I will send the security doc by Friday', speaker: 'Theo' }], { text: note, ourNames: ['Theo Bramwell'] }).length, 1);
  assert.equal(checkOurSide([{ category: 'commitment', content: 'x', quote: 'I will send the security doc by Friday', speaker: 'Ines Halloran' }], { text: note, ourNames: ['Theo Bramwell'] }).length, 0);
  assert.equal(isOurName('theo', ['Theo Bramwell']), true);
  assert.equal(isOurName('Ines', ['Theo Bramwell']), false);
});

// ── end to end, through the read ─────────────────────────────────────────────

test('one read: the buyer objection is a claim, our answer and promise are ours, the rep\'s guess is no buyer fact', async () => {
  fakeModel([JSON.stringify([
    { home: 'claim', importance: 'high', category: 'objection', about: 'person', status: 'open', hardness: 'soft', label: 'Doubts HubSpot sync', content: 'Ines Halloran doubts the HubSpot sync keeps up with how fast Brindle moves.', quote: 'not sure the HubSpot sync keeps up with how fast we move', speaker: 'Ines Halloran' },
    { home: 'our_side', category: 'our_reply', answers: 'Doubts HubSpot sync', content: 'Answered the HubSpot sync doubt by saying tasks write back within a minute.', quote: 'The sync writes every task back within a minute', speaker: 'Theo Bramwell' },
    // The guess, filed (wrongly) by the model as the buyer's budget: the our-side-quote guard drops it.
    { home: 'claim', importance: 'high', category: 'budget', about: 'person', content: 'Ines Halloran would find $700 a month expensive.', quote: 'you would find seven hundred a month expensive', speaker: 'Theo Bramwell' },
    // …and filed as what it is: a pitch line at most.
    { home: 'our_side', category: 'pitch_line', content: 'Guessed Ines Halloran would find $700 a month expensive for her team.', quote: 'you would find seven hundred a month expensive', speaker: 'Theo Bramwell' },
    { home: 'our_side', category: 'commitment', content: 'Promised to send the security doc by Friday, October 23, 2026.', quote: 'I will send the security doc by Friday', speaker: 'Theo Bramwell', fact_kind: 'event', occurred_start: '2026-10-23' },
  ])]);
  const out = await extractFactsFromText({
    contactName: 'Ines Halloran', company: 'Brindle', type: 'meeting_held', text: CALL, ourSide: OUR, ourNames: ['Theo Bramwell'],
    fallback: false, check: false, anchor: '2026-10-20',
  });
  assert.deepEqual(out.facts.map(f => f.category), ['objection'], 'no budget from our guess');
  assert.deepEqual(out.ours.map(f => f.category), ['our_reply', 'pitch_line', 'our_commitment']);
  const reply = out.ours[0];
  assert.equal(reply.answers, out.facts[0].label, 'the reply is linked to the objection by what it answered');
  assert.equal(reply.speaker, 'Theo Bramwell');
  assert.equal(out.ours[2].occurred_start, '2026-10-23');
});

test('small talk from our side yields nothing', async () => {
  fakeModel(['[]']);
  const out = await extractFactsFromText({
    contactName: 'Ines Halloran', type: 'meeting_held', text: 'Theo Bramwell: How was the weekend, did you get out to the coast?\nInes Halloran: Lovely, thanks.',
    ourSide: OUR, ourNames: ['Theo Bramwell'], fallback: false, check: false,
  });
  assert.deepEqual([out.facts.length, out.ours.length], [0, 0]);
});

// ── storage ──────────────────────────────────────────────────────────────────

function fakeDb(existing = []) {
  const inserts = [];
  return {
    inserts,
    from() {
      const q = {
        select() { return q; }, eq() { return q; }, like() { return q; }, is() { return q; }, limit() { return q; }, update() { return q; }, order() { return q; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(row) { inserts.push(row); q.row = row; return q; },
        single() { return Promise.resolve({ data: { id: `c${inserts.length}`, ...q.row }, error: null }); },
        then(res, rej) { return Promise.resolve({ data: existing, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test('filed on the account, flagged side = ours, said to the buyer, the commitment dated; a re-read files nothing twice', async () => {
  const sb = fakeDb([{ value: { category: 'pitch_line', content: 'Framed it as replacing two tools.' } }]);
  const written = await saveOurSideFacts(sb, 'ws', [
    { category: 'our_commitment', content: 'Promised to send the security doc by Friday, October 23, 2026.', quote: 'I will send the security doc by Friday', speaker: 'Theo Bramwell', fact_kind: 'event', occurred_start: '2026-10-23', contactId: 'p-ines', companyId: 'co-brindle', activityId: 'obs-1' },
    { category: 'our_reply', content: 'Answered the sync doubt.', quote: 'q', speaker: 'Theo Bramwell', answers: 'HubSpot sync', contactId: 'p-ines', companyId: 'co-brindle' },
    { category: 'pitch_line', content: 'Framed it as replacing two tools.', quote: 'q', speaker: 'Theo Bramwell', contactId: 'p-ines', companyId: 'co-brindle' },
  ], { type: 'meeting_held', source: 'fireflies', sourceRef: 'source://fireflies/m1', occurredAt: '2026-10-20T15:00:00Z' });
  assert.equal(written.length, 2, 'the pitch line from the same source is already on file');
  const [commit, reply] = sb.inserts;
  assert.equal(commit.entity_id, 'co-brindle');
  assert.equal(commit.value.category, 'our_commitment');
  assert.equal(commit.value.metadata.side, OUR_SIDE);
  assert.equal(commit.value.metadata.said_to_contact_id, 'p-ines');
  assert.equal(commit.value.metadata.voiced_by_contact_id, undefined, 'never "voiced by" the buyer');
  assert.equal(commit.value.metadata.occurred_start, '2026-10-23');
  assert.equal(commit.value.metadata.source_ref, 'source://fireflies/m1');
  assert.deepEqual(commit.supporting_observation_ids, ['obs-1']);
  assert.equal(reply.value.metadata.answers, 'HubSpot sync');
  assert.equal(reply.value.metadata.fact_kind, undefined, 'a reply is not dated as an event');
  assert.deepEqual(await saveOurSideFacts(sb, 'ws', [{ category: 'our_reply', content: 'x', contactId: 'p' }], { dryRun: true }), []);
  assert.equal(ourSideMetadata({ category: 'pitch_line', contactId: 'p' }).side, 'ours');
});

// ── buyer readers in the worker ──────────────────────────────────────────────

test('the account brief never reads our side as what the buyer is doing', () => {
  const brief = buildAccountBrief({ account: { name: 'Brindle' }, notes: [
    { category: 'goal', content: 'Brindle wants to cut manual CRM entry.', said_at: '2026-10-10', metadata: {} },
    { category: 'goal', content: 'Our pitch: cut manual CRM entry by half.', said_at: '2026-10-11', metadata: { side: OUR_SIDE } },
    { category: 'pitch_line', content: 'Framed it as replacing two tools.', said_at: '2026-10-11', metadata: { side: OUR_SIDE } },
  ] });
  assert.match(brief, /Brindle wants to cut manual CRM entry/);
  assert.doesNotMatch(brief, /Our pitch|replacing two tools/);
});

test('the deal-signal second read leaves our side\'s facts alone (it never sees them, and would not touch them)', async () => {
  const facts = [{ category: 'our_reply', content: 'Answered it.' }, { category: 'pitch_line', content: 'Pitched it.' }];
  const sent = fakeModel(['[]']);
  assert.deepEqual(await checkSignals(facts, { text: CALL }), facts);
  assert.equal(sent.length, 0, 'no model call for our side');
});

test('an email thread: our quotes rest on our own messages only', async () => {
  const { sideBlocks } = await import('../src/noema/grounding.mjs');
  const thread = '--- them · 2026-10-20 ---\nCan you confirm the export works with our warehouse?\n--- us · 2026-10-21 ---\nYes, the nightly export lands in your warehouse by 6am, I will send the setup guide tomorrow.';
  const facts = [
    { category: 'commitment', content: 'Promised the setup guide.', quote: 'I will send the setup guide tomorrow', speaker: '' },
    { category: 'pitch_line', content: 'Said the export works.', quote: 'Can you confirm the export works', speaker: 'Theo Bramwell' },
  ];
  const kept = checkOurSide(facts, { text: sideBlocks(thread, 'us'), ourNames: [], allOurs: true });
  assert.deepEqual(kept.map(f => f.category), ['our_commitment'], 'the buyer\'s line is not ours, whoever the model named');
});
