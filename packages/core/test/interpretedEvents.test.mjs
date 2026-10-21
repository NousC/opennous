// Interpreted events (GET-950): the champion left, the deal stalled, the customer asked for more.
// The rules, against fixtures from the invented world (Harborline, Fernpoint, the Lumen products).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/interpretedEvents.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  championLeftEvent, championWhoLeft, replacementFor, championLeftConfidence,
  stalledDealEvent, expansionRequestedEvent,
} from '../dist/services/interpretedEvents.mjs';
import { TRIGGER_EVENTS, EVENT_CATALOG } from '../dist/db/triggers.js';
import { eventLabel, eventTone, eventSummary } from '../dist/services/eventText.mjs';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();

const left = (over = {}) => ({
  id: 's-left', workspace_id: 'w1', entity_id: 'p-mara', account_id: 'a-harbor', kind: 'stakeholder_left',
  claim_property: 'note.left', title: 'Champion leaving', content: 'Mara Quill is leaving Harborline at the end of the month.',
  quote: 'Mara is moving on, her last day is the 31st.', speaker: 'Theo Brandt', source_ref: 'call:42',
  detail: { change: 'left', source: 'call_transcript' }, occurred_at: ago(1), ...over,
});
const names = new Map([['p-mara', 'Mara Quill'], ['p-theo', 'Theo Brandt'], ['p-ines', 'Ines Varga']]);
const confirmedEdge = { subject_id: 'p-mara', subject_label: 'Mara Quill', object_id: 'a-harbor', relationship: 'CHAMPIONS', confidence: 0.95, created_at: ago(90) };
const likelyEdge = { ...confirmedEdge, confidence: 0.6 };

test('a champion leaving, said about them in a quote, on a confirmed edge: high confidence', () => {
  const e = championLeftEvent(left(), { edges: [confirmedEdge], names });
  assert.equal(e.type, 'account.champion_left');
  assert.equal(e.accountId, 'a-harbor');
  assert.equal(e.personId, 'p-mara');
  assert.equal(e.dedupeKey, 's-left');
  assert.deepEqual(e.data.person, { entity_id: 'p-mara', name: 'Mara Quill' });
  assert.equal(e.data.champion.via, 'confirmed_edge');
  assert.equal(e.data.replacement, null);
  assert.equal(e.data.confidence, 'high');
  assert.deepEqual(e.data.evidence, {
    text: 'Mara Quill is leaving Harborline at the end of the month.', quote: 'Mara is moving on, her last day is the 31st.',
    speaker: 'Theo Brandt', source: 'call_transcript', source_ref: 'call:42', said_at: ago(1),
  });
  assert.equal('action' in e.data, false, 'the fact and the reading, never the action');
});

test('someone who was not a champion leaving is no champion_left', () => {
  assert.equal(championLeftEvent(left({ entity_id: 'p-theo' }), { edges: [confirmedEdge], names }), null);
  assert.equal(championLeftEvent(left(), { edges: [], roles: new Map(), names }), null);
  assert.equal(championLeftEvent(left({ kind: 'stakeholder_joined' }), { edges: [confirmedEdge], names }), null);
});

test('a champion read from the committee, or a likely edge: medium with a quote, low without', () => {
  const byRole = championLeftEvent(left(), { roles: new Map([['p-mara', 'champion']]), names });
  assert.equal(byRole.data.champion.via, 'committee_role');
  assert.equal(byRole.data.confidence, 'medium');
  assert.match(byRole.data.confidence_reason, /committee/);
  const likelyNoQuote = championLeftEvent(left({ quote: null }), { edges: [likelyEdge], names });
  assert.equal(likelyNoQuote.data.confidence, 'low');
  assert.match(likelyNoQuote.data.confidence_reason, /inferred/);
  assert.match(likelyNoQuote.data.confidence_reason, /without a quote/);
  const confirmedNoQuote = championLeftEvent(left({ quote: '' }), { edges: [confirmedEdge], names });
  assert.equal(confirmedNoQuote.data.confidence, 'medium');
});

// A departure filed on the company: who left is read off the words, against every contact.
const contacts = [
  { entity_id: 'p-mara', name: 'Mara Quill' }, { entity_id: 'p-theo', name: 'Theo Brandt' }, { entity_id: 'p-ines', name: 'Ines Varga' },
];
const onCompany = (over = {}) => left({ entity_id: 'a-harbor', title: null, ...over });

