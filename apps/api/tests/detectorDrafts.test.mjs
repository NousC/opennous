// The detector automations drafting their own follow-ups (GET-685, lib/detectorDrafts.mjs).
//
// What must hold: a detector that fires drafts exactly one email, to the right person, queued as
// a pending draft and never sent; re-detection never stacks a second draft; a draft that was
// skipped or sent does not come straight back for the same trigger; the day's cap holds; archived,
// closed and internal accounts are never written to; and every draft carries the origin marker
// the Priorities inbox reads. The model call is faked and the database is in memory.
//
// Run: cd apps/api && node --test tests/detectorDrafts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DETECTORS, quietOpenDeals, staleDealFiring, signalFirings, gateFiring, planDrafts, draftedToday,
  rankRecipients, speakerMatches, originMarker, ledgerKey, runDetectorDraftsForWorkspace, recKeyOf,
  runDetectorDrafts, allowedWorkspaces, dealSignalFirings, DEAL_SIGNALS, DETECTOR_ORDER, draftSystem, voiceFor,
} from '../src/lib/detectorDrafts.mjs';
import { parseEmailDraft, EMAIL_DRAFT_SYSTEM } from '../src/lib/emailDraft.mjs';
import { originOf } from '../src/lib/actionOrigin.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-04T06:10:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const OPTS = { dailyCap: 20, minGapDays: 7, sameTriggerDays: 30, staleDays: 14, signalLookbackDays: 7, maxFailures: 3 };

// ─── Pure: detection ──────────────────────────────────────────────────────────────

test('quiet open deals: open, with an account, untouched for the window; biggest first', () => {
  const rows = [
    { entity_id: 'd1', company_id: 'a1', status: 'open', pipeline_value: 10, last_activity_at: iso(20) },
    { entity_id: 'd2', company_id: 'a2', status: 'open', pipeline_value: 90, last_activity_at: null },
    { entity_id: 'd3', company_id: 'a3', status: 'open', pipeline_value: 50, last_activity_at: iso(3) },   // touched
    { entity_id: 'd4', company_id: 'a4', status: 'won', pipeline_value: 99, last_activity_at: iso(40) },   // closed
    { entity_id: 'd5', company_id: null, status: 'open', pipeline_value: 99, last_activity_at: iso(40) },  // no account
  ];
  assert.deepEqual(quietOpenDeals(rows, { now: NOW, staleDays: 14 }).map((d) => d.entity_id), ['d2', 'd1']);
});

test('stale deal fires on 14+ days in one stage and 14+ days quiet, says so in one line', () => {
  const row = { entity_id: 'd1', name: 'Acme renewal', company_id: 'a1', company_name: 'Acme', status: 'open', stage: 'Proposal sent', last_activity_at: iso(21), pipeline_value: 12000 };
  const cand = { dealEntityId: 'd1', name: 'Acme renewal', stage: 'Proposal sent', status: 'open', lastStageChangeAt: iso(16), roster: ['p1'], ownerEmail: 'rep@us.test' };
  const f = staleDealFiring(row, cand, { now: NOW, staleDays: 14 });
  assert.equal(f.automation, 'stale_deal');
  assert.equal(f.targetType, 'deal');
  assert.equal(f.why, 'Acme renewal sat in Proposal sent for 16 days, no touch in 21 days');
  assert.equal(f.fingerprint, `d1|proposal sent|${iso(16).slice(0, 10)}`);
  assert.deepEqual(f.rosterIds, ['p1']);
  // 13 days in stage: not yet. Undated stage: never. Touched recently: no. Closed: no.
  assert.equal(staleDealFiring(row, { ...cand, lastStageChangeAt: iso(13) }, { now: NOW }), null);
  assert.equal(staleDealFiring(row, { ...cand, lastStageChangeAt: null }, { now: NOW }), null);
  assert.equal(staleDealFiring({ ...row, last_activity_at: iso(2) }, cand, { now: NOW }), null);
  assert.equal(staleDealFiring(row, { ...cand, status: 'lost' }, { now: NOW }), null);
});

// Every signal a customer said carries their words; a test that wants none passes quote: ''.
const claim = (entity_id, property, category, metadata, last_observed_at = iso(1), content = 'Something they said') =>
  ({ entity_id, property, last_observed_at, value: { category, content, metadata: { quote: 'In their words', ...metadata } } });

test('risk firings: one per account, gravest then newest, only within the lookback, dated', () => {
  const rows = [
    claim('a1', 'note.1', 'risk_signal', { severity: 'friction', occurred_at: iso(1), speaker: 'Hollis' }, iso(1), 'Invoice complaint'),
    claim('a1', 'note.2', 'risk_signal', { severity: 'stated_churn', occurred_at: iso(3), speaker: 'Dana' }, iso(3), 'They are giving notice'),
    claim('a2', 'note.3', 'risk_signal', { occurred_at: iso(30) }, iso(1), 'Old risk, freshly re-observed'),  // said 30 days ago
    claim('a3', 'note.4', 'risk_signal', {}, null, 'Undated'),
    claim('a4', 'note.5', 'expansion_signal', { stance: 'asked', product: 'Portal', occurred_at: iso(1) }),
    claim('a5', 'note.6', 'risk_signal', { severity: 'stated_churn', occurred_at: iso(1), quote: '' }, iso(1), 'Machine-derived, nobody said it'),
  ];
  const f = signalFirings(rows, 'deal_risk', { now: NOW, lookbackDays: 7, names: new Map([['a1', 'Acme']]) });
  assert.equal(f.length, 1);
  assert.equal(f[0].targetId, 'a1');
  assert.equal(f[0].fingerprint, 'a1|note.2');
  assert.equal(f[0].raisedBy, 'Dana');
  assert.equal(f[0].accountName, 'Acme');
  assert.match(f[0].why, /^Turned at risk on Oct 1: They are giving notice$/);
});

