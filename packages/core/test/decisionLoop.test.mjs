// The edit label — the one column of the recommendation-to-outcome dataset that only we can
// produce, because only a system between the draft and the send holds both versions. These
// lock the two ways it goes wrong: cosmetic changes counted as edits (poisoning the label),
// and a real rewrite counted as a clean acceptance (inflating how good our advice looks).
// Plus the draft-vs-send split, which is what keeps an unsent draft out of the "we acted" column.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/decisionLoop.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editMetrics, hashBody, confirmByAction, proposeDecision, summarizeDecisions, mirrorDraftAsDecision, recordVerdict } from '../dist/db/decisions.mjs';

const DRAFT = 'Hi Dana, picking this back up after the security review you mentioned. Worth 20 minutes on Thursday?';

test('a verbatim send is accepted, not edited', () => {
  const m = editMetrics(DRAFT, DRAFT);
  assert.equal(m.verdict, 'accepted');
  assert.equal(m.edit_distance, 0);
  assert.equal(m.edit_ratio, 0);
});

test('whitespace and casing are not edits', () => {
  const reflowed = '  hi dana,   picking this back up after the security review you mentioned.\n\nWorth 20 minutes on Thursday?  ';
  assert.equal(editMetrics(DRAFT, reflowed).verdict, 'accepted');
});

test('a real rewrite is an edit, and the ratio scales with how much was changed', () => {
  const tweaked = DRAFT.replace('Worth 20 minutes on Thursday?', 'Worth 20 minutes on Friday?');
  const rewritten = 'Dana - following up. Free Friday?';
  const small = editMetrics(DRAFT, tweaked);
  const large = editMetrics(DRAFT, rewritten);
  assert.equal(small.verdict, 'edited');
  assert.equal(large.verdict, 'edited');
  assert.ok(small.edit_ratio > 0 && small.edit_ratio < 0.3, `small edit ratio was ${small.edit_ratio}`);
  assert.ok(large.edit_ratio > small.edit_ratio, 'a rewrite must score above a tweak');
});

test('an empty draft and an empty send do not register as an edit', () => {
  assert.equal(editMetrics('', '').verdict, 'accepted');
});

test('non-string input yields no metrics rather than a false label', () => {
  assert.equal(editMetrics(null, DRAFT), null);
  assert.equal(editMetrics(DRAFT, undefined), null);
});

test('hashBody normalizes, so the hook and the server agree on "unchanged"', () => {
  // The hook hashes what went out; the server holds the hash of what was drafted. If these
  // disagreed on whitespace, every send would look edited.
  assert.equal(hashBody(DRAFT), hashBody(`  ${DRAFT.toUpperCase()}  `));
  assert.notEqual(hashBody(DRAFT), hashBody(`${DRAFT} PS - one more thing.`));
  assert.equal(hashBody('   '), null);
});


// ── The draft/send split ──────────────────────────────────────────────────────────────────
// A minimal supabase stand-in: enough query builder to observe which writes happen. The point
// of these tests is not the SQL, it's that a draft never gets counted as a send.
function fakeSupabase(proposal) {
  const writes = [];
  const builder = (table) => {
    const state = { table, op: null, patch: null };
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      gte() { return chain; },
      in() { return chain; },
      order() { return chain; },
      limit() { return Promise.resolve({ data: [proposal] }); },
      maybeSingle() {
        if (state.op === 'update') { writes.push(state.patch); return Promise.resolve({ data: proposal }); }
        return Promise.resolve({ data: proposal });          // the recordVerdict lookup
      },
      single() { writes.push(state.patch); return Promise.resolve({ data: { ...proposal, ...state.patch } }); },
      update(patch) { state.op = 'update'; state.patch = patch; return chain; },
      upsert(row) { state.op = 'upsert'; state.patch = row; return chain; },
    };
    return chain;
  };
  return { from: builder, writes };
}

const DRAFTED_HASH = hashBody(DRAFT);

test('a draft records the verdict but never confirms — an unsent draft is not an action', async () => {
  const db = fakeSupabase({ id: 'd1', decision_id: 'cc-1', proposal_hash: DRAFTED_HASH, verdict: 'pending' });
  const out = await confirmByAction(db, 'ws-1', {
    recipient: 'tara@quillfield.example', provider: 'gmail', sent_hash: DRAFTED_HASH, stage: 'drafted',
  });
  assert.equal(out.status, 'verdict_recorded');
  assert.ok(db.writes.some(w => w.verdict === 'accepted'), 'the yes should be recorded');
  assert.ok(!db.writes.some(w => w.status === 'confirmed'), 'a draft must NOT confirm the decision');
});