test('company-scoped, full name: the champion is resolved, and the event names person and account', () => {
  const who = championWhoLeft(onCompany(), { edges: [confirmedEdge], names, people: contacts });
  assert.deepEqual(who, { personId: 'p-mara', name: 'Mara Quill', via: 'confirmed_edge', matchedBy: 'full_name' });
  const e = championLeftEvent(onCompany(), { edges: [confirmedEdge], names, people: contacts, accountName: 'Harborline' });
  assert.equal(e.personId, 'p-mara');
  assert.equal(e.accountId, 'a-harbor');
  assert.deepEqual(e.data.person, { entity_id: 'p-mara', name: 'Mara Quill' });
  assert.deepEqual(e.data.account, { entity_id: 'a-harbor', name: 'Harborline' });
  assert.equal(e.data.resolved_by, 'full_name');
  assert.equal(e.data.confidence, 'medium', 'confirmed edge, but read off the company');
  assert.match(e.data.confidence_reason, /by full name/);
});

test('company-scoped, first name only: resolved among all contacts, confidence a step lower', () => {
  const s = onCompany({ content: 'Mara is moving on at the end of the month.', quote: 'Mara is leaving us.' });
  const e = championLeftEvent(s, { edges: [confirmedEdge], names, people: contacts });
  assert.equal(e.personId, 'p-mara');
  assert.equal(e.data.resolved_by, 'first_name');
  assert.equal(e.data.confidence, 'low');
  assert.match(e.data.confidence_reason, /first name only/);
});

test('company-scoped, the person who left was no champion: nothing beyond the signal', () => {
  const s = onCompany({ content: 'Theo Brandt has left the company.', quote: null, speaker: 'Mara Quill' });
  assert.equal(championWhoLeft(s, { edges: [confirmedEdge], names, people: contacts }), null);
});

test('company-scoped, ambiguous: two contacts share the first name, or two people named', () => {
  const twoMaras = [...contacts, { entity_id: 'p-mara2', name: 'Mara Lindqvist' }];
  const s = onCompany({ content: 'Mara is moving on.', quote: 'Mara is leaving.' });
  assert.equal(championLeftEvent(s, { edges: [confirmedEdge], names, people: twoMaras }), null);
  const two = onCompany({ content: 'Mara Quill and Ines Varga both left.' });
  assert.equal(championWhoLeft(two, { edges: [confirmedEdge, { ...confirmedEdge, subject_id: 'p-ines', subject_label: 'Ines Varga' }], names, people: contacts }), null);
  assert.equal(championLeftEvent(onCompany({ content: 'Someone on the ops team left.', quote: null }), { edges: [confirmedEdge], names, people: contacts }), null);
});

test('company-scoped, the speaker: set aside when they report a colleague, taken when they speak of themselves', () => {
  // "Theo told us Mara is leaving", said by Theo: two first names, the speaker is not who left.
  const reported = onCompany({ content: 'Theo said Mara is leaving next month.', quote: null, speaker: 'Theo Brandt' });
  assert.equal(championWhoLeft(reported, { edges: [confirmedEdge], names, people: contacts })?.personId, 'p-mara');
  // "I am moving on", said by Mara: the text names nobody, the speaker left.
  const self = onCompany({ content: 'Moving on to a new role in November.', quote: 'I am moving on in November.', speaker: 'Mara Quill' });
  const who = championWhoLeft(self, { edges: [confirmedEdge], names, people: contacts });
  assert.equal(who?.personId, 'p-mara');
  assert.equal(who.matchedBy, 'full_name');
});

