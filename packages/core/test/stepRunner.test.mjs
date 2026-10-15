// The step runner (GET-543): canvas steps run in order after the AI step. "Only if" stops quietly,
// an approval holds every send behind it as a draft in Priorities, Gmail makes a real draft in the
// owner's mailbox (never sends), Slack posts through the registered handler, and a step that does
// not run yet stops the run there rather than letting later steps run out of order.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/stepRunner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStepsForTest as runSteps, rulesPass, registerStepHandler } from '../dist/services/automationRun.mjs';
import { isAutomationHubspotWrite } from '../dist/services/hubspotAutomation.js';

const doc = { id: 'd1', title: 'Acme — call ended', headline: 'h', sections: [{ heading: 'What happened', body: 'They want SSO.' }] };

function fakeDb() {
  const inserted = [];
  const db = {
    inserted,
    from(table) {
      let row = null;
      const q = {
        select: () => q, eq: () => q, in: () => q, is: () => q, order: () => q, limit: () => q, update: () => q, upsert: (r) => { row = r; return q; },
        insert: (r) => { row = { id: `${table}-${inserted.length + 1}`, ...r }; inserted.push({ table, row }); return q; },
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (ok) => Promise.resolve({ data: row ? [row] : [], error: null }).then(ok),
      };
      return q;
    },
  };
  return db;
}
const auto = (steps, extra = {}) => ({ id: 'r1', name: 'Follow-up after every call', user_id: 'u1', steps, ...extra });
const ctxOf = (db, extra = {}) => ({ supabase: db, workspaceId: 'ws', entityId: null, call: { title: 'Pricing review' }, ...extra });

test('only-if rules: is, contains, set, numbers, any and all', () => {
  const v = { 'account.tier': 'A', 'deal.amount': '$12,000', 'account.owner': '' };
  assert.equal(rulesPass({ rules: [{ field: 'account.tier', op: 'is', value: 'a' }] }, v), true);
  assert.equal(rulesPass({ rules: [{ field: 'deal.amount', op: 'gt', value: '10000' }] }, v), true);
  assert.equal(rulesPass({ rules: [{ field: 'account.owner', op: 'set', value: '' }] }, v), false);
  assert.equal(rulesPass({ match: 'any', rules: [{ field: 'account.owner', op: 'set' }, { field: 'account.tier', op: 'is', value: 'A' }] }, v), true);
  assert.equal(rulesPass({ rules: [{ field: 'account.owner', op: 'set' }, { field: 'account.tier', op: 'is', value: 'A' }] }, v), false);
});