test('a send confirms, and a body rewritten after the draft flips the verdict to edited', async () => {
  // The flow that actually happens: agent drafts, human edits it in Gmail, human sends. Nobody
  // reports the edit — the ingested body simply hashes differently from what we drafted.
  const db = fakeSupabase({ id: 'd1', decision_id: 'cc-1', proposal_hash: DRAFTED_HASH, verdict: 'accepted' });
  const out = await confirmByAction(db, 'ws-1', {
    recipient: 'tara@quillfield.example', provider: 'gmail', provider_message_id: 'm-1',
    sent_hash: hashBody(`${DRAFT} PS - also, congrats on the retention numbers.`), stage: 'sent',
  });
  assert.equal(out.status, 'confirmed');
  assert.ok(db.writes.some(w => w.verdict === 'edited'), 'a changed body must re-label as edited');
  assert.ok(db.writes.some(w => w.status === 'confirmed'), 'a send must confirm');
});

test('a send with no matching proposal is reported, not invented', async () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [] }) }) }) }) }) }) }) }) };
  const out = await confirmByAction(db, 'ws-1', { recipient: 'nobody@example.com', stage: 'sent' });
  assert.equal(out.status, 'unmatched');
  assert.equal(out.reason, 'no_open_proposal');
});

test('an action with no recipient cannot be matched, and says so', async () => {
  const out = await confirmByAction(fakeSupabase({}), 'ws-1', { stage: 'sent' });
  assert.equal(out.status, 'unmatched');
  assert.equal(out.reason, 'no_recipient');
});

// ── The ICP snapshot ──────────────────────────────────────────────────────────────────────
// The leakage guard. Today's score moved partly BECAUSE the deal progressed, so a decision has
// to carry the score it was made under. These lock that it is captured on the first write and
// never re-stamped afterwards — the retry path is the quiet way this protection gets lost.
function fakeDbForPropose({ prior = null, prediction = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      const chain = { _patch: null };
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.maybeSingle = () =>
        Promise.resolve({ data: table === 'predictions' ? prediction : prior });
      chain.upsert = (row) => { chain._patch = row; writes.push(row); return chain; };
      chain.single = () => Promise.resolve({ data: chain._patch });
      return chain;
    },
  };
}

const PREDICTION = { id: 'pred-1', predicted_value: { score: 68, fit: 'strong' } };

test('a new decision captures the ICP score as it stands right now', async () => {
  const db = fakeDbForPropose({ prediction: PREDICTION });
  await proposeDecision(db, 'ws-1', {
    decision_id: 'cc-1', proposal: 'follow up on the security review', entity_id: 'e-1',
  });
  const row = db.writes[0];
  assert.equal(row.prediction_id, 'pred-1');
  assert.equal(row.icp_score_at_decision, 68);
});

test('re-proposing keeps the ORIGINAL score, not the one that is true today', async () => {
  // The retry path. proposeDecision is idempotent, and an upsert that re-read the score would
  // silently replace the number we acted under with one the deal's own progress produced.
  const db = fakeDbForPropose({
    prior: { prediction_id: 'pred-1', icp_score_at_decision: 68 },
    prediction: { id: 'pred-9', predicted_value: { score: 91 } },   // rescored since
  });
  await proposeDecision(db, 'ws-1', {
    decision_id: 'cc-1', proposal: 'follow up on the security review', entity_id: 'e-1',
  });
  const row = db.writes[0];
  assert.equal(row.icp_score_at_decision, 68, 'must not adopt the newer score');
  assert.equal(row.prediction_id, 'pred-1');
});

test('an unscored lead gets nulls — a proposal never stakes a score', async () => {
  const db = fakeDbForPropose({ prediction: null });
  await proposeDecision(db, 'ws-1', {
    decision_id: 'cc-2', proposal: 'intro touch', entity_id: 'e-2',
  });
  assert.equal(db.writes[0].icp_score_at_decision, null);
  assert.equal(db.writes[0].prediction_id, null);
});

test('a workspace-level decision with no entity skips the lookup cleanly', async () => {
  const db = fakeDbForPropose({ prediction: PREDICTION });
  await proposeDecision(db, 'ws-1', { decision_id: 'cc-3', proposal: 'run a win-loss review' });
  assert.equal(db.writes[0].icp_score_at_decision, null);
});