test('the replacement: a new champion beats a join, within the window, never the leaver', () => {
  const related = [
    { id: 's-join', account_id: 'a-harbor', entity_id: 'p-theo', kind: 'stakeholder_joined', occurred_at: ago(2), quote: 'Theo joins us', detail: {} },
    { id: 's-champ', account_id: 'a-harbor', entity_id: 'p-ines', kind: 'stakeholder_identified', occurred_at: ago(0), quote: 'Ines will own this now', detail: { role: 'champion' } },
    { id: 's-old', account_id: 'a-harbor', entity_id: 'p-old', kind: 'stakeholder_identified', occurred_at: ago(80), detail: { role: 'champion' } },
    { id: 's-self', account_id: 'a-harbor', entity_id: 'p-mara', kind: 'stakeholder_identified', occurred_at: ago(1), detail: { role: 'champion' } },
    { id: 's-else', account_id: 'a-fern', entity_id: 'p-x', kind: 'stakeholder_identified', occurred_at: ago(1), detail: { role: 'champion' } },
  ];
  const r = replacementFor(left(), 'p-mara', { related, names });
  assert.deepEqual(r, { entity_id: 'p-ines', name: 'Ines Varga', via: 'new_champion', said_at: ago(0), quote: 'Ines will own this now', signal_id: 's-champ' });
  const onlyJoin = replacementFor(left(), 'p-mara', { related: related.filter((x) => x.id === 's-join'), names });
  assert.equal(onlyJoin.via, 'stakeholder_joined');
  assert.equal(onlyJoin.entity_id, 'p-theo');
  // A champion edge on someone else, new in the window, counts; an old one does not.
  const edgeNew = { subject_id: 'p-ines', subject_label: 'Ines Varga', relationship: 'CHAMPIONS', confidence: 0.95, created_at: ago(3) };
  assert.equal(replacementFor(left(), 'p-mara', { edges: [edgeNew, confirmedEdge], names }).via, 'champion_edge');
  assert.equal(replacementFor(left(), 'p-mara', { edges: [{ ...edgeNew, created_at: ago(200) }], names }), null);
  const e = championLeftEvent(left(), { edges: [confirmedEdge], related, names });
  assert.equal(e.data.replacement.entity_id, 'p-ines');
});

test('confidence reads plainly', () => {
  const c = championLeftConfidence({ via: 'confirmed_edge', matchedByName: false }, { quote: 'x' });
  assert.deepEqual(c, { level: 'high', reason: 'champion stated outright on a call or in mail; departure said about them, in a quote' });
  assert.doesNotMatch(c.reason, /—/, 'no em dashes in what a receiver shows');
});

// ── deal.stalled ──
const dealRow = (over = {}) => ({ entity_id: 'd-1', name: 'Fernpoint, Lumen Scan rollout', company_id: 'a-fern', company_name: 'Fernpoint', stage: 'proposal', status: 'open', pipeline_value: 42000, last_activity_at: ago(20), ...over });
const cand = (over = {}) => ({ dealEntityId: 'd-1', name: 'Fernpoint, Lumen Scan rollout', stage: 'Proposal sent', status: 'open', lastStageChangeAt: ago(25), ...over });

test('an open deal past its stage window with no touch is stalled, once per stage stint', () => {
  const e = stalledDealEvent(dealRow(), cand(), { now: NOW, staleDays: 14 });
  assert.equal(e.type, 'deal.stalled');
  assert.equal(e.dealId, 'd-1');
  assert.equal(e.accountId, 'a-fern');
  assert.equal(e.dedupeKey, `d-1|proposal sent|${ago(25).slice(0, 10)}`);
  assert.equal(e.data.stage, 'Proposal sent');
  assert.equal(e.data.days_in_stage, 25);
  assert.equal(e.data.days_since_touch, 20);
  assert.equal(e.data.window_days, 14);
  assert.equal(e.data.evidence.stage_entered_at, ago(25));
  assert.equal(e.data.evidence.last_touch_at, ago(20));
  assert.equal(e.data.evidence.value, 42000);
  // Dated when it crossed: the last touch plus the window (later than the stage's).
  assert.equal(e.occurredAt, ago(6));
  // The same stint read again: the same key. A new stage: a new key.
  assert.equal(stalledDealEvent(dealRow(), cand(), { now: NOW + 86_400_000, staleDays: 14 }).dedupeKey, e.dedupeKey);
  assert.notEqual(stalledDealEvent(dealRow(), cand({ stage: 'Negotiation', lastStageChangeAt: ago(15) }), { now: NOW, staleDays: 14 })?.dedupeKey, e.dedupeKey);
});

test('a touched, young, closed or undated deal is not stalled', () => {
  assert.equal(stalledDealEvent(dealRow({ last_activity_at: ago(3) }), cand(), { now: NOW }), null, 'touched recently');
  assert.equal(stalledDealEvent(dealRow(), cand({ lastStageChangeAt: ago(5) }), { now: NOW }), null, 'new in its stage');
  assert.equal(stalledDealEvent(dealRow({ status: 'won' }), cand({ status: 'won' }), { now: NOW }), null, 'closed');
  assert.equal(stalledDealEvent(dealRow(), cand({ lastStageChangeAt: null }), { now: NOW }), null, 'undated stage');
  const never = stalledDealEvent(dealRow({ last_activity_at: null }), cand(), { now: NOW });
  assert.equal(never.data.days_since_touch, null, 'never touched still stalls');
  assert.equal(never.occurredAt, ago(11), 'dated by the stage window when never touched');
});

