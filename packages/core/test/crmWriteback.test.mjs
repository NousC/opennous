// Follow-up write-back to HubSpot (Phase 4), against a mocked fetch. Nothing here reaches HubSpot.
//
// The invariants that matter: a task lands on the deal, the company and the people with the
// verified association ids; the updates become ONE note on the deal and company; a second run
// creates nothing; a partial failure keeps the ids that landed, so a retry finishes the job; a
// 401/403 stops the run with the plain "grant write access" answer; and no request ever writes a
// deal (or anything but a task or a note).
//
// Run: cd packages/core && node --test test/crmWriteback.test.mjs   (after tsc)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncFollowUpToHubspot, syncTaskStatusToHubspot, hubspotAssociationsFor, hubspotTaskProperties, hubspotNoteProperties,
  isWritableHubspotRequest, readSyncState, taskDueAt, nextBusinessDay, zonedInstant, dealEntityIdsOf, approvedUpdates,
  hubspotTaskIdOf, HUBSPOT_TASK_ASSOC, HUBSPOT_NOTE_ASSOC, WRITEBACK_NOT_ALLOWED, WRITEBACK_NOT_ALLOWED_MESSAGE,
} from '../dist/services/crmWriteback.js';

const DEAL_A = '22222222-2222-4222-8222-222222222222';
const DEAL_B = '33333333-3333-4333-8333-333333333333';
const TARGETS = { dealIds: ['9001'], companyId: '7001', contactIds: ['5001', '5002'] };

const card = (over = {}) => ({
  id: 'fu-1', account_entity_id: '11111111-1111-4111-8111-111111111111', deal_entity_id: DEAL_A,
  meetings: [{ title: 'Pricing call', kind: 'Call', at: '2026-10-01T15:00:00Z' }],
  content: {
    email: { to: ['dana@acme.test'], subject: 'Pilot quote', body: 'Hi' },
    updates: [
      { id: 'u1', label: 'Next step', value: 'Pilot quote by Friday' },
      { id: 'u2', label: 'Note', value: 'Security review <first>' },
      { id: 'u3', label: 'Note', value: 'not approved' },
    ],
  },
  verdict: { tasks_ticked: 2, task_ids: ['t1', 't2'], update_ids: ['u1', 'u2'] },
  ...over,
});
const APPROVED = {
  tasks: [
    { id: 't1', text: 'Send the pilot quote', due: '2026-10-09', quote: 'Can we see a quote by Friday?' },
    { id: 't2', text: 'Book the infosec review', due: null },
  ],
  updateIds: ['u1', 'u2'],
};

// ── The mocked HubSpot ───────────────────────────────────────────────────────