// ── The basis: what a recommendation rested on ────────────────────────────────────────────
// Tier 3 by construction, so the job here is not to validate the agent's reasoning — it is to
// make sure imperfect input never costs us the decision, and a retry never erases it.

test('evidence ids are de-duplicated, capped, and survive a bare string', async () => {
  const db = fakeDbForPropose({});
  await proposeDecision(db, 'ws-1', {
    decision_id: 'cc-e1', proposal: 'follow up', entity_id: 'e-1',
    evidence_ids: ['claim-1', 'claim-1', 'note-2', '', null],
  });
  assert.deepEqual(db.writes[0].evidence_ids, ['claim-1', 'note-2']);

  const db2 = fakeDbForPropose({});
  await proposeDecision(db2, 'ws-1', {
    decision_id: 'cc-e2', proposal: 'follow up', evidence_ids: 'claim-solo',
  });
  assert.deepEqual(db2.writes[0].evidence_ids, ['claim-solo']);

  const db3 = fakeDbForPropose({});
  await proposeDecision(db3, 'ws-1', {
    decision_id: 'cc-e3', proposal: 'follow up',
    evidence_ids: Array.from({ length: 100 }, (_, i) => `c-${i}`),
  });
  assert.equal(db3.writes[0].evidence_ids.length, 25, 'capped, not rejected');
});

test('a retry that forgets the basis does not erase it', async () => {
  // The upsert replaces the row. A skill re-running without resending its evidence would
  // otherwise quietly strip the reasoning off a decision that had it.
  const db = fakeDbForPropose({
    prior: { prediction_id: null, icp_score_at_decision: null, evidence_ids: ['claim-1'], rationale: 'they raised security' },
  });
  await proposeDecision(db, 'ws-1', { decision_id: 'cc-1', proposal: 'follow up' });
  assert.deepEqual(db.writes[0].evidence_ids, ['claim-1']);
  assert.equal(db.writes[0].rationale, 'they raised security');
});

test('rationale is stored apart from the proposal', async () => {
  const db = fakeDbForPropose({});
  await proposeDecision(db, 'ws-1', {
    decision_id: 'cc-r', proposal: 'send a follow-up', rationale: 'the security review is the real blocker',
  });
  assert.equal(db.writes[0].proposal, 'send a follow-up');
  assert.equal(db.writes[0].rationale, 'the security review is the real blocker');
});

// ── The inspection surface ────────────────────────────────────────────────────────────────

function fakeDbForSummary(decisions, traces = []) {
  return {
    from(table) {
      const chain = {};
      const rows = table === 'ri_decisions' ? decisions : traces;
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.gte = () => chain;
      chain.order = () => chain;
      chain.in = () => Promise.resolve({ data: rows });
      chain.limit = () => Promise.resolve({ data: rows });
      return chain;
    },
  };
}

test('the summary reports rates with their n, and flags a sample too small to mean anything', async () => {
  const out = await summarizeDecisions(fakeDbForSummary([
    { decision_id: 'a', surface: 'plugin', category: 'outreach', verdict: 'accepted', status: 'confirmed', edit_ratio: 0,    edit_verified: true,  evidence_ids: ['c1'], rationale: 'why' },
    { decision_id: 'b', surface: 'plugin', category: 'outreach', verdict: 'edited',   status: 'confirmed', edit_ratio: 0.4,  edit_verified: true,  evidence_ids: [],     rationale: null },
    { decision_id: 'c', surface: 'app',    category: 'outreach', verdict: 'rejected', status: 'abandoned', edit_ratio: null, edit_verified: false, evidence_ids: [],     rationale: null },
    { decision_id: 'd', surface: 'plugin', category: 'follow_up',verdict: 'accepted', status: 'unconfirmed',edit_ratio: null,edit_verified: false, evidence_ids: ['c2'], rationale: 'why' },
  ], [{ decision_id: 'a', outcome: 'meeting' }, { decision_id: 'b', outcome: 'no_response' }]));

  assert.equal(out.overall.total, 4);
  assert.equal(out.overall.rejected, 1);
  assert.equal(out.overall.reject_rate, 0.25);
  // Two checked drafts, one of them rewritten. The unchecked rows are absent from BOTH sides
  // of this fraction rather than counted as verbatim.
  assert.equal(out.overall.edit_rate, 0.5);
  assert.equal(out.overall.verified, 2);
  // One accepted decision never produced an action — the intent-to-action gap.
  assert.equal(out.overall.unconfirmed, 1);
  assert.equal(out.overall.unconfirmed_rate, Number((1 / 3).toFixed(4)));
  assert.equal(out.overall.sufficient, false, 'four decisions cannot support a conclusion');
  assert.equal(out.coverage.with_basis, 2);
  assert.equal(out.coverage.edit_verified, 2);
  assert.deepEqual(out.outcomes, { meeting: 1, no_response: 1 });
  assert.equal(out.by_surface[0].key, 'plugin');
  assert.equal(out.by_surface[0].total, 3);
});