// ── account.expansion_requested ──
const ask = (over = {}) => ({
  id: 's-ask', account_id: 'a-fern', entity_id: 'p-ines', kind: 'expansion_signal', content: 'They want Lumen Scan for the second plant.',
  quote: 'Can we get Lumen Scan at the Delft plant too?', speaker: 'Ines Varga', source_ref: 'call:7',
  detail: { stance: 'asked', product: 'Lumen Scan' }, occurred_at: ago(1), ...over,
});

test('a customer asking for more of a named product is expansion_requested', () => {
  const e = expansionRequestedEvent(ask());
  assert.equal(e.type, 'account.expansion_requested');
  assert.equal(e.dedupeKey, 's-ask');
  assert.equal(e.personId, 'p-ines');
  assert.deepEqual(e.data, {
    signal_id: 's-ask', account_id: 'a-fern', product: 'Lumen Scan', text: 'They want Lumen Scan for the second plant.',
    quote: 'Can we get Lumen Scan at the Delft plant too?', speaker: 'Ines Varga', said_at: ago(1), source_ref: 'call:7',
  });
});

test('considering, no product, no quote, or a later no is not an ask', () => {
  assert.equal(expansionRequestedEvent(ask({ detail: { stance: 'considering', product: 'Lumen Scan' } })), null);
  assert.equal(expansionRequestedEvent(ask({ detail: { stance: 'asked' } })), null);
  assert.equal(expansionRequestedEvent(ask({ quote: null })), null);
  assert.equal(expansionRequestedEvent(ask({ kind: 'expansion_declined' })), null);
  const no = { kind: 'expansion_declined', account_id: 'a-fern', detail: { product: 'lumen scan' }, occurred_at: ago(0) };
  assert.equal(expansionRequestedEvent(ask(), { declines: [no] }), null);
  assert.ok(expansionRequestedEvent(ask(), { declines: [{ ...no, occurred_at: ago(3) }] }), 'a no before the ask does not stand');
  assert.ok(expansionRequestedEvent(ask(), { declines: [{ ...no, detail: { product: 'Lumen Grid' } }] }), 'a no to another product');
});

test('the three are in the catalog, described and labelled', () => {
  for (const t of ['account.champion_left', 'account.expansion_requested', 'deal.stalled']) {
    assert.ok(TRIGGER_EVENTS.includes(t), t);
    const def = EVENT_CATALOG.find((c) => c.type === t);
    assert.ok(def?.description, `${t} described`);
    assert.equal(def.record, true);
    assert.doesNotMatch(def.description, /—/);
    assert.notEqual(eventLabel(t), t);
  }
  assert.equal(eventTone('account.champion_left'), 'risk');
  assert.equal(eventTone('account.expansion_requested'), 'positive');
  assert.equal(eventTone('deal.stalled'), 'warning');
  assert.equal(eventSummary({ type: 'account.champion_left', data: { person: { name: 'Mara Quill' }, replacement: { name: 'Ines Varga' } } }), 'Mara Quill left; Ines Varga takes over');
  assert.equal(eventSummary({ type: 'account.champion_left', data: { person: { name: 'Mara Quill' }, replacement: null } }), 'Mara Quill left, no replacement named');
  assert.equal(eventSummary({ type: 'account.expansion_requested', data: { product: 'Lumen Scan' } }), 'Asked for more Lumen Scan');
  assert.equal(eventSummary({ type: 'deal.stalled', data: { stage: 'Proposal sent', days_in_stage: 25 } }), '25 days in Proposal sent');
});

// ── In the signal pass: emitted next to signal.*, once per signal ──
import { processAccountSignals, emitStalledDealsPoll } from '../dist/services/automationRun.mjs';
import { slackMessage } from '../dist/services/eventText.mjs';