let calls = [];
let respond = null;
const realFetch = globalThis.fetch;
let nextId = 100;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const defaultRespond = (url, init) => {
  if (url.includes('/crm/v3/owners')) return json(200, { results: [{ id: '42', email: 'tamsin@us.test' }] });
  if (init?.method === 'POST') return json(201, { id: String(nextId++) });
  if (init?.method === 'PATCH') return json(200, { id: 'x' });
  return json(404, {});
};
beforeEach(() => {
  calls = []; nextId = 100; respond = defaultRespond;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return respond(call.url, init, calls.length);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const writes = () => calls.filter((c) => c.method !== 'GET');
const run = (over = {}) => {
  const persisted = [];
  const p = syncFollowUpToHubspot({
    workspaceId: 'ws1', card: card(), approved: APPROVED, token: 'pat-test', targets: TARGETS,
    ownerEmails: ['tamsin@us.test'], timeZone: 'America/New_York', approverName: 'Tamsin Rowe',
    now: new Date('2026-10-02T16:00:00Z'), persist: async (s) => { persisted.push(structuredClone(s)); },
    ...over,
  });
  return p.then((r) => ({ r, persisted }));
};

// ── Shapes ───────────────────────────────────────────────────────────────────

test('verified association ids: task→deal 216, contact 204, company 192; note→deal 214, contact 202, company 190', () => {
  assert.deepEqual(HUBSPOT_TASK_ASSOC, { deal: 216, contact: 204, company: 192 });
  assert.deepEqual(HUBSPOT_NOTE_ASSOC, { deal: 214, contact: 202, company: 190 });
});

test('a task lands on every deal, the company and the people; blanks and duplicates dropped', () => {
  const a = hubspotAssociationsFor(HUBSPOT_TASK_ASSOC, { dealIds: ['9001', '9002', '9001', ''], companyId: '7001', contactIds: ['5001', null, '5001'] });
  assert.deepEqual(a.map((x) => [x.to.id, x.types[0].associationTypeId]), [['9001', 216], ['9002', 216], ['7001', 192], ['5001', 204]]);
  for (const x of a) assert.equal(x.types[0].associationCategory, 'HUBSPOT_DEFINED');
  const n = hubspotAssociationsFor(HUBSPOT_NOTE_ASSOC, TARGETS, { contacts: false });
  assert.deepEqual(n.map((x) => [x.to.id, x.types[0].associationTypeId]), [['9001', 214], ['7001', 190]]);
});

test('task properties: subject, the quote and the meeting in the body, due 9:00 workspace time, open, a to-do, the owner', () => {
  const p = hubspotTaskProperties({ task: APPROVED.tasks[0], meeting: card().meetings[0], ownerId: '42', timeZone: 'America/New_York', now: new Date('2026-10-02T16:00:00Z') });
  assert.equal(p.hs_task_subject, 'Send the pilot quote');
  assert.match(p.hs_task_body, /Can we see a quote by Friday\?/);
  assert.match(p.hs_task_body, /From: Pricing call, Oct 1, 2026 via Nous/);
  assert.equal(p.hs_timestamp, '2026-10-09T13:00:00.000Z', '9:00 in New York (EDT) is 13:00 UTC');
  assert.equal(p.hs_task_status, 'NOT_STARTED');
  assert.equal(p.hs_task_type, 'TODO');
  assert.equal(p.hubspot_owner_id, '42');
  assert.ok(!('hubspot_owner_id' in hubspotTaskProperties({ task: APPROVED.tasks[1], timeZone: 'UTC' })), 'no owner, no owner property');
  assert.equal(hubspotTaskProperties({ task: { ...APPROVED.tasks[1], done: true }, timeZone: 'UTC' }).hs_task_status, 'COMPLETED');
});

test('no due date: 9:00 on the next business day, in the workspace zone, across a weekend and a DST change', () => {
  assert.equal(nextBusinessDay(new Date('2026-10-02T16:00:00Z'), 'America/New_York'), '2026-10-05', 'Friday → Monday');
  assert.equal(nextBusinessDay(new Date('2026-10-06T16:00:00Z'), 'UTC'), '2026-10-07');
  assert.equal(taskDueAt(null, 'America/New_York', new Date('2026-10-02T16:00:00Z')).toISOString(), '2026-10-05T13:00:00.000Z');
  assert.equal(zonedInstant('2026-11-02', 9, 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z', 'after the clocks go back: EST');
  assert.equal(zonedInstant('2026-10-09', 9, 'Not/AZone').toISOString(), '2026-10-09T09:00:00.000Z', 'an unknown zone reads as UTC');
});

test('the note: one short list of the approved updates, escaped, and who approved it', () => {
  const p = hubspotNoteProperties({ updates: approvedUpdates(card().content, ['u1', 'u2']), meeting: card().meetings[0], approverName: 'Tamsin Rowe', timeZone: 'UTC', now: new Date('2026-10-02T16:00:00Z') });
  assert.match(p.hs_note_body, /<li>Next step: Pilot quote by Friday<\/li><li>Note: Security review &lt;first&gt;<\/li>/);
  assert.doesNotMatch(p.hs_note_body, /not approved/);
  assert.match(p.hs_note_body, /Approved by Tamsin Rowe via Nous/);
  assert.equal(p.hs_timestamp, '2026-10-02T16:00:00.000Z');
});

test('the deals a card is filed on: its own, or both options when the rep said "both"', () => {
  assert.deepEqual(dealEntityIdsOf(card()), [DEAL_A]);
  const both = card({ deal_entity_id: null, content: { attribution: { chosen: 'both', options: [{ id: DEAL_A }, { id: DEAL_B }, { id: 'not-a-uuid' }] } } });
  assert.deepEqual(dealEntityIdsOf(both), [DEAL_A, DEAL_B]);
  assert.deepEqual(dealEntityIdsOf(card({ deal_entity_id: null, content: { attribution: { chosen: 'neither', options: [{ id: DEAL_A }] } } })), []);
});

test('the guard: only task and note creates and task updates are writable; a deal, company or contact never is', () => {
  assert.equal(isWritableHubspotRequest('POST', '/crm/v3/objects/tasks'), true);
  assert.equal(isWritableHubspotRequest('POST', '/crm/v3/objects/notes'), true);
  assert.equal(isWritableHubspotRequest('PATCH', '/crm/v3/objects/tasks/123'), true);
  for (const [m, p] of [['PATCH', '/crm/v3/objects/deals/9001'], ['POST', '/crm/v3/objects/deals'], ['PATCH', '/crm/v3/objects/companies/7001'],
    ['PATCH', '/crm/v3/objects/contacts/5001'], ['PATCH', '/crm/v3/objects/notes/1'], ['DELETE', '/crm/v3/objects/tasks/1'], ['PUT', '/crm/v4/objects/tasks/1/associations/deals/9001']]) {
    assert.equal(isWritableHubspotRequest(m, p), false, `${m} ${p}`);
  }
});

// ── The run ──────────────────────────────────────────────────────────────────

test('a run creates each task and one note, with the association bodies, and persists every id as it lands', async () => {
  const { r, persisted } = await run();
  assert.equal(r.complete, true);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.sync.tasks, { t1: '100', t2: '101' });
  assert.equal(r.sync.note, '102');
  assert.equal(persisted.length, 3, 'one persist per create, so a crash loses nothing');
  assert.deepEqual(persisted[0].tasks, { t1: '100' });

  const posts = writes();
  assert.deepEqual(posts.map((c) => [c.method, new URL(c.url).pathname]), [
    ['POST', '/crm/v3/objects/tasks'], ['POST', '/crm/v3/objects/tasks'], ['POST', '/crm/v3/objects/notes'],
  ]);
  const task = posts[0].body;
  assert.deepEqual(task.associations.map((a) => [a.to.id, a.types[0].associationTypeId]), [['9001', 216], ['7001', 192], ['5001', 204], ['5002', 204]]);
  assert.equal(task.properties.hubspot_owner_id, '42');
  const note = posts[2].body;
  assert.deepEqual(note.associations.map((a) => [a.to.id, a.types[0].associationTypeId]), [['9001', 214], ['7001', 190]]);
  assert.ok(note.properties.hs_note_body);
  assert.equal(calls.filter((c) => c.url.includes('/crm/v3/owners')).length, 1, 'the owner is read once per run');
  assert.match(calls.find((c) => c.url.includes('/owners')).url, /\/crm\/v3\/owners\?email=tamsin%40us\.test/);
});

test('never a deal write: no request touches /objects/deals, and every write is a task or a note', async () => {
  await run();
  assert.equal(calls.some((c) => c.url.includes('/objects/deals')), false);
  for (const c of writes()) assert.equal(isWritableHubspotRequest(c.method, new URL(c.url).pathname), true, c.url);
  for (const c of writes()) {
    const props = Object.keys(c.body?.properties ?? {});
    for (const forbidden of ['dealstage', 'amount', 'closedate', 'pipeline']) assert.ok(!props.includes(forbidden), forbidden);
  }
});

test('idempotent: a second run with the first run\'s ids creates nothing', async () => {
  const first = await run();
  calls = [];
  const second = await run({ card: card({ verdict: { ...card().verdict, sync: first.r.sync } }) });
  assert.equal(second.r.complete, true);
  assert.equal(writes().length, 0, 'nothing created twice');
  assert.equal(calls.length, 0, 'not even the owner read');
  assert.equal(second.persisted.length, 0);
});

test('partial failure keeps the ids that landed; the retry creates only what is missing', async () => {
  respond = (url, init, n) => {
    if (init?.method === 'POST' && JSON.parse(init.body).properties.hs_task_subject === 'Book the infosec review') return json(400, { message: 'Property values were not valid' });
    return defaultRespond(url, init);
  };
  const noContacts = { ...TARGETS, contactIds: [] };
  const first = await run({ targets: noContacts });
  assert.equal(first.r.complete, false);
  assert.deepEqual(first.r.failed.map((f) => [f.kind, f.id, f.error, f.status]), [['task', 't2', 'hubspot_error', 400]]);
  assert.match(first.r.failed[0].message, /not valid/);
  assert.deepEqual(first.r.sync.tasks, { t1: '100' });
  assert.ok(first.r.sync.note, 'the note still went');
  assert.deepEqual(first.persisted.at(-1).tasks, { t1: '100' });

  respond = defaultRespond;
  calls = [];
  const retry = await run({ targets: noContacts, card: card({ verdict: { ...card().verdict, sync: first.persisted.at(-1) } }) });
  assert.equal(retry.r.complete, true);
  assert.deepEqual(writes().map((c) => c.body.properties.hs_task_subject), ['Book the infosec review']);
  assert.equal(retry.r.sync.tasks.t1, '100', 'the first id is kept');
  assert.ok(retry.r.sync.tasks.t2);
});

test('a contact HubSpot no longer has does not cost the task: one retry without the people', async () => {
  respond = (url, init) => {
    if (init?.method === 'POST' && JSON.parse(init.body).associations.some((a) => a.types[0].associationTypeId === 204)) return json(400, { message: 'invalid association' });
    return defaultRespond(url, init);
  };
  const { r } = await run();
  assert.equal(r.complete, true);
  const taskPosts = writes().filter((c) => c.url.endsWith('/tasks'));
  assert.equal(taskPosts.length, 4, 'each task: once with people, once without');
  assert.deepEqual(taskPosts[1].body.associations.map((a) => a.types[0].associationTypeId), [216, 192]);
});

test('403: the plain answer, nothing more attempted, nothing that landed is lost', async () => {
  let n = 0;
  respond = (url, init) => {
    if (init?.method === 'POST' && ++n === 2) return json(403, { category: 'MISSING_SCOPES', message: 'This app hasn\'t been granted all required scopes' });
    return defaultRespond(url, init);
  };
  const { r, persisted } = await run();
  assert.equal(r.error, WRITEBACK_NOT_ALLOWED);
  assert.equal(r.error, 'crm_write_not_allowed');
  assert.equal(r.message, WRITEBACK_NOT_ALLOWED_MESSAGE);
  assert.equal(r.message, 'Grant HubSpot write access (tasks, notes) to sync');
  assert.equal(r.complete, false);
  assert.deepEqual(r.sync.tasks, { t1: '100' }, 'the first task is kept');
  assert.deepEqual(persisted.at(-1).tasks, { t1: '100' });
  assert.equal(writes().length, 2, 'stops at the refusal: no note attempted');
  assert.deepEqual(r.failed.map((f) => [f.kind, f.id, f.error]), [['task', 't2', 'crm_write_not_allowed'], ['note', null, 'crm_write_not_allowed']]);
});

test('401 is the same refusal', async () => {
  respond = (url, init) => (init?.method === 'POST' ? json(401, { message: 'expired' }) : defaultRespond(url, init));
  const { r } = await run();
  assert.equal(r.error, 'crm_write_not_allowed');
  assert.equal(writes().length, 1);
});

test('an account HubSpot does not hold: nothing is sent, every item says why', async () => {
  const { r } = await run({ targets: { dealIds: [], companyId: null, contactIds: [] } });
  assert.equal(calls.length, 0);
  assert.equal(r.complete, false);
  assert.deepEqual(r.failed.map((f) => f.error), ['not_in_hubspot', 'not_in_hubspot', 'not_in_hubspot']);
});

test('no owner in HubSpot for the approver: the next email is tried, then the task goes unowned', async () => {
  respond = (url, init) => (url.includes('/owners') ? json(200, { results: [] }) : defaultRespond(url, init));
  const { r } = await run({ ownerEmails: ['nobody@us.test', null, 'also@us.test'] });
  assert.equal(r.complete, true);
  assert.equal(calls.filter((c) => c.url.includes('/owners')).length, 2);
  assert.ok(!('hubspot_owner_id' in writes()[0].body.properties));
});

test('nothing approved: nothing to do, complete', async () => {
  const { r } = await run({ approved: { tasks: [], updateIds: [] } });
  assert.equal(r.complete, true);
  assert.equal(calls.length, 0);
});

test('the sync map reads defensively', () => {
  assert.deepEqual(readSyncState(null), { tasks: {}, note: null });
  assert.deepEqual(readSyncState({ sync: { tasks: { t1: 5, t2: '', t3: 'x' }, note: 7, draft: { url: 'u' } } }), { tasks: { t1: '5', t3: 'x' }, note: '7', draft: { url: 'u' } });
});

// ── Ticking a task done ─────────────────────────────────────────────────────

const fakeSupabase = (tables) => {
  const inserted = [];
  return {
    inserted,
    from(table) {
      const q = {
        select: () => q, eq: () => q, in: () => q, is: () => q, not: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
        insert: async (row) => { inserted.push({ table, row }); return { error: null }; },
        then: (ok, bad) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok, bad),
      };
      return q;
    },
  };
};

test('a tick closes the HubSpot task Nous created; a reopen reopens it; only the status is sent', async () => {
  const sb = fakeSupabase({ follow_up_settings: { crm_writeback: true } });
  const done = await syncTaskStatusToHubspot({ supabase: sb, workspaceId: 'ws1', hubspotTaskId: '123', done: true, token: 'pat-test' });
  assert.equal(done.ok, true);
  assert.deepEqual(calls.map((c) => [c.method, new URL(c.url).pathname, c.body]), [['PATCH', '/crm/v3/objects/tasks/123', { properties: { hs_task_status: 'COMPLETED' } }]]);
  calls = [];
  await syncTaskStatusToHubspot({ supabase: sb, workspaceId: 'ws1', hubspotTaskId: '123', done: false, token: 'pat-test' });
  assert.deepEqual(calls[0].body, { properties: { hs_task_status: 'NOT_STARTED' } });
  assert.ok(sb.inserted.every((i) => i.table === 'workspace_system_log'));
});

test('write-back off, or no HubSpot id: no request at all', async () => {
  const off = await syncTaskStatusToHubspot({ supabase: fakeSupabase({ follow_up_settings: { crm_writeback: false } }), workspaceId: 'ws1', hubspotTaskId: '123', done: true, token: 'pat-test' });
  assert.equal(off.skipped, 'writeback_off');
  const none = await syncTaskStatusToHubspot({ supabase: fakeSupabase({ follow_up_settings: { crm_writeback: true } }), workspaceId: 'ws1', hubspotTaskId: null, done: true, token: 'pat-test' });
  assert.equal(none.skipped, 'no_hubspot_task');
  const odd = await syncTaskStatusToHubspot({ supabase: fakeSupabase({ follow_up_settings: { crm_writeback: true } }), workspaceId: 'ws1', hubspotTaskId: '../deals/9001', done: true, token: 'pat-test' });
  assert.equal(odd.skipped, 'no_hubspot_task', 'an id that is not a HubSpot id never becomes a path');
  assert.equal(calls.length, 0);
});

test('a refused task update is logged, never thrown', async () => {
  respond = () => json(403, { message: 'MISSING_SCOPES' });
  const sb = fakeSupabase({ follow_up_settings: { crm_writeback: true } });
  const r = await syncTaskStatusToHubspot({ supabase: sb, workspaceId: 'ws1', hubspotTaskId: '123', done: true, token: 'pat-test' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(sb.inserted[0].row.event_type, 'writeback_not_allowed');
});

test('the HubSpot id of a Nous task: on its value, else only a follow-up task is looked up', async () => {
  const sb = fakeSupabase({ observations: [{ value: { hubspot_task_id: '777' } }] });
  assert.equal(await hubspotTaskIdOf(sb, 'ws1', 'e1', 'action_item.x', { hubspot_task_id: 55 }), '55');
  assert.equal(await hubspotTaskIdOf(sb, 'ws1', 'e1', 'action_item.call_1_t1', {}), null, 'not a follow-up task: no read');
  assert.equal(await hubspotTaskIdOf(sb, 'ws1', 'e1', 'action_item.followup_fu_t1', {}), '777', 'the claim has not caught up: the stamp observation answers');
});