test('a loop where nothing could be checked reports no edit rate, not a perfect one', async () => {
  // The GET-68 failure mode. Before this, decisions with no drafted body to compare against
  // defaulted to 'accepted' and the page read 100% sent-as-drafted — praise manufactured from
  // a missing input. Null is the honest answer and the one that makes the gap visible.
  const out = await summarizeDecisions(fakeDbForSummary([
    { decision_id: 'a', surface: 'plugin', category: 'outreach', verdict: 'accepted', status: 'confirmed', edit_ratio: null, edit_verified: false, evidence_ids: [], rationale: null },
    { decision_id: 'b', surface: 'plugin', category: 'outreach', verdict: 'accepted', status: 'confirmed', edit_ratio: null, edit_verified: false, evidence_ids: [], rationale: null },
  ]));
  assert.equal(out.overall.edit_rate, null);
  assert.equal(out.overall.edit_measurable, false);
  assert.equal(out.coverage.edit_verified_rate, 0);
});

test('an empty loop summarizes to nulls, not to NaN or a false zero', async () => {
  const out = await summarizeDecisions(fakeDbForSummary([]));
  assert.equal(out.overall.total, 0);
  assert.equal(out.overall.accept_rate, null);
  assert.equal(out.median_edit_ratio, null);
  assert.equal(out.coverage.basis_rate, null);
  assert.equal(out.overall.sufficient, false);
});


// ── Every draft surface reaches the loop ──────────────────────────────────────────────────
// The app creates drafts in five places and only two were recorded. The one operators actually
// use — the chat agent — was not, so a drafted email produced no decision, and the approve
// handler then wrote a verdict against a row that did not exist. Both halves failed silently.

test('a draft is mirrored with its body and the rationale the agent already gave', async () => {
  const db = fakeDbForPropose({});
  await mirrorDraftAsDecision(db, 'ws-1', {
    id: 'act-1', entity_id: 'e-1', recipient: 'Jory Pellew', recipient_email: 'jory@quillfield.example',
    subject: 'Loose ends from our call', body: 'Hey Jory, been a minute.',
    rationale: 'closes the security question and the partner-program call',
  }, { actionType: 'email_send', surface: 'app', agent: 'nous-chat' });

  const row = db.writes[0];
  assert.equal(row.decision_id, 'app:act-1');
  assert.equal(row.recipient, 'jory@quillfield.example');
  assert.equal(row.agent, 'nous-chat');
  assert.equal(row.rationale, 'closes the security question and the partner-program call');
  // Without the hash the edit label cannot be checked at all, which is the GET-68 failure.
  assert.ok(row.proposal_hash, 'the drafted body must be hashed so the edit can be checked');
});

test('a LinkedIn draft falls back to the profile URL as its recipient', async () => {
  const db = fakeDbForPropose({});
  await mirrorDraftAsDecision(db, 'ws-1', {
    id: 'act-2', linkedin_url: 'https://linkedin.com/in/test-profile-0001', body: 'hey', recipient: 'Jory',
  }, { actionType: 'linkedin_message' });
  assert.equal(db.writes[0].recipient, 'https://linkedin.com/in/test-profile-0001');
});

test('mirroring never throws — a draft must not fail over bookkeeping', async () => {
  const exploding = { from() { throw new Error('db down'); } };
  assert.equal(await mirrorDraftAsDecision(exploding, 'ws-1', { id: 'a', body: 'x' }, {}), null);
  assert.equal(await mirrorDraftAsDecision(fakeDbForPropose({}), 'ws-1', null, {}), null);
});