// A Supabase stand-in (as accountSignals.test.mjs): eq/is narrow the fixtures, every write is recorded.
function fakeDb(tables) {
  const writes = [];
  const from = (table) => {
    const filters = [];
    let op = null, payload = null;
    const rows = () => (tables[table] ?? []).filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v));
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          if (op) { writes.push({ table, op, payload, filters: [...filters] }); return (res) => res({ data: null, error: null }); }
          return (res) => res({ data: rows(), error: null });
        }
        if (prop === 'maybeSingle' || prop === 'single') return async () => {
          if (op) writes.push({ table, op, payload, filters: [...filters] });
          return { data: op === 'insert' ? { id: 'run-1' } : rows()[0] ?? null, error: null };
        };
        if (prop === 'eq' || prop === 'is') return (k, v) => { filters.push([k, v]); return q; };
        if (['insert', 'update', 'upsert'].includes(prop)) return (p) => { op = prop; payload = p; return q; };
        return () => q;
      },
    });
    return q;
  };
  return { from, writes };
}

const freshSignals = () => {
  const now = new Date().toISOString();
  const base = { workspace_id: 'w1', account_id: 'a-harbor', source_ref: 'call:42', processed_at: null, occurred_at: now };
  return [
    { ...base, id: 's-left', entity_id: 'p-mara', kind: 'stakeholder_left', claim_property: 'note.left', title: 'Mara leaving',
      content: 'Mara Quill is leaving.', quote: 'Mara is moving on.', speaker: 'Theo Brandt', detail: { change: 'left', source: 'call_transcript' } },
    { ...base, id: 's-ask', entity_id: 'p-theo', kind: 'expansion_signal', claim_property: 'note.ask', title: 'More seats',
      content: 'They want Lumen Scan for the Delft plant.', quote: 'Can we add Lumen Scan in Delft?', speaker: 'Theo Brandt', detail: { stance: 'asked', product: 'Lumen Scan' } },
    { ...base, id: 's-maybe', entity_id: 'p-theo', kind: 'expansion_signal', claim_property: 'note.maybe', title: 'Maybe more',
      content: 'Thinking about Lumen Grid next year.', quote: 'Maybe Lumen Grid next year.', speaker: 'Theo Brandt', detail: { stance: 'considering', product: 'Lumen Grid' } },
  ];
};
const tables = (over = {}) => ({
  account_signals: freshSignals(),
  claims: ['note.left', 'note.ask', 'note.maybe'].map((property) => ({ entity_id: property === 'note.left' ? 'p-mara' : 'p-theo', property, value: { metadata: { signal_type: 'call_transcript' } }, supporting_observation_ids: [] })),
  agent_routines: [],
  trigger_subscriptions: [{ id: 'sub-1', created_at: '2026-01-01T00:00:00Z' }],
  outbound_events: [],
  event_log: [],
  workspace_graph_edges: [{ id: 'e1', subject_id: 'p-mara', subject_label: 'Mara Quill', object_id: 'a-harbor', relationship: 'CHAMPIONS', confidence: 0.95, created_at: '2026-06-01T00:00:00Z', source_memory_id: null }],
  entity_list_rows: [
    { entity_id: 'a-harbor', kind: 'account', name: 'Harborline' },
    { entity_id: 'p-mara', kind: 'person', company_id: 'a-harbor', name: 'Mara Quill' },
    { entity_id: 'p-theo', kind: 'person', company_id: 'a-harbor', name: 'Theo Brandt' },
  ],
  ...over,
});

test('the signal pass emits champion_left and expansion_requested beside the signals, never for considering', async () => {
  const db = fakeDb(tables());
  await processAccountSignals({ supabase: db });
  const types = db.writes.filter(w => w.table === 'outbound_events').map(w => w.payload[0].event_type);
  assert.deepEqual(types.sort(), ['account.champion_left', 'account.expansion_requested', 'signal.expansion_signal', 'signal.expansion_signal', 'signal.stakeholder_left']);
  const champ = db.writes.find(w => w.table === 'outbound_events' && w.payload[0].event_type === 'account.champion_left').payload[0];
  assert.equal(champ.external_id, 'account.champion_left:s-left');
  assert.equal(champ.payload.data.person.name, 'Mara Quill');
  assert.equal(champ.payload.data.confidence, 'high');
  const logged = db.writes.filter(w => w.table === 'event_log').map(w => w.payload.type);
  assert.ok(logged.includes('account.champion_left') && logged.includes('account.expansion_requested'), 'in the event log');
});