test('expansion firings: an ask names a product; considering is not an ask; a later no stands', () => {
  const rows = [
    claim('a1', 'note.1', 'expansion_signal', { stance: 'asked', product: 'Eastgate store', occurred_at: iso(2), speaker: 'Lee' }, iso(2), 'Could we add the Eastgate store'),
    claim('a2', 'note.2', 'expansion_signal', { stance: 'considering', product: 'Portal', occurred_at: iso(1) }),
    claim('a3', 'note.3', 'expansion_signal', { stance: 'asked', occurred_at: iso(1) }),                       // no product
    claim('a4', 'note.4', 'expansion_signal', { stance: 'asked', product: 'Portal', occurred_at: iso(3) }),
    claim('a4', 'note.5', 'expansion_signal', { stance: 'declined', product: 'portal', occurred_at: iso(1) }),  // then said no
  ];
  const f = signalFirings(rows, 'expansion_signal', { now: NOW, lookbackDays: 7 });
  assert.deepEqual(f.map((x) => x.targetId), ['a1']);
  assert.match(f[0].why, /^Asked about Eastgate store on Oct 2: Could we add the Eastgate store$/);
  assert.equal(f[0].trigger.product, 'Eastgate store');
});

// ─── Pure: the gate ───────────────────────────────────────────────────────────────

const firing = (over = {}) => ({ automation: 'stale_deal', targetType: 'deal', targetId: 'd1', accountId: 'a1', fingerprint: 'fp1', why: 'x', ...over });
const st = (evidence, status = 'drafted') => ({ id: 'r1', status, updated_at: iso(1), evidence });

test('gate: an open draft is never stacked', () => {
  const g = gateFiring(firing(), st({ action_id: 'pa1', fingerprint: 'fp0', outcome: 'drafted', outcome_at: iso(40), drafted_at: iso(40) }), { now: NOW, pendingActionIds: new Set(['pa1']) });
  assert.deepEqual(g, { ok: false, reason: 'open_draft' });
});

test('gate: the same trigger waits sameTriggerDays after it was handled, whatever the human did', () => {
  const handled = { action_id: 'pa1', fingerprint: 'fp1', outcome: 'drafted', outcome_at: iso(10), drafted_at: iso(10) };
  assert.equal(gateFiring(firing(), st(handled), { now: NOW, pendingActionIds: new Set() }).reason, 'same_trigger_cooldown');
  const later = { ...handled, outcome_at: iso(31), drafted_at: iso(31) };
  assert.deepEqual(gateFiring(firing(), st(later), { now: NOW, pendingActionIds: new Set() }), { ok: true });
  // Nobody to write to also closes the trigger (until it changes).
  assert.equal(gateFiring(firing(), st({ fingerprint: 'fp1', outcome: 'no_recipient', outcome_at: iso(2) }), { now: NOW }).reason, 'same_trigger_cooldown');
});

test('gate: a new trigger still respects the minimum gap since the last draft', () => {
  const last = { action_id: 'pa1', fingerprint: 'fp0', outcome: 'drafted', outcome_at: iso(3), drafted_at: iso(3) };
  assert.equal(gateFiring(firing({ fingerprint: 'fp2' }), st(last), { now: NOW, pendingActionIds: new Set() }).reason, 'min_gap');
  assert.equal(gateFiring(firing({ fingerprint: 'fp2' }), st({ ...last, drafted_at: iso(8), outcome_at: iso(8) }), { now: NOW, pendingActionIds: new Set() }).ok, true);
});

test('gate: transient outcomes retry; repeated failures on one trigger stop', () => {
  assert.equal(gateFiring(firing(), st({ fingerprint: 'fp1', outcome: 'recipient_has_open_draft', outcome_at: iso(1) }, 'settled'), { now: NOW }).ok, true);
  assert.equal(gateFiring(firing(), st({ fingerprint: 'fp1', outcome: 'failed', failures: 2, outcome_at: iso(1) }, 'settled'), { now: NOW }).ok, true);
  assert.equal(gateFiring(firing(), st({ fingerprint: 'fp1', outcome: 'failed', failures: 3, outcome_at: iso(1) }, 'settled'), { now: NOW }).reason, 'failed_too_often');
  assert.equal(gateFiring(firing({ fingerprint: 'fp9' }), st({ fingerprint: 'fp1', outcome: 'failed', failures: 3, outcome_at: iso(1) }, 'settled'), { now: NOW }).ok, true);
  // A run that died mid-draft holds the subject for an hour, then lets go.
  assert.equal(gateFiring(firing(), st({ attempt_at: new Date(NOW - 10 * 60_000).toISOString() }, 'drafting'), { now: NOW }).reason, 'in_progress');
  assert.equal(gateFiring(firing(), st({ attempt_at: new Date(NOW - 2 * 3600_000).toISOString() }, 'drafting'), { now: NOW }).ok, true);
});

test('plan: the day cap counts today\'s drafts, risk and expansion go before stale deals', () => {
  const firings = [
    firing({ targetId: 'd1' }), firing({ targetId: 'd2' }),
    firing({ automation: 'expansion_signal', targetType: 'account', targetId: 'a5' }),
    firing({ automation: 'deal_risk', targetType: 'account', targetId: 'a6' }),
  ];
  const ledger = new Map([['x', st({ drafted_at: new Date(NOW - 3600_000).toISOString() })]]); // one drafted today already
  const p = planDrafts(firings, ledger, { ...OPTS, dailyCap: 3, now: NOW, pendingActionIds: new Set() });
  assert.deepEqual(p.draft.map((f) => `${f.automation}:${f.targetId}`), ['deal_risk:a6', 'expansion_signal:a5']);
  assert.deepEqual(p.skipped.map((s) => s.reason), ['daily_cap', 'daily_cap']);
  assert.equal(draftedToday([st({ drafted_at: iso(1) })], NOW), 0);   // yesterday does not count
});

test('plan: one firing per subject per automation', () => {
  const p = planDrafts([firing(), firing({ fingerprint: 'other' })], new Map(), { ...OPTS, now: NOW });
  assert.equal(p.draft.length, 1);
  assert.equal(p.skipped[0].reason, 'duplicate');
});

// ─── Pure: who it goes to ─────────────────────────────────────────────────────────