test('a draft that was never answered is counted apart from one that was agreed and dropped', async () => {
  // Two different facts. One is a broken promise, the other is a shrug, and a single number
  // covering both would say neither.
  const out = await summarizeDecisions(fakeDbForSummary([
    { decision_id: 'a', surface: 'app', category: 'outreach', verdict: 'accepted', status: 'unconfirmed', edit_ratio: null, edit_verified: false, evidence_ids: [], rationale: null },
    { decision_id: 'b', surface: 'app', category: 'outreach', verdict: 'pending',  status: 'ignored',     edit_ratio: null, edit_verified: false, evidence_ids: [], rationale: null },
  ]));
  assert.equal(out.overall.unconfirmed, 1);
  assert.equal(out.overall.ignored, 1);
  assert.equal(out.overall.ignored_rate, 0.5);
});


// ── Routing a correction ──────────────────────────────────────────────────────────────────
// The quiet failure of the preference loop is misrouting. A structural request stored as a
// prompt rule gets dropped by the model; a prohibition stored as a preference gets weighed
// against other considerations and overridden. And the loud failure is over-capture: most
// edits are a typo, and treating those as preferences fills the context with noise.

function routingDb() {
  const touched = [];
  return {
    touched,
    from(table) {
      const c = {};
      touched.push(table);
      for (const m of ['select', 'eq', 'is', 'order', 'update']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: { id: 'd1', proposal_hash: null, verdict: 'pending' } });
      c.single = () => Promise.resolve({ data: { id: 'd1', decision_id: 'cc-1' } });
      c.upsert = () => c;
      c.then = (res) => res({ data: [], error: null });
      return c;
    },
  };
}
const routedTo = (db) => db.touched.filter((t) => t === 'ri_constraints' || t === 'ri_preferences');

test('a correction meant only for this output routes nowhere', async () => {
  // The honest answer for most edits, and the one that keeps the context block clean.
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', interpretation: 'fixed a typo', correction_kind: 'none', correction_scope: 'once',
  });
  assert.deepEqual(routedTo(db), []);
});

test('a correction the user says applies to everyone becomes our problem, not their row', async () => {
  // 'product' means our default is wrong for everybody. That is a ticket for us — writing it
  // against this user would ship one customer's taste to the rest.
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', interpretation: 'the default template is wrong',
    correction_kind: 'structure', correction_scope: 'product',
  });
  assert.deepEqual(routedTo(db), []);
});

test('a prohibition routes to constraints, not preferences', async () => {
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'rejected', interpretation: 'never send breakup emails',
    correction_kind: 'constraint', correction_scope: 'person', user_id: 'u-1',
  });
  assert.ok(db.touched.includes('ri_constraints'));
  assert.ok(!db.touched.includes('ri_preferences'), 'a prohibition weighed as a preference gets overridden');
});

test('a judgment routes to preferences, not constraints', async () => {
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', interpretation: 'write shorter',
    correction_kind: 'rule', correction_scope: 'person', user_id: 'u-1',
  });
  assert.ok(db.touched.includes('ri_preferences'));
  assert.ok(!db.touched.includes('ri_constraints'), 'a preference enforced as a prohibition blocks work it should not');
});

test('an interpretation with no text routes nowhere, whatever the kind says', async () => {
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', correction_kind: 'rule', correction_scope: 'person', user_id: 'u-1',
  });
  assert.deepEqual(routedTo(db), []);
});

test('a routing failure does not fail the verdict', async () => {
  // Losing the lesson is bad. Losing the record that the human answered at all is worse.
  const db = {
    from(table) {
      if (table === 'ri_preferences') throw new Error('down');
      const c = {};
      for (const m of ['select', 'eq', 'update']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: { id: 'd1', proposal_hash: null, verdict: 'pending' } });
      c.single = () => Promise.resolve({ data: { id: 'd1', decision_id: 'cc-1', verdict: 'edited' } });
      return c;
    },
  };
  const out = await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', interpretation: 'write shorter',
    correction_kind: 'rule', correction_scope: 'person', user_id: 'u-1',
  });
  assert.equal(out.verdict, 'edited');
});

test('an unknown kind or scope is discarded rather than guessed at', async () => {
  const db = routingDb();
  await recordVerdict(db, 'ws-1', 'cc-1', {
    verdict: 'edited', interpretation: 'something',
    correction_kind: 'vibes', correction_scope: 'sometimes', user_id: 'u-1',
  });
  assert.deepEqual(routedTo(db), []);
});