test('an only-if miss ends the run before anything is sent', async () => {
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  const db = fakeDb();
  const r = await runSteps(auto([
    { id: 'a', type: 'agent', config: {} },
    { id: 'c', type: 'only_if', config: { rules: [{ field: 'account.tier', op: 'is', value: 'A' }] } },
    { id: 's', type: 'slack', config: { channel: '#sales', text: 'hi' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(db) });
  assert.equal(r.reason, 'condition_not_met');
  assert.equal(posted, 0);
});

test('Gmail makes a real draft in the owner\'s mailbox and never sends', async () => {
  const calls = [];
  registerStepHandler('gmail_draft', async (a) => { calls.push(a); return { status: 'created', mailbox: 'theo@opennous.example' }; });
  const db = fakeDb();
  const r = await runSteps(auto([
    { id: 'a', type: 'agent', config: {} },
    { id: 'g', type: 'gmail', config: { mode: 'draft', to: 'sarah@acme.example', subject: 'After {{call.title}}', body: '' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(db) });
  assert.equal(r.delivered, 'gmail_draft:theo@opennous.example');
  assert.equal(calls[0].userId, 'u1');
  assert.equal(calls[0].to, 'sarah@acme.example');
  assert.equal(calls[0].subject, 'After Pricing review');
  assert.match(calls[0].body, /They want SSO/);   // an empty body falls back to what the AI step wrote
  assert.equal(db.inserted.filter(i => i.table === 'pending_actions').length, 0);
});

test('no Gmail connected: the draft waits in Priorities instead, labelled with the automation', async () => {
  registerStepHandler('gmail_draft', async () => ({ status: 'no_gmail' }));
  const db = fakeDb();
  const r = await runSteps(auto([{ id: 'g', type: 'gmail', config: { to: 'sarah@acme.example', subject: 'Hi', body: 'Hello' } }]), doc, { stage: 'call_ended', ctx: ctxOf(db) });
  assert.equal(r.delivered, 'draft:to_approve');
  const draft = db.inserted.find(i => i.table === 'pending_actions').row;
  assert.equal(draft.kind, 'email');
  assert.equal(draft.recipient_email, 'sarah@acme.example');
  assert.equal(draft.rationale, 'After the call: Pricing review');
  const decision = db.inserted.find(i => i.table === 'ri_decisions')?.row;
  if (decision) assert.equal(decision.payload?.automation_name, 'Follow-up after every call');
});

test('after an approval step the run pauses with a preview; approving resumes at that step', async () => {
  let drafted = 0;
  registerStepHandler('gmail_draft', async () => { drafted++; return { status: 'created' }; });
  const steps = [
    { id: 'a', type: 'agent', config: {} },
    { id: 'p', type: 'approval', config: {} },
    { id: 'g', type: 'gmail', config: { to: 'sarah@acme.example', subject: 'Hi {{call.title}}', body: 'Hello' } },
  ];
  const ctx = ctxOf(fakeDb());
  const r = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx });
  assert.equal(r.paused, true);
  assert.equal(r.index, 2);
  assert.equal(r.preview.step, 'Step 3 · Gmail');
  assert.deepEqual(r.preview.rows.map(x => [x.label, x.value]), [['To', 'sarah@acme.example'], ['Subject', 'Hi Pricing review'], ['Body', 'Hello']]);
  assert.equal(drafted, 0);
  const done = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx }, { startAt: r.index, approvedIndex: r.index });
  assert.equal(done.delivered, 'gmail_draft');
  assert.equal(drafted, 1);
});

test('a step\'s own Require approval switch pauses just that step', async () => {
  const seen = [];
  registerStepHandler('slack', async (a) => { seen.push(a); return { ok: true }; });
  const r = await runSteps(auto([
    { id: 's1', type: 'slack', config: { channel: '#a', text: 'first' } },
    { id: 's2', type: 'slack', config: { channel: '#b', text: 'second', approval: true } },
  ]), doc, { stage: 'x', ctx: ctxOf(fakeDb()) });
  assert.equal(r.paused, true);
  assert.equal(r.index, 1);
  assert.equal(seen.length, 1);           // the first ran, the second waits
  assert.equal(r.preview.rows.find(x => x.label === 'Channel').value, '#b');
});

test('Slack posts the filled message through the registered handler', async () => {
  const seen = [];
  registerStepHandler('slack', async (a) => { seen.push(a); return { ok: true }; });
  const r = await runSteps(auto([{ id: 's', type: 'slack', config: { channel: '#sales', text: 'Call done: {{call.title}}' } }]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(r.delivered, 'slack:#sales');
  assert.equal(seen[0].text, 'Call done: Pricing review');
  assert.equal(seen[0].channel, '#sales');
});

test('a step that does not run yet stops the run there; nothing after it runs', async () => {
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  const r = await runSteps(auto([
    { id: 'w', type: 'wait', config: { mode: 'duration', amount: 1, unit: 'days' } },
    { id: 's', type: 'slack', config: { channel: '#sales', text: 'hi' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(r.reason, 'wait_not_running_yet');
  assert.equal(posted, 0);
});

test('HubSpot with nothing connected stops the run and says why; nothing after it runs', async () => {
  let posted = 0;
  registerStepHandler('slack', async () => { posted++; return { ok: true }; });
  const r = await runSteps(auto([
    { id: 'h', type: 'hubspot', config: { action: 'note', body: 'x' } },
    { id: 's', type: 'slack', config: { channel: '#sales', text: 'hi' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(r.reason, 'hubspot_not_connected');
  assert.equal(posted, 0);
});

test('the HubSpot writer may only create notes and tasks and update deals, contacts and companies', () => {
  assert.equal(isAutomationHubspotWrite('POST', '/crm/v3/objects/notes'), true);
  assert.equal(isAutomationHubspotWrite('POST', '/crm/v3/objects/tasks'), true);
  assert.equal(isAutomationHubspotWrite('PATCH', '/crm/v3/objects/deals/123'), true);
  assert.equal(isAutomationHubspotWrite('PATCH', '/crm/v3/objects/companies/9'), true);
  assert.equal(isAutomationHubspotWrite('DELETE', '/crm/v3/objects/deals/123'), false);
  assert.equal(isAutomationHubspotWrite('POST', '/crm/v3/objects/deals'), false);
  assert.equal(isAutomationHubspotWrite('PATCH', '/crm/v3/owners/1'), false);
});

test('OpenNous Draft follow-up always waits for approval, then drafts in Gmail to the people on the call (GET-739)', async () => {
  const calls = [];
  registerStepHandler('gmail_draft', async (a) => { calls.push(a); return { status: 'created' }; });
  const ctx = ctxOf(fakeDb(), { call: { title: 'Pricing review', attendees: [{ email: 'sarah@acme.example' }, { email: 'tom@acme.example' }] } });
  // No approval switch on the step, and still it waits.
  const steps = [{ id: 'a', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', extra: 'Keep it short' } }];
  const waiting = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx });
  assert.equal(waiting.paused, true);
  assert.equal(calls.length, 0);
  const r = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx }, { startAt: waiting.index, decisions: { [waiting.index]: { approve: true } } });
  assert.equal(r.delivered, 'gmail_draft');
  assert.equal(calls[0].to, 'sarah@acme.example, tom@acme.example');
  assert.equal(calls[0].subject, 'Following up: Pricing review');
  assert.match(calls[0].body, /They want SSO/);
});

test('Draft follow-up does not draft twice when the flow has its own Gmail step, or when switched off', async () => {
  const calls = [];
  registerStepHandler('gmail_draft', async (a) => { calls.push(a); return { status: 'created' }; });
  await runSteps(auto([
    { id: 'a', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous' } },
    { id: 'g', type: 'gmail', config: { to: 'sarah@acme.example', subject: 'Hi', body: '' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(calls.length, 1);
  const off = await runSteps(auto([{ id: 'a', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', draft_in: 'none' } }]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(off.delivered, null);
  assert.equal(calls.length, 1);
});

test('a failed step is named in words: which step, what it was, and why', async () => {
  const { describeStop } = await import('../dist/services/automationRun.mjs');
  assert.equal(describeStop({ type: 'hubspot', config: { action: 'update_deal' } }, 2, 'hubspot_no_deal'),
    'Step 3 · HubSpot · Update the deal: no open deal on this account in HubSpot');
  const r = await runSteps(auto([
    { id: 'a', type: 'agent', config: {} },
    { id: 'h', type: 'hubspot', config: { action: 'note' } },
  ]), doc, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.equal(r.failed, true);
  assert.equal(r.message, "Step 2 · HubSpot · Add a note: HubSpot isn't connected");
});

test('an only-if stop is not a failure', async () => {
  const r = await runSteps(auto([{ id: 'c', type: 'only_if', config: { rules: [{ field: 'account.tier', op: 'is', value: 'A' }] } }]), doc, { stage: 'x', ctx: ctxOf(fakeDb()) });
  assert.equal(r.failed, false);
  assert.match(r.message, /^Step 1 · Only if: the rules didn't match/);
});

test('a call\'s next steps fill {{call.next_step}} and {{call.next_steps}}, ours only', async () => {
  const { templateVarsForTest } = await import('../dist/services/automationRun.mjs');
  const call = { title: 'Pricing review', nextSteps: [{ title: 'Send the SOC 2 report' }, { title: 'They send the DMS login', theirs: true }, { title: 'Book the pilot kickoff' }] };
  const v = await templateVarsForTest({ steps: [] }, { title: 'x' }, { ctx: { call } });
  assert.equal(v['call.next_step'], 'Send the SOC 2 report');
  assert.equal(v['call.next_steps'], '- Send the SOC 2 report\n- Book the pilot kickoff');
});

test('HubSpot tasks from a call with no next steps writes nothing and is not a failure', async () => {
  const r = await runSteps(auto([{ id: 'h', type: 'hubspot', config: { action: 'task' } }]), doc,
    { stage: 'call_ended', ctx: ctxOf(fakeDb(), { call: { title: 'x', nextSteps: [] } }) });
  assert.equal(r.failed, undefined);
  assert.equal(r.delivered, 'hubspot_task:no_next_steps');
});

test('an email from an SMTP mailbox always waits for approval, then sends from that mailbox', async () => {
  const sent = [];
  registerStepHandler('smtp_send', async (a) => { sent.push(a); return { ok: true, from: 'theo@opennous.example' }; });
  const steps = [
    { id: 'a', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', send_from: { id: 'conn-smtp', kind: 'smtp', email: 'theo@opennous.example' } } },
  ];
  const ctx = ctxOf(fakeDb(), { call: { title: 'Pricing review', attendees: [{ email: 'sarah@acme.example' }] } });
  const r = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx });
  assert.equal(r.paused, true);
  assert.equal(r.preview.rows[0].value, 'theo@opennous.example');   // From
  assert.equal(sent.length, 0);
  const done = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx }, { startAt: r.index, approvedIndex: r.index });
  assert.equal(done.delivered, 'smtp_sent:theo@opennous.example');
  assert.equal(sent[0].connectionId, 'conn-smtp');
  assert.equal(sent[0].to, 'sarah@acme.example');
});

test('a run logs each step in words: what it wrote, what it did, where it failed', async () => {
  registerStepHandler('slack', async () => ({ ok: true }));
  const r = await runSteps(auto([
    { id: 'a', type: 'agent', config: {} },
    { id: 's', type: 'slack', config: { channel: '#sales', text: 'hi' } },
    { id: 'h', type: 'hubspot', config: { action: 'note', body: 'x' } },
  ]), { ...doc, id: 'doc-1' }, { stage: 'call_ended', ctx: ctxOf(fakeDb()) });
  assert.deepEqual(r.log.map(x => [x.step, x.name, x.status]), [[1, 'Agent · Write-up', 'ok'], [2, 'Slack', 'ok'], [3, 'HubSpot · Add a note', 'failed']]);
  assert.equal(r.log[0].document_id, 'doc-1');
  assert.equal(r.log[1].detail, 'Posted to #sales');
  assert.equal(r.log[2].detail, "HubSpot isn't connected");
});


test('one review holds the email and the tasks together; each task is decided on its own', async () => {
  const drafted = [];
  registerStepHandler('gmail_draft', async (a) => { drafted.push(a); return { status: 'created' }; });
  const steps = [
    { id: 'f', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', approval: true } },
    { id: 'h', type: 'hubspot', config: { action: 'task', task_from: 'call', approval: true } },
  ];
  const call = { title: 'Pricing review', attendees: [{ email: 'sarah@acme.example' }],
    nextSteps: [{ title: 'Send SOC 2' }, { title: 'Book kickoff' }, { title: 'Share pricing' }] };
  const ctx = ctxOf(fakeDb(), { call });
  const r = await runSteps(auto(steps), { ...doc, sections: [{ label: 'Email', body: 'Hi Sarah' }], headline: 'Recap' }, { stage: 'call_ended', ctx });
  assert.equal(r.paused, true);
  assert.deepEqual(r.bundle.map(b => b.step), ['Step 1 · Draft follow-up · Gmail', 'Step 2 · HubSpot · Create a task']);
  assert.equal(r.bundle[0].email.to, 'sarah@acme.example');
  assert.deepEqual(r.bundle[1].tasks.map(t => t.title), ['Send SOC 2', 'Book kickoff', 'Share pricing']);
  assert.equal(drafted.length, 0);

  // Approve the email; of the tasks only the first and the third (HubSpot not connected here, so it
  // stops on the write, which proves the email ran first and the tasks were reached).
  const decisions = { [r.bundle[0].index]: { approve: true }, [r.bundle[1].index]: { approve: true, tasks: [0, 2] } };
  const done = await runSteps(auto(steps), { ...doc, sections: [{ label: 'Email', body: 'Hi Sarah' }], headline: 'Recap' }, { stage: 'call_ended', ctx }, { startAt: r.index, decisions });
  assert.equal(drafted.length, 1);
  assert.equal(drafted[0].subject, 'Recap');
  assert.equal(done.reason, 'hubspot_not_connected');
});

test('a step skipped in review does nothing and the run goes on', async () => {
  const drafted = [];
  registerStepHandler('gmail_draft', async (a) => { drafted.push(a); return { status: 'created' }; });
  const steps = [
    { id: 'f', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', approval: true } },
  ];
  const ctx = ctxOf(fakeDb(), { call: { title: 'x', attendees: [{ email: 'a@b.example' }] } });
  const r = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx });
  const done = await runSteps(auto(steps), doc, { stage: 'call_ended', ctx }, { startAt: r.index, decisions: { [r.index]: { approve: false } } });
  assert.equal(drafted.length, 0);
  assert.equal(done.log.find(x => x.status === 'skipped')?.detail, 'Skipped in review');
});

test('OpenNous steps are named by their action', async () => {
  const { describeStop } = await import('../dist/services/automationRun.mjs');
  assert.match(describeStop({ type: 'agent', config: { mode: 'pick', job: 'call_summary' } }, 0, 'x'), /^Step 1 · OpenNous · Call summary/);
});

test('the reviewer\'s edits are what goes out; Send sends from the same Gmail instead of drafting', async () => {
  const drafted = []; const sent = [];
  registerStepHandler('gmail_draft', async (a) => { drafted.push(a); return { status: 'created', id: 'd1', mailbox: 'me@x.example' }; });
  registerStepHandler('gmail_send', async (a) => { sent.push(a); return { status: 'sent', mailbox: 'me@x.example' }; });
  const steps = [{ id: 'f', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous', approval: true } }];
  const ctx = ctxOf(fakeDb(), { call: { title: 'x', attendees: [{ email: 'a@b.example' }] } });
  const d = { ...doc, sections: [{ label: 'Email', body: 'Hi' }], headline: 'Recap' };
  const r = await runSteps(auto(steps), d, { stage: 'call_ended', ctx });
  const email = { to: 'a@b.example', cc: 'c@b.example', subject: 'Shorter', body: 'Hi A, two lines.', send: true };
  const done = await runSteps(auto(steps), d, { stage: 'call_ended', ctx }, { startAt: r.index, decisions: { [r.index]: { approve: true, email } } });
  assert.equal(drafted.length, 0);
  assert.deepEqual([sent[0].to, sent[0].cc, sent[0].subject, sent[0].body], ['a@b.example', 'c@b.example', 'Shorter', 'Hi A, two lines.']);
  assert.equal(done.delivered, 'gmail_sent:me@x.example');
  assert.equal(done.log.at(-1).mail.kind, 'sent');

  // Save as draft: the edits, drafted, and the draft's id kept for a later Send.
  const r2 = await runSteps(auto(steps), d, { stage: 'call_ended', ctx });
  const kept = await runSteps(auto(steps), d, { stage: 'call_ended', ctx }, { startAt: r2.index, decisions: { [r2.index]: { approve: true, email: { ...email, send: false } } } });
  assert.equal(drafted[0].subject, 'Shorter');
  assert.equal(kept.log.at(-1).mail.draft_id, 'd1');
});

test('sending a drafted email from the review replaces the draft and marks the step sent', async () => {
  const { sendRunEmail } = await import('../dist/services/automationRun.mjs');
  const sent = []; const removed = [];
  registerStepHandler('gmail_send', async (a) => { sent.push(a); return { status: 'sent', mailbox: 'me@x.example' }; });
  registerStepHandler('gmail_delete_draft', async (a) => { removed.push(a.draftId); return { status: 'deleted' }; });
  let saved = null;
  const run = { id: 'run1', routine_id: 'r1', step_log: [{ step: 1, name: 'OpenNous · Draft follow-up', status: 'ok', detail: 'Wrote the email · Draft in Gmail (me@x.example)', mail: { kind: 'draft', draft_id: 'd9', connection_id: 'c1', user_id: 'u1' } }] };
  const db = { from: (t) => {
    const q = { select: () => q, eq: () => q, update: (r) => { saved = r; return q; },
      maybeSingle: async () => ({ data: t === 'agent_routine_runs' ? run : { user_id: 'u1' } }), then: (ok) => Promise.resolve({ data: null }).then(ok) };
    return q;
  } };
  const out = await sendRunEmail(db, 'ws', 'run1', { step: 1, to: 'a@b.example', cc: '', subject: 'S', body: 'B' });
  assert.equal(out.ok, true);
  assert.equal(sent[0].connectionId, 'c1');
  assert.deepEqual(removed, ['d9']);
  assert.equal(saved.step_log[0].mail.kind, 'sent');
  assert.equal(saved.step_log[0].detail, 'Wrote the email · Sent from Gmail (me@x.example)');
  const again = await sendRunEmail({ from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { ...run, step_log: saved.step_log } }) }) }, 'ws', 'run1', { step: 1, to: 'a@b.example', subject: 'S', body: 'B' });
  assert.equal(again.error, 'already_sent');
});

test('the mailbox picked in review is the one it goes out from (GET-745)', async () => {
  const sent = [];
  registerStepHandler('gmail_send', async (a) => { sent.push(a); return { status: 'sent', mailbox: 'b@x.example' }; });
  const steps = [{ id: 'f', type: 'agent', config: { mode: 'pick', job: 'follow_up', model: 'opennous' } }];
  const ctx = ctxOf(fakeDb(), { call: { title: 'x', attendees: [{ email: 'a@b.example' }] } });
  const d = { ...doc, sections: [{ label: 'Email', body: 'Hi' }], headline: 'Recap' };
  const r = await runSteps(auto(steps), d, { stage: 'call_ended', ctx });
  await runSteps(auto(steps), d, { stage: 'call_ended', ctx }, { startAt: r.index, decisions: { [r.index]: { approve: true, email: { send: true, from: 'conn-2' } } } });
  assert.equal(sent[0].connectionId, 'conn-2');
});

test('Slack posts to the picked channel by id, or as a direct message to a person (GET-771)', async () => {
  const posts = [];
  registerStepHandler('slack', async (a) => { posts.push(a); return { ok: true }; });
  const ctx = ctxOf(fakeDb());
  const ch = await runSteps(auto([{ id: 's', type: 'slack', config: { channel: 'sales', channel_id: 'C123', text: '' } }]), doc, { stage: 'x', ctx });
  assert.equal(posts[0].channelId, 'C123');
  assert.equal(posts[0].userId, null);
  assert.equal(ch.delivered, 'slack:#sales');
  const d = await runSteps(auto([{ id: 's', type: 'slack', config: { action: 'dm', user_id: 'U9', user_name: 'Sam', channel_id: 'C123' } }]), doc, { stage: 'x', ctx });
  assert.deepEqual([posts[1].userId, posts[1].channelId], ['U9', null]);
  assert.equal(d.delivered, 'slack:Sam');
});

test('a Slack failure says what to do in words', async () => {
  registerStepHandler('slack', async () => ({ ok: false, reason: 'slack_not_in_channel' }));
  const r = await runSteps(auto([{ id: 's', type: 'slack', config: { channel: 'general', channel_id: 'C1' } }]), doc, { stage: 'x', ctx: ctxOf(fakeDb()) });
  assert.match(r.message, /\/invite @Nous in it$/);
});

test('a Slack channel it cannot see says to invite the app when the channel is private (GET-879)', async () => {
  registerStepHandler('slack', async () => ({ ok: false, reason: 'slack_channel_not_found' }));
  const r = await runSteps(auto([{ id: 's', type: 'slack', config: { channel: 'deals-private', channel_id: 'C1' } }]), doc, { stage: 'x', ctx: ctxOf(fakeDb()) });
  assert.equal(r.failed, true);
  assert.match(r.message, /Slack: Slack can't see that channel\. If it's private, invite the Nous app: type \/invite @Nous in the channel$/);
  assert.match(r.log.at(-1).detail, /^Slack can't see that channel/);
});

test('a Read step with HubSpot not connected stops and says so; a Read step never waits for approval (GET-773)', async () => {
  const r = await runSteps(auto([
    { id: 'r', type: 'hubspot', config: { action: 'read', object: '2-1', fields: ['x'], approval: true } },
    { id: 's', type: 'slack', config: { channel_id: 'C1', channel: 'reports' } },
  ]), null, { stage: 'scheduled', ctx: { ...ctxOf(fakeDb()), writeAllInLoop: true } });
  assert.equal(r.paused, undefined);
  assert.equal(r.reason, 'hubspot_not_connected');
  assert.match(r.message, /Read records/);
});

test('an AI step with no model answer passes the data on and says so; a switched-off input is left out (GET-788)', async () => {
  const posts = [];
  registerStepHandler('slack', async (a) => { posts.push(a.text); return { ok: true }; });
  const steps = (off) => auto([
    { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.', ...(off ? { inputs_off: ['r'] } : {}) } },
    { id: 's', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.summary.output}}' } },
  ]);
  const ctx = () => ({ ...ctxOf(fakeDb()), writeAllInLoop: true, seedData: [{ id: 'r', step: 1, label: 'Stats', text: 'Acme Corp | 7' }] });
  // No model is reachable in tests, so the writer has no answer.
  const on = await runSteps(steps(false), null, { stage: 'scheduled', ctx: ctx() });
  assert.equal(posts[0], 'Acme Corp | 7');
  assert.match(on.log.find(x => x.id === 'summary').detail, /No answer from the AI/);
  await runSteps(steps(true), null, { stage: 'scheduled', ctx: ctx() });
  assert.equal(posts[1], 'Nothing to report.');
});

test('what an AI step writes from data reaches the step after it, not the raw data (GET-788)', async () => {
  const { registerAnthropicClient } = await import('../dist/llm/modelDoor.mjs');
  const before = process.env.WRITING_MODEL;
  process.env.WRITING_MODEL = 'claude-haiku-4-5-20251001';
  registerAnthropicClient({ messages: { create: async () => ({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Acme Corp led with 7.' }] }) } }, { acceptsFeature: false });
  const posts = [];
  registerStepHandler('slack', async (a) => { posts.push(a.text); return { ok: true }; });
  try {
    const db = fakeDb();
    const r = await runSteps(auto([
      { id: 'summary', type: 'agent', config: { prompt: 'Summarise it.' } },
      { id: 's', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.summary.output}}' } },
    ]), null, { stage: 'scheduled', ctx: { ...ctxOf(db), writeAllInLoop: true, seedData: [{ id: 'r', step: 1, label: 'Stats', text: 'Acme Corp | 7' }] } });
    assert.equal(posts[0], 'Acme Corp led with 7.');
    assert.match(r.log.find(x => x.id === 'summary').detail, /^Wrote/);
    // The saved document keeps the summary too (a section with no heading is dropped on save).
    assert.deepEqual(db.inserted.find(x => x.table === 'documents').row.sections.map(x => x.body), ['Acme Corp led with 7.']);
  } finally {
    if (before === undefined) delete process.env.WRITING_MODEL; else process.env.WRITING_MODEL = before;
    registerAnthropicClient(null);
  }
});

test('a document keeps a section with text and no heading, under "Summary" (GET-788)', async () => {
  const { writeDocument } = await import('../dist/db/documents.js');
  const db = fakeDb();
  await writeDocument(db, 'ws', { kind: 'account_summary', title: 'Daily', headline: null, subjectEntityId: null, sections: [{ label: '', body: 'One plain paragraph.' }, { label: '', body: '' }], sources: [], writtenBy: 'automation' });
  assert.deepEqual(db.inserted.find(x => x.table === 'documents').row.sections.map(x => [x.label, x.body]), [['Summary', 'One plain paragraph.']]);
});

test('an AI step reads only the context chosen for it, an earlier AI step included, and writes for Slack when Slack posts it (GET-791)', async () => {
  const { registerAnthropicClient } = await import('../dist/llm/modelDoor.mjs');
  const before = process.env.WRITING_MODEL;
  process.env.WRITING_MODEL = 'claude-haiku-4-5-20251001';
  const asks = [];
  registerAnthropicClient({ messages: { create: async (a) => { asks.push(a); return { model: 'm', stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: `Answer ${asks.length}.` }] }; } } }, { acceptsFeature: false });
  registerStepHandler('slack', async () => ({ ok: true }));
  try {
    await runSteps(auto([
      { id: 'a1', type: 'agent', config: { prompt: 'First.' } },
      { id: 'a2', type: 'agent', config: { prompt: 'Second.', inputs: ['a1'] } },
      { id: 's', type: 'slack', config: { channel_id: 'C1', channel: 'reports', text: '{{steps.a2.output}}' } },
    ]), null, { stage: 'scheduled', ctx: { ...ctxOf(fakeDb()), writeAllInLoop: true, seedData: [{ id: 'r', step: 1, label: 'Stats', text: 'Acme Corp | 7' }] } });
    const material = (a) => a.messages[0].content;
    assert.match(material(asks[0]), /Acme Corp \| 7/);
    assert.match(material(asks[1]), /Answer 1\./);
    assert.doesNotMatch(material(asks[1]), /Acme Corp/, 'the Read data was not chosen for step 2');
    const sys = (a) => (typeof a.system === 'string' ? a.system : JSON.stringify(a.system));
    assert.doesNotMatch(sys(asks[0]), /posted in Slack/);
    assert.match(sys(asks[1]), /posted in Slack/);
  } finally {
    if (before === undefined) delete process.env.WRITING_MODEL; else process.env.WRITING_MODEL = before;
    registerAnthropicClient(null);
  }
});