test('recipient: who said it, then the deal\'s champion, the deal\'s people, the champion, the latest touch', () => {
  const people = [
    { id: 'p1', first_name: 'Old', last_name: 'Contact', email: 'old@acme.test', last_interaction_at: iso(1) },
    { id: 'p2', first_name: 'Rita', last_name: 'Roster', email: 'rita@acme.test', last_interaction_at: iso(50) },
    { id: 'p3', first_name: 'Cass', last_name: 'Champion', email: 'cass@acme.test', last_interaction_at: iso(90) },
    { id: 'p4', first_name: 'Hollis', last_name: 'Reyes', email: 'hollis@acme.test', last_interaction_at: iso(200) },
    { id: 'p5', first_name: 'Team', last_name: 'Mate', email: 'mate@us.test', last_interaction_at: iso(0) },
    { id: 'p6', first_name: 'No', last_name: 'Email', email: null, last_interaction_at: iso(0) },
  ];
  const internalIds = new Set(['p5']);
  const order = (o) => rankRecipients(people, { internalIds, ...o }).map((p) => p.id);
  assert.deepEqual(order({}), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(order({ championIds: ['p3'] }), ['p3', 'p1', 'p2', 'p4']);
  assert.deepEqual(order({ rosterIds: ['p2', 'p3'], championIds: ['p3'] }), ['p3', 'p2', 'p1', 'p4']);
  assert.deepEqual(order({ rosterIds: ['p2'], championIds: ['p3'], raisedBy: 'Hollis' }), ['p4', 'p2', 'p3', 'p1']);
});

test('speaker labels match a person by full name, first name, or first name and initial', () => {
  const p = { first_name: 'Hollis', last_name: 'Reyes' };
  assert.equal(speakerMatches(p, 'Hollis Reyes'), true);
  assert.equal(speakerMatches(p, 'hollis'), true);
  assert.equal(speakerMatches(p, 'Hollis R.'), true);
  assert.equal(speakerMatches(p, 'Hollis Smith'), false);
  assert.equal(speakerMatches(p, 'Hollister'), false);
  assert.equal(speakerMatches(p, ''), false);
});

test('the shared brief parses "Subject <line>" and falls back to a plain subject', () => {
  assert.deepEqual(parseEmailDraft('Subject Picking up on the proposal\n\nHi Dana,\n\nBody.'), { subject: 'Picking up on the proposal', body: 'Hi Dana,\n\nBody.' });
  assert.deepEqual(parseEmailDraft('Hi Dana, just the body.'), { subject: 'Quick follow-up', body: 'Hi Dana, just the body.' });
});

test('origin marker carries the automation, its name, the trigger and the ids', () => {
  const m = originMarker({ ...firing({ dealId: 'd1', dealName: 'Acme renewal', accountName: 'Acme', trigger: { stage: 'Proposal sent' } }) }, { contactId: 'p1' });
  assert.deepEqual(m, {
    source: 'automation', automation: 'stale_deal', automation_name: 'Stale deal detection', template_id: 'stale_deal',
    why: 'x', fingerprint: 'fp1', account_id: 'a1', account_name: 'Acme', deal_id: 'd1', deal_name: 'Acme renewal',
    contact_id: 'p1', trigger: { stage: 'Proposal sent' },
  });
  assert.equal(DETECTORS.expansion_signal.templateId, 'expansion');
});

// ─── The whole pass, against an in-memory database ────────────────────────────────

/** A small PostgREST-shaped fake: the filters this module uses, a unique key on the ledger. */
function fakeDb(tables) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const get = (row, col) => {
    const m = col.match(/^(\w+)->>(\w+)$/);
    if (m) { const v = row[m[1]]?.[m[2]]; return v == null ? null : String(v); }
    return row[col];
  };
  const UNIQUE = { ri_recommendations: ['workspace_id', 'target_type', 'target_id', 'rec_key'] };
  function from(table) {
    db[table] ??= [];
    const filters = [];
    let op = 'select'; let payload = null; let single = null; let limit = null; let range = null; let returning = false;
    const q = {
      select() { if (op !== 'select') returning = true; return q; },
      eq(c, v) { filters.push((r) => get(r, c) === v); return q; },
      neq(c, v) { filters.push((r) => get(r, c) !== v); return q; },
      in(c, vs) { const s = new Set(vs); filters.push((r) => s.has(get(r, c))); return q; },
      is(c, v) { filters.push((r) => (get(r, c) ?? null) === v); return q; },
      not(c, o, v) { filters.push((r) => (get(r, c) ?? null) !== v); return q; },
      like(c, p) { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`); filters.push((r) => re.test(String(get(r, c) ?? ''))); return q; },
      gte(c, v) { filters.push((r) => get(r, c) != null && String(get(r, c)) >= v); return q; },
      order() { return q; },
      range(a, b) { range = [a, b]; return q; },
      limit(n) { limit = n; return q; },
      maybeSingle() { single = 'maybe'; return q; },
      single() { single = 'one'; return q; },
      insert(rows) { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return q; },
      update(patch) { op = 'update'; payload = patch; return q; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      const rows = db[table];
      if (op === 'insert') {
        const out = [];
        for (const r of payload) {
          const key = UNIQUE[table];
          if (key && rows.some((x) => key.every((k) => x[k] === r[k]))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          const row = { id: randomUUID(), created_at: new Date(NOW).toISOString(), status: 'pending', ...r };
          rows.push(row); out.push({ ...row });
        }
        return { data: single ? out[0] : out, error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (range) hit = hit.slice(range[0], range[1] + 1);
      if (limit != null) hit = hit.slice(0, limit);
      const data = hit.map((r) => ({ ...r }));
      if (single === 'maybe') return { data: data[0] ?? null, error: null };
      if (single === 'one') return data.length ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } };
      return { data, error: null };
    }
    return q;
  }
  return { from, db };
}

const WS = 'ws1';
function world() {
  const people = [
    // Acme: a stale deal, its CRM contact Rita, a champion Cass (not on the deal).
    { id: 'p_rita', workspace_id: WS, company_id: 'a_acme', first_name: 'Rita', last_name: 'Roster', email: 'rita@acme.test', last_interaction_at: iso(30) },
    { id: 'p_cass', workspace_id: WS, company_id: 'a_acme', first_name: 'Cass', last_name: 'Champion', email: 'cass@acme.test', last_interaction_at: iso(60) },
    // A teammate: their own company is internal, so it is never an account to write to.
    { id: 'p_mate', workspace_id: WS, company_id: 'a_us', first_name: 'Team', last_name: 'Mate', email: 'mate@us.test', last_interaction_at: iso(0) },
    // Birch: a customer who raised a risk (Hollis said it).
    { id: 'p_hollis', workspace_id: WS, company_id: 'a_birch', first_name: 'Hollis', last_name: 'Reyes', email: 'hollis@birch.test', last_interaction_at: iso(100) },
    { id: 'p_bea', workspace_id: WS, company_id: 'a_birch', first_name: 'Bea', last_name: 'Other', email: 'bea@birch.test', last_interaction_at: iso(2) },
    // Cedar: a customer who asked for more.
    { id: 'p_lee', workspace_id: WS, company_id: 'a_cedar', first_name: 'Lee', last_name: 'Ask', email: 'lee@cedar.test', last_interaction_at: iso(5) },
    // Dune: archived. Elm: only a lost deal.
    { id: 'p_dan', workspace_id: WS, company_id: 'a_dune', first_name: 'Dan', last_name: 'Dune', email: 'dan@dune.test', last_interaction_at: iso(5) },
    { id: 'p_eve', workspace_id: WS, company_id: 'a_elm', first_name: 'Eve', last_name: 'Elm', email: 'eve@elm.test', last_interaction_at: iso(5) },
  ];
  return fakeDb({
    workspaces: [{ id: WS }],
    workspace_members: [
      { workspace_id: WS, user_id: 'u_first', agent_prefs: null, created_at: iso(400) },
      { workspace_id: WS, user_id: 'u_owner', agent_prefs: null, created_at: iso(300) },
    ],
    users: [{ id: 'u_owner', email: 'Rep@Us.test' }, { id: 'u_first', email: 'first@us.test' }],
    entity_list_rows: [
      { workspace_id: WS, kind: 'deal', entity_id: 'd_acme', name: 'Acme renewal', company_id: 'a_acme', company_name: 'Acme', stage: 'Proposal sent', status: 'open', pipeline_value: 12000, last_activity_at: iso(21) },
      { workspace_id: WS, kind: 'deal', entity_id: 'd_birch', name: 'Birch 2025', company_id: 'a_birch', company_name: 'Birch', stage: 'Closed won', status: 'won', pipeline_value: 5000, last_activity_at: iso(5) },
      { workspace_id: WS, kind: 'deal', entity_id: 'd_cedar', name: 'Cedar 2025', company_id: 'a_cedar', company_name: 'Cedar', stage: 'Closed won', status: 'won', pipeline_value: 5000, last_activity_at: iso(5) },
      { workspace_id: WS, kind: 'deal', entity_id: 'd_dune', name: 'Dune', company_id: 'a_dune', company_name: 'Dune', stage: 'Closed won', status: 'won', pipeline_value: 5000, last_activity_at: iso(5) },
      { workspace_id: WS, kind: 'deal', entity_id: 'd_us', name: 'Us', company_id: 'a_us', company_name: 'Us', stage: 'Closed won', status: 'won', pipeline_value: 1, last_activity_at: iso(5) },
      { workspace_id: WS, kind: 'deal', entity_id: 'd_elm', name: 'Elm', company_id: 'a_elm', company_name: 'Elm', stage: 'Closed lost', status: 'lost', pipeline_value: 5000, last_activity_at: iso(5) },
    ],
    entities: ['d_acme', 'a_acme', 'a_birch', 'a_cedar', 'a_elm', 'a_us', 'd_birch', 'd_cedar', 'd_elm'].map((id) => ({ id, workspace_id: WS, status: 'active' }))
      .concat([{ id: 'a_dune', workspace_id: WS, status: 'archived' }]),
    companies: ['a_acme', 'a_birch', 'a_cedar', 'a_dune', 'a_elm', 'a_us'].map((id) => ({ id, workspace_id: WS, name: id.slice(2).replace(/^./, (c) => c.toUpperCase()) })),
    claims: [
      claim('a_birch', 'note.r1', 'risk_signal', { severity: 'stated_churn', occurred_at: iso(1), speaker: 'Hollis', quote: 'We are reviewing other vendors' }, iso(1), 'Reviewing other vendors after the outage'),
      claim('a_cedar', 'note.e1', 'expansion_signal', { stance: 'asked', product: 'Portal', occurred_at: iso(2), speaker: 'Lee' }, iso(2), 'Asked what Portal would cost'),
      claim('a_dune', 'note.r2', 'risk_signal', { occurred_at: iso(1) }, iso(1), 'Archived account risk'),
      claim('a_elm', 'note.r3', 'risk_signal', { occurred_at: iso(1) }, iso(1), 'Lost prospect complaint'),
      claim('a_us', 'note.r4', 'risk_signal', { occurred_at: iso(1) }, iso(1), 'Our own company, never an account'),
    ].map((c) => ({ ...c, workspace_id: WS, invalid_at: null })),
    contacts: people,
    workspace_graph_edges: [{ workspace_id: WS, subject_id: 'p_cass', object_id: 'a_acme', relationship: 'CHAMPIONS', source_memory_id: null }],
    pending_actions: [],
    ri_recommendations: [],
  });
}

function fakeDeps(over = {}) {
  const calls = { model: 0, usage: [], mirrored: [] };
  const people = new Map();
  const deps = {
    loadDealCandidates: async (_s, _w, companyId) => (companyId === 'a_acme'
      ? [{ dealEntityId: 'd_acme', name: 'Acme renewal', stage: 'Proposal sent', status: 'open', lastStageChangeAt: iso(16), roster: ['p_rita'], ownerEmail: 'rep@us.test' }]
      : []),
    getRelationshipOwners: async () => new Map(),
    getInternalEntityIds: async () => new Set(['p_mate']),
    bindingConstraints: async () => [],
    filterDerivedForViewer: async (_s, _w, rows) => rows.filter((r) => !r.private),
    filterByCitedClaimsForViewer: async (_s, _w, rows) => rows,
    pickRecipientEmail: async (s, _w, id) => (await s.from('contacts').select('email').eq('id', id).maybeSingle()).data?.email ?? null,
    getAccountRecord: async (_s, _w, id) => { people.set(id, true); return { claims: { name: { value: null } }, facts: [], documents: [] }; },
    mirrorDraftAsDecision: async (_s, _w, action, opts) => { calls.mirrored.push({ action, opts }); return {}; },
    createMessage: async (req) => { calls.model += 1; calls.last = req; return { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 }, text: 'Subject Picking things back up\n\nHi there,\n\nShort note.\n\nTheo' }; },
    messageText: (r) => r.text,
    trackLlmUsage: (_s, row) => { calls.usage.push(row); },
    requireAiCredits: async () => ({ ok: true }),
    loadMemberProfile: async () => ({ name: 'Theo' }),
    buildMemberBlock: () => 'You are writing as Theo.',
    ...over,
  };
  return { deps, calls };
}

const run = (s, deps, at = NOW, opts = OPTS, dryRun = false) => runDetectorDraftsForWorkspace(s, WS, { now: at, deps, opts, dryRun });

test('one pass: each detector drafts once, to the right person, queued pending, marked for the inbox', async () => {
  const s = world();
  const { deps, calls } = fakeDeps();
  const r = await run(s, deps);
  assert.equal(r.drafted, 3, JSON.stringify(r));
  assert.equal(calls.model, 3);

  const drafts = s.db.pending_actions;
  assert.equal(drafts.length, 3);
  for (const d of drafts) {
    assert.equal(d.status, 'pending');
    assert.equal(d.kind, 'email');
    assert.equal(d.subject, 'Picking things back up');
    assert.ok(d.rec_id);
  }
  const by = Object.fromEntries(drafts.map((d) => [d.entity_id, d]));
  // Stale deal → the deal's own contact, sent as the CRM deal owner (matched by email, any case).
  assert.equal(by.p_rita.recipient_email, 'rita@acme.test');
  assert.equal(by.p_rita.user_id, 'u_owner');
  assert.equal(by.p_rita.rationale, 'Acme renewal sat in Proposal sent for 16 days, no touch in 21 days');
  // Risk → Hollis, who said it, though Bea was in touch more recently. No owner → the first member.
  assert.equal(by.p_hollis.recipient_email, 'hollis@birch.test');
  assert.equal(by.p_hollis.user_id, 'u_first');
  assert.match(by.p_hollis.rationale, /^Turned at risk on Oct 3: Reviewing other vendors/);
  // Expansion → Lee.
  assert.ok(by.p_lee);
  // Never the archived account, the lost prospect, or the teammate.
  assert.ok(!by.p_dan && !by.p_eve && !by.p_mate);

  // The ledger: one row per subject, out of every worklist (status is never 'open').
  const ledger = s.db.ri_recommendations;
  assert.equal(ledger.length, 3);
  for (const l of ledger) {
    assert.equal(l.category, 'automation');
    assert.equal(l.status, 'drafted');
    assert.equal(l.evidence.outcome, 'drafted');
    assert.ok(drafts.some((d) => d.id === l.evidence.action_id && d.rec_id === l.id));
  }
  const stale = ledger.find((l) => l.rec_key === recKeyOf('stale_deal'));
  assert.equal(stale.target_type, 'deal');
  assert.equal(stale.target_id, 'd_acme');
  assert.equal(stale.evidence.automation_name, 'Stale deal detection');
  assert.equal(stale.evidence.deal_id, 'd_acme');
  assert.equal(stale.evidence.account_id, 'a_acme');
  assert.equal(stale.evidence.contact_id, 'p_rita');
  // The Priorities inbox (#606, actionOrigin.originOf) labels it today, unwired: name and reason.
  const draft = drafts.find((d) => d.rec_id === stale.id);
  const origin = originOf(draft, { recs: new Map([[stale.id, stale]]) });
  assert.equal(origin.name, 'Stale deal detection');
  assert.equal(origin.why, 'Acme renewal sat in Proposal sent for 16 days, no touch in 21 days');

  // The decision mirror: surface 'automation', the automation key as the agent, the marker as payload.
  assert.equal(calls.mirrored.length, 3);
  const m = calls.mirrored.find((x) => x.opts.agent === 'deal_risk');
  assert.equal(m.opts.surface, 'automation');
  assert.equal(m.opts.payload.automation_name, 'Deal risk detection');
  assert.equal(m.opts.payload.contact_id, 'p_hollis');

  // Metered under its own feature, as the sender; the model was told why and what to write.
  assert.ok(calls.usage.every((u) => u.feature === 'automation-email-draft'));
  assert.equal(calls.last.feature, 'automation-email-draft');
  assert.equal(calls.last.tier, 'writing');
  assert.match(calls.last.system, /You are writing as Theo\./);
  assert.match(calls.last.messages[0].content, /Why you are writing/);
});

test('re-detection the same night or the next never stacks a second draft', async () => {
  const s = world();
  const { deps, calls } = fakeDeps();
  await run(s, deps);
  await run(s, deps);
  await run(s, deps, NOW + DAY);
  assert.equal(s.db.pending_actions.length, 3);
  assert.equal(calls.model, 3);
});

test('a skipped or sent draft does not come straight back for the same trigger; a month later it may', async () => {
  const s = world();
  const { deps, calls } = fakeDeps();
  await run(s, deps);
  for (const d of s.db.pending_actions) d.status = d.entity_id === 'p_rita' ? 'rejected' : 'sent';
  await run(s, deps, NOW + 2 * DAY);
  assert.equal(calls.model, 3, 'no redraft two days later');
  // 31 days on, the deal is still in the same stage and still quiet: the stale draft returns. The
  // risk and the ask are older than the signal window by then and do not.
  await run(s, deps, NOW + 31 * DAY);
  assert.equal(calls.model, 4);
  const fresh = s.db.pending_actions.filter((d) => d.status === 'pending');
  assert.deepEqual(fresh.map((d) => d.entity_id), ['p_rita']);
});

test('a new trigger on the same subject waits out the minimum gap', async () => {
  const s = world();
  const stage = { at: iso(16), name: 'Proposal sent' };
  const { deps, calls } = fakeDeps({
    loadDealCandidates: async (_s, _w, companyId) => (companyId === 'a_acme'
      ? [{ dealEntityId: 'd_acme', name: 'Acme renewal', stage: stage.name, status: 'open', lastStageChangeAt: stage.at, roster: ['p_rita'], ownerEmail: null }] : []),
  });
  await run(s, deps);
  s.db.pending_actions.find((d) => d.entity_id === 'p_rita').status = 'rejected';
  // The deal moved to Negotiation and sat there: a different trigger.
  Object.assign(stage, { at: new Date(NOW - 15 * DAY).toISOString(), name: 'Negotiation' });
  s.db.entity_list_rows[0].stage = 'Negotiation';
  await run(s, deps, NOW + 3 * DAY);
  assert.equal(calls.model, 3, 'inside the 7-day gap');
  await run(s, deps, NOW + 8 * DAY);
  assert.equal(calls.model, 4, 'after the gap, the new trigger drafts');
  assert.match(s.db.pending_actions.at(-1).rationale, /sat in Negotiation/);
});

test('the day cap holds across detectors, risk first', async () => {
  const s = world();
  const { deps, calls } = fakeDeps();
  const r = await run(s, deps, NOW, { ...OPTS, dailyCap: 2 });
  assert.equal(r.drafted, 2);
  assert.equal(calls.model, 2);
  assert.deepEqual(s.db.ri_recommendations.map((l) => l.rec_key).sort(), [recKeyOf('deal_risk'), recKeyOf('expansion_signal')]);
  // Later the same day: the cap is spent.
  await run(s, deps, NOW + 3600_000, { ...OPTS, dailyCap: 2 });
  assert.equal(calls.model, 2);
  // Tomorrow the stale deal gets its turn.
  await run(s, deps, NOW + DAY, { ...OPTS, dailyCap: 2 });
  assert.equal(calls.model, 3);
});

test('a person who already has a draft waiting is not written to again, and no credit is spent', async () => {
  const s = world();
  s.db.pending_actions.push({ id: 'studio1', workspace_id: WS, entity_id: 'p_hollis', kind: 'email', status: 'pending' });
  const { deps, calls } = fakeDeps();
  const r = await run(s, deps);
  assert.equal(r.outcomes.recipient_has_open_draft, 1);
  assert.equal(calls.model, 2);
  // Once their draft is dealt with, the risk is drafted the next night.
  s.db.pending_actions.find((d) => d.id === 'studio1').status = 'sent';
  await run(s, deps, NOW + DAY);
  assert.equal(calls.model, 3);
});

test('dry run writes nothing and calls no model', async () => {
  const s = world();
  const { deps, calls } = fakeDeps({ createMessage: async () => { throw new Error('must not be called'); } });
  const r = await run(s, deps, NOW, OPTS, true);
  assert.equal(calls.model, 0);
  assert.equal(s.db.pending_actions.length, 0);
  assert.equal(s.db.ri_recommendations.length, 0);
  assert.deepEqual(r.plan.map((p) => p.automation), ['deal_risk', 'expansion_signal', 'stale_deal']);
});

test('no credits, no drafts; a sender who switched drafting off is skipped', async () => {
  const s1 = world();
  const a = fakeDeps({ requireAiCredits: async () => ({ ok: false, status: 402 }) });
  const r1 = await run(s1, a.deps);
  assert.equal(r1.skipped.credits, 3);
  assert.equal(a.calls.model, 0);
  assert.equal(s1.db.ri_recommendations.length, 0);

  const s2 = world();
  s2.db.workspace_members.forEach((m) => { m.agent_prefs = { home: { auto_draft: false } }; });
  const b = fakeDeps();
  const r2 = await run(s2, b.deps);
  assert.equal(b.calls.model, 0);
  assert.equal(r2.outcomes.sender_opted_out, 3);
});

test('a model failure is retried on later nights, at most three times per trigger', async () => {
  const s = world();
  const { deps, calls } = fakeDeps({ createMessage: async () => { calls.model += 1; throw new Error('model down'); } });
  for (let d = 0; d < 5; d += 1) await run(s, deps, NOW + d * DAY, { ...OPTS, signalLookbackDays: 30 });
  assert.equal(s.db.pending_actions.length, 0);
  assert.equal(calls.model, 9, 'three detectors × three attempts');
  assert.ok(s.db.ri_recommendations.every((l) => l.evidence.outcome === 'failed' && l.evidence.failures === 3));
  assert.ok(s.db.ri_recommendations.every((l) => l.status !== 'open'));
  assert.equal(ledgerKey({ automation: 'deal_risk', targetType: 'account', targetId: 'a_birch' }), 'automation.deal_risk|account|a_birch');
});

test('a signal read out of one rep\'s private thread never fires (the draft is listed to the whole team)', async () => {
  const s = world();
  s.db.claims.find((c) => c.property === 'note.r1').private = true;
  const { deps, calls } = fakeDeps();
  await run(s, deps);
  assert.equal(calls.model, 2);
  assert.ok(!s.db.pending_actions.some((d) => d.entity_id === 'p_hollis' || d.entity_id === 'p_bea'));
});

test('stale deals held by a cooldown do not use up tonight\'s detection, so smaller deals get their turn', async () => {
  const s = world();
  // A second, smaller stale deal at another account.
  s.db.entity_list_rows.push({ workspace_id: WS, kind: 'deal', entity_id: 'd_fir', name: 'Fir pilot', company_id: 'a_fir', company_name: 'Fir', stage: 'Demo', status: 'open', pipeline_value: 100, last_activity_at: iso(30) });
  s.db.entities.push({ id: 'a_fir', workspace_id: WS, status: 'active' }, { id: 'd_fir', workspace_id: WS, status: 'active' });
  s.db.contacts.push({ id: 'p_fay', workspace_id: WS, company_id: 'a_fir', first_name: 'Fay', last_name: 'Fir', email: 'fay@fir.test', last_interaction_at: iso(30) });
  const cands = {
    a_acme: [{ dealEntityId: 'd_acme', name: 'Acme renewal', stage: 'Proposal sent', status: 'open', lastStageChangeAt: iso(16), roster: ['p_rita'] }],
    a_fir: [{ dealEntityId: 'd_fir', name: 'Fir pilot', stage: 'Demo', status: 'open', lastStageChangeAt: iso(40), roster: ['p_fay'] }],
  };
  const { deps, calls } = fakeDeps({ loadDealCandidates: async (_s, _w, id) => cands[id] ?? [] });
  const opts = { ...OPTS, dailyCap: 1 };
  // Night 1: the cap of one goes to the risk. Night 2: expansion. Night 3: the biggest deal (Acme).
  await run(s, deps, NOW, opts);
  await run(s, deps, NOW + DAY, opts);
  await run(s, deps, NOW + 2 * DAY, opts);
  // Night 4: Acme is cooling down; detection must look past it and reach Fir.
  await run(s, deps, NOW + 3 * DAY, opts);
  assert.equal(calls.model, 4);
  assert.ok(s.db.pending_actions.some((d) => d.entity_id === 'p_fay'));
});

test('a firing that ends before the model call takes no slot of the day\'s cap', async () => {
  const s = world();
  s.db.pending_actions.push({ id: 'studio1', workspace_id: WS, entity_id: 'p_hollis', kind: 'email', status: 'pending' });
  const { deps, calls } = fakeDeps();
  const r = await run(s, deps, NOW, { ...OPTS, dailyCap: 2 });
  // The risk ends at "a draft is already waiting for Hollis"; the cap of two goes to the other two.
  assert.equal(r.outcomes.recipient_has_open_draft, 1);
  assert.equal(r.drafted, 2, JSON.stringify(r));
  assert.equal(calls.model, 2);
});

// ─── The staged rollout (DETECTOR_DRAFTS_WORKSPACES) ─────────────────────────────

test('allowlist parsing: unset or empty is nobody, "*" is everyone, else the listed ids', () => {
  assert.equal(allowedWorkspaces(undefined).size, 0);
  assert.equal(allowedWorkspaces('').size, 0);
  assert.equal(allowedWorkspaces(' , ').size, 0);
  assert.equal(allowedWorkspaces('*'), '*');
  assert.equal(allowedWorkspaces('ws1, *'), '*');
  assert.deepEqual([...allowedWorkspaces(' ws1 ,ws2,')], ['ws1', 'ws2']);
});

/** Two workspaces with the same world, so a pass over "every workspace" can be told apart. */
function twoWorkspaces() {
  const s = world();
  s.db.workspaces.push({ id: 'ws2' });
  return s;
}
const all = (s, deps, allow, extra = {}) => runDetectorDrafts({ supabase: s, deps, opts: OPTS, now: NOW, allow, ...extra });

test('allowlist unset: the nightly pass runs no workspace and calls no model', async () => {
  const s = twoWorkspaces();
  const { deps, calls } = fakeDeps();
  const r = await all(s, deps, allowedWorkspaces(undefined));
  assert.equal(r.workspaces, 0);
  assert.equal(calls.model, 0);
  assert.equal(s.db.pending_actions.length + s.db.ri_recommendations.length, 0);
  // Named directly (the internal route with a workspaceId), still nothing.
  const one = await all(s, deps, allowedWorkspaces(''), { onlyWorkspace: WS });
  assert.equal(one.results[0].skipped, 'not_allowlisted');
  assert.equal(calls.model, 0);
});

test('allowlist listed: only those workspaces run', async () => {
  const s = twoWorkspaces();
  const { deps, calls } = fakeDeps();
  const r = await all(s, deps, allowedWorkspaces('ws2'));
  assert.equal(r.workspaces, 1);
  assert.equal(r.results.length, 0);          // ws2 holds no data, so nothing to draft
  assert.equal(calls.model, 0);
  const r2 = await all(s, deps, allowedWorkspaces('ws2,ws1'));
  assert.equal(r2.workspaces, 2);
  assert.equal(r2.drafted, 3);
  assert.ok(s.db.pending_actions.every((d) => d.workspace_id === WS));
});

test('allowlist "*": every workspace runs', async () => {
  const s = twoWorkspaces();
  const { deps } = fakeDeps();
  const r = await all(s, deps, allowedWorkspaces('*'));
  assert.equal(r.workspaces, 2);
  assert.equal(r.drafted, 3);
});

test('a dry run for one workspace ignores the allowlist, writes nothing, calls no model', async () => {
  const s = twoWorkspaces();
  const { deps, calls } = fakeDeps({ createMessage: async () => { throw new Error('must not be called'); } });
  const r = await all(s, deps, allowedWorkspaces(undefined), { onlyWorkspace: WS, dryRun: true });
  assert.equal(r.workspaces, 1);
  assert.equal(r.results[0].plan.length, 3);
  assert.equal(calls.model, 0);
  assert.equal(s.db.pending_actions.length + s.db.ri_recommendations.length, 0);
});

// ── Theo 2026-10-04: only deals that went stale in the last 30 days ────────────────────────
import { staleDealFiring as _sdf, quietOpenDeals as _qod } from '../src/lib/detectorDrafts.mjs';
test('stale window: 14–30 days in stage fires; older does not', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const ago = (d) => new Date(now - d * 86400000).toISOString();
  const row = (q) => ({ entity_id: 'd1', company_id: 'c1', company_name: 'Acme', status: 'open', stage: 'Demo', last_activity_at: q == null ? null : ago(q) });
  const cand = (s) => ({ status: 'open', stage: 'Demo', name: 'Acme deal', lastStageChangeAt: ago(s) });
  const o = { now, staleDays: 14, staleMaxDays: 30 };
  assert.ok(_sdf(row(20), cand(20), o), '20 days fires');
  assert.equal(_sdf(row(20), cand(45), o), null, '45 days in stage is too old');
  assert.equal(_sdf(row(60), cand(25), o), null, 'no touch in 60 days is too old');
  assert.ok(_sdf(row(null), cand(17), o), 'never touched, 17 days in stage fires');
  assert.equal(_qod([row(90)], o).length, 0, 'a deal quiet for 90 days is not even a candidate');
  assert.equal(_qod([row(20)], o).length, 1);
});


// ─── Deal signals (GET-694): a call's objection, competitor, buying signal or departure ─────────

const sig = (id, account_id, kind, daysAgo, over = {}) => ({
  id, workspace_id: WS, account_id, entity_id: 'p_rita', kind, title: null, content: `${kind} fact`, quote: null,
  speaker: null, detail: {}, occurred_at: iso(daysAgo), team_readable: true, ...over,
});

test('deal signal firings: one per account, the most urgent kind, team-readable and recent only', () => {
  const rows = [
    sig('s1', 'a1', 'buying_signal', 1),
    sig('s2', 'a1', 'objection_raised', 2, { content: 'Price is above budget', speaker: 'Rita Roster' }),
    sig('s3', 'a2', 'competitor_evaluating', 1, { detail: { product: 'Gong' } }),
    sig('s4', 'a3', 'objection_raised', 1, { team_readable: null }),      // privacy not checked yet
    sig('s5', 'a4', 'objection_raised', 9),                                // outside the lookback
    sig('s6', 'a5', 'next_step', 1),                                       // information, not a reason to write
    sig('s7', 'a6', 'churn_risk', 1),                                      // Deal risk detection's job
  ];
  const f = dealSignalFirings(rows, { now: NOW, lookbackDays: 7, names: new Map([['a1', 'Acme']]) });
  assert.deepEqual(f.map((x) => x.accountId).sort(), ['a1', 'a2']);
  const a1 = f.find((x) => x.accountId === 'a1');
  assert.equal(a1.trigger.kind, 'objection_raised');
  assert.equal(a1.fingerprint, 'a1|signal:s2');
  assert.match(a1.why, /^Raised an objection on Oct 2: Price is above budget/);
  assert.equal(a1.raisedBy, 'Rita Roster');
  assert.equal(a1.prompt, DEAL_SIGNALS.objection_raised.prompt);
  assert.match(f.find((x) => x.accountId === 'a2').why, /^Evaluating Gong/);
});

test('a departure is never written to the person who left', () => {
  const [f] = dealSignalFirings([sig('s1', 'a1', 'stakeholder_left', 1, { entity_id: 'p_cass', speaker: 'Cass Champion' })], { now: NOW });
  assert.deepEqual(f.excludeIds, ['p_cass']);
  assert.equal(f.raisedBy, null);
  const people = [
    { id: 'p_cass', first_name: 'Cass', last_name: 'Champion', email: 'cass@acme.test', last_interaction_at: iso(0) },
    { id: 'p_rita', first_name: 'Rita', last_name: 'Roster', email: 'rita@acme.test', last_interaction_at: iso(9) },
  ];
  assert.deepEqual(rankRecipients(people, { championIds: ['p_cass'], excludeIds: f.excludeIds }).map((p) => p.id), ['p_rita']);
});

test('deal signals rank after a customer in trouble and before openings and quiet deals', () => {
  assert.deepEqual(DETECTOR_ORDER, ['deal_risk', 'deal_signal', 'expansion_signal', 'stale_deal']);
});

test('a deal signal drafts once, to whoever raised it, with its own instruction; only an open deal is chased', async () => {
  const s = world();
  s.db.account_signals = [
    sig('s1', 'a_acme', 'objection_raised', 1, { content: 'Security review needs SOC 2', speaker: 'Rita', quote: 'We need your SOC 2 before legal signs' }),
    sig('s2', 'a_birch', 'objection_raised', 1, { entity_id: 'p_hollis' }),   // a won customer: not a deal to chase
  ];
  const { deps, calls } = fakeDeps();
  const r = await runDetectorDraftsForWorkspace(s, WS, { now: NOW, deps, opts: { ...OPTS, only: ['deal_signal'] } });
  assert.equal(r.drafted, 1, JSON.stringify(r));
  const [d] = s.db.pending_actions;
  assert.equal(d.recipient_email, 'rita@acme.test');
  assert.match(d.rationale, /^Raised an objection on Oct 3: Security review needs SOC 2/);
  assert.match(calls.last.messages[0].content, /Answer it directly with one concrete point/);
  assert.match(calls.last.messages[0].content, /We need your SOC 2 before legal signs/);
  const ledger = s.db.ri_recommendations.find((l) => l.rec_key === recKeyOf('deal_signal'));
  assert.equal(ledger.evidence.automation_name, 'Deal signals');
  assert.equal(originOf(d, { recs: new Map([[ledger.id, ledger]]) }).name, 'Deal signals');

  // The hourly pass again: the same signal is not drafted twice.
  await runDetectorDraftsForWorkspace(s, WS, { now: NOW + 3_600_000, deps, opts: { ...OPTS, only: ['deal_signal'] } });
  assert.equal(s.db.pending_actions.length, 1);
  assert.equal(calls.model, 1);
});

test('the hourly deal-signal pass does not run the other detectors', async () => {
  const s = world();
  let candidates = 0;
  const { deps } = fakeDeps({ loadDealCandidates: async () => { candidates += 1; return []; } });
  const r = await runDetectorDraftsForWorkspace(s, WS, { now: NOW, deps, opts: { ...OPTS, only: ['deal_signal'] } });
  assert.equal(r.drafted, 0);
  assert.equal(candidates, 0);
  assert.equal(s.db.pending_actions.length, 0);
});

// GET-902: the drafts follow the team's "Email voice", the context file of the box that holds each
// detector's built-in, read once per pass; without one they read exactly as before.
test('the drafts are written in the voice of the box that holds the detector', async () => {
  const s = world();
  let reads = 0;
  const voices = new Map([['stale_deal', { text: 'Formal, three sentences at most.' }], ['deal_risk', { text: 'Relaxed and short.' }]]);
  const { deps, calls } = fakeDeps({ emailVoices: async () => { reads += 1; return voices; } });
  const systems = [];
  const create = deps.createMessage;
  deps.createMessage = async (req) => { systems.push(req.system); return create(req); };
  const r = await run(s, deps);
  assert.equal(r.drafted, 3);
  assert.equal(reads, 1, 'read once per pass');
  assert.equal(calls.model, 3);
  assert.equal(systems.filter(x => x.includes('Formal, three sentences at most.')).length, 1);
  assert.equal(systems.filter(x => x.includes('Relaxed and short.')).length, 1);
  // Expansion's box has no voice file: its draft reads as before (house rules and the sender only).
  assert.equal(systems.filter(x => x === draftSystem({ memberBlock: 'You are writing as Theo.' })).length, 1);
  assert.ok(systems.every(x => x.startsWith(EMAIL_DRAFT_SYSTEM)));
});

test('a voice that cannot be read leaves the drafts as they were', async () => {
  const s = world();
  const { deps } = fakeDeps({ emailVoices: async () => { throw new Error('down'); } });
  const systems = [];
  const create = deps.createMessage;
  deps.createMessage = async (req) => { systems.push(req.system); return create(req); };
  const r = await run(s, deps);
  assert.equal(r.drafted, 3);
  assert.ok(systems.every(x => x === draftSystem({ memberBlock: 'You are writing as Theo.' })));
  assert.equal(voiceFor({ automation: 'deal_signal' }, new Map([['deal_signals', { text: 'x' }]])), 'x');
  assert.equal(voiceFor({ automation: 'expansion_signal' }, null), null);
});