test('a non-champion leaving raises only the signal', async () => {
  const db = fakeDb(tables({ workspace_graph_edges: [] }));
  await processAccountSignals({ supabase: db });
  const types = db.writes.filter(w => w.table === 'outbound_events').map(w => w.payload[0].event_type);
  assert.ok(!types.includes('account.champion_left'));
  assert.ok(types.includes('signal.stakeholder_left'));
});

test('once per signal: a champion_left already sent and logged is not sent or logged again', async () => {
  const db = fakeDb(tables({
    event_log: [{ id: 'ev-1', workspace_id: 'w1', external_id: 'account.champion_left:s-left', payload: { id: 'ev-1', type: 'account.champion_left' } }],
    outbound_events: [{ workspace_id: 'w1', external_id: 'account.champion_left:s-left', subscription_id: 'sub-1' }],
  }));
  await processAccountSignals({ supabase: db });
  const champ = db.writes.filter(w => (w.table === 'outbound_events' || w.table === 'event_log')
    && JSON.stringify(w.payload).includes('account.champion_left'));
  assert.equal(champ.length, 0);
});

test('Slack quotes the evidence of an interpreted event', () => {
  const m = slackMessage('account.champion_left', { account: { name: 'Harborline' }, data: { person: { name: 'Mara Quill' }, replacement: null, evidence: { quote: 'Mara is moving on.', speaker: 'Theo Brandt' } } });
  assert.match(m.blocks[0].text.text, /Champion left\* · Harborline\nMara Quill left, no replacement named\n> Mara is moving on\. .+ Theo Brandt/);
});

test('the stalled-deal poll runs for every workspace, with or without a listener', async () => {
  const reads = [];
  const quiet = { entity_id: 'd-1', name: 'Rollout', company_id: 'a-fern', stage: 'proposal', status: 'open', pipeline_value: 1, last_activity_at: ago(40) };
  const db = fakeDb({ workspaces: [{ id: 'w1' }], trigger_subscriptions: [], entity_list_rows: [quiet], event_log: [], relationships: [] });
  const from = db.from;
  db.from = (t) => { reads.push(t); return from(t); };
  await emitStalledDealsPoll({ supabase: db, now: NOW });
  assert.ok(reads.includes('workspaces'), 'every workspace');
  assert.ok(reads.includes('relationships'), 'a quiet deal gets the stage-history read');
});

test('the stalled-deal poll is cheap: a touched deal, or one already logged for its stage, gets no stage read', async () => {
  for (const [row, logged] of [
    [{ entity_id: 'd-1', company_id: 'a-fern', stage: 'proposal', status: 'open', last_activity_at: ago(2) }, []],
    [{ entity_id: 'd-1', company_id: 'a-fern', stage: 'Proposal', status: 'open', last_activity_at: ago(40) }, [{ workspace_id: 'w1', type: 'deal.stalled', external_id: `deal.stalled:d-1|proposal|${ago(50).slice(0, 10)}` }]],
  ]) {
    const reads = [];
    const db = fakeDb({ workspaces: [{ id: 'w1' }], entity_list_rows: [row], event_log: logged });
    const from = db.from;
    db.from = (t) => { reads.push(t); return from(t); };
    await emitStalledDealsPoll({ supabase: db, now: NOW });
    assert.ok(!reads.includes('relationships'), JSON.stringify(row));
  }
});

test('a meeting booked ahead means waiting, not stalled; a meeting held is a touch', () => {
  assert.equal(stalledDealEvent(dealRow(), cand(), { now: NOW, meetings: [new Date(NOW + 21 * 86_400_000).toISOString()] }), null, 'call in 3 weeks');
  assert.equal(stalledDealEvent(dealRow(), cand(), { now: NOW, meetings: [ago(4)] }), null, 'met 4 days ago');
  const e = stalledDealEvent(dealRow(), cand(), { now: NOW, meetings: [ago(22)] });
  assert.equal(e.data.days_since_touch, 20, 'an older meeting does not move the last touch back');
  const viaMeeting = stalledDealEvent(dealRow({ last_activity_at: ago(24) }), cand(), { now: NOW, meetings: [ago(16)] });
  assert.equal(viaMeeting.data.days_since_touch, 16);
  assert.equal(viaMeeting.data.evidence.last_touch_at, ago(16));
  assert.equal(viaMeeting.occurredAt, ago(2), 'crossed the window 14 days after that meeting');
});

