// The sync files history with zero model calls, and what it files can still be read (GET-1087).
//
// Run: node --test apps/worker/tests/syncOnly.test.mjs
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMessage, registerAnthropicClient, withSyncOnly, isSyncOnly, SyncOnlyModelCall } from '@nous/core';
import { fakeDb } from './fakeDb.mjs';
import { classifyReplySignal } from '../src/signals/replySentiment.mjs';
import { extractMeetingSignals, extractAfterActivity } from '../src/signals/index.mjs';
import { scoreCall } from '../src/signals/callScore.mjs';
import { summarizeInternalMeeting } from '../src/signals/meetingSummary.mjs';
import { filedUnreadMeeting } from '../src/utils/activity.mjs';
import { runSyncJob } from '../src/workers/contactEnrichmentJobs.mjs';

let modelCalls = 0;
before(() => {
  process.env.ANTHROPIC_API_KEY ??= 'test';
  registerAnthropicClient({ messages: { create: async () => {
    modelCalls++;
    return { content: [{ type: 'text', text: '[]' }], usage: {}, stop_reason: 'end_turn' };
  } } });
});
beforeEach(() => { modelCalls = 0; });

const WS = '00000000-0000-4000-8000-000000000001';
const transcript = 'Mara: we are comparing two vendors this quarter and the budget sits with finance. '.repeat(10);

test('the door refuses a model call inside a sync, and counts it', async () => {
  const store = {};
  await withSyncOnly(store, async () => {
    assert.equal(isSyncOnly(), true);
    await assert.rejects(createMessage({ feature: 'x', max_tokens: 1, messages: [] }), SyncOnlyModelCall);
  });
  assert.equal(isSyncOnly(), false);
  assert.equal(modelCalls, 0);
});

test('a sync survives the handlers firing work off without waiting for it', async () => {
  const store = {};
  await withSyncOnly(store, async () => {
    await new Promise((done) => setImmediate(() => { assert.equal(isSyncOnly(), true); done(); }));
  });
});

test('every reading entry point stops before the door in a sync', async () => {
  const db = fakeDb();
  const store = {};
  await withSyncOnly(store, async () => {
    assert.equal(await classifyReplySignal('Thanks, that works for us', db, WS), null);
    assert.equal(await classifyReplySignal('please unsubscribe me from this list', db, WS), 'unsubscribe', 'opt-outs stay deterministic');
    assert.deepEqual(await extractMeetingSignals({ supabase: db, workspaceId: WS, participants: [{ contactId: 'c1', name: 'Mara' }], summary: transcript, source: 'fathom', sourceRef: 'source://fathom/1' }), []);
    await extractAfterActivity(db, { id: 'o1' }, { contactId: 'c1', workspaceId: WS, type: 'email_received', source: 'instantly', summary: transcript });
    assert.equal(await scoreCall({ supabase: db, workspaceId: WS, transcript, meetingId: '1' }), null);
    assert.equal(await summarizeInternalMeeting({ supabase: db, workspaceId: WS, transcript, title: 'Sync', sourceRef: 'source://fathom/2', subjectEntityId: 'c1' }), false);
    await new Promise((r) => setImmediate(r));
  });
  assert.deepEqual(store.refused ?? [], [], 'nothing had to be refused');
  assert.equal(modelCalls, 0);
});

test('a meeting a sync filed is found again by a replay, and only while unread', async () => {
  const row = { id: 'obs1', workspace_id: WS, source: 'fathom', external_id: 'fathom_m1_c1', property: 'interaction.meeting_held' };
  const db = fakeDb({ observations: [row], claims: [] });
  const ask = { workspaceId: WS, source: 'fathom', externalId: 'fathom_m1_c1', sourceRef: 'source://fathom/m1', replay: true };
  assert.equal((await filedUnreadMeeting(db, ask))?.id, 'obs1', 'unread and replayed: back in the room');
  assert.equal(await filedUnreadMeeting(db, { ...ask, replay: false }), null, 'a live redelivery keeps its dedup');
  await withSyncOnly({}, async () => assert.equal(await filedUnreadMeeting(db, ask), null, 'a sync re-run reads nothing'));
  db.tables.observations.push({ id: 'stamp', workspace_id: WS, external_id: 'read_source://fathom/m1' });
  assert.equal(await filedUnreadMeeting(db, ask), null, 'a meeting already read is not read twice');
});

test('after a sync, the extractor really does read the meeting on replay', async () => {
  const db = fakeDb({
    observations: [], claims: [],
    contacts: [{ id: 'c1', workspace_id: WS, first_name: 'Mara', last_name: 'Velde', company: 'Harborline' }],
    entities: [{ id: 'c1', workspace_id: WS, type: 'person', status: 'active' }],
  });
  const meeting = { supabase: db, workspaceId: WS, participants: [{ contactId: 'c1', name: 'Mara', activityId: 'obs1' }], summary: transcript, source: 'fathom', sourceRef: 'source://fathom/m2', insights: false };
  await withSyncOnly({}, () => extractMeetingSignals({ ...meeting, onceOnly: true }));
  assert.equal(modelCalls, 0, 'the sync read nothing');
  await extractMeetingSignals({ ...meeting, onceOnly: true }).catch(() => {});
  assert.ok(modelCalls > 0, 'the same meeting reaches the model on a later backfill');
});

test('end to end: Fathom files in a sync with no model, and the replay reads the same meeting', async () => {
  const { reprocessFathom } = await import('../src/webhooks/handlers/fathom.mjs');
  const db = fakeDb({
    observations: [], claims: [], documents: [],
    entities: [{ id: 'c1', workspace_id: WS, type: 'person', status: 'active' }],
    entity_identifiers: [{ entity_id: 'c1', workspace_id: WS, kind: 'email', status: 'active', value: 'mara@harborline.example' }],
    contacts: [{ id: 'c1', workspace_id: WS, email: 'mara@harborline.example', first_name: 'Mara', last_name: 'Velde', company: 'Harborline', company_id: null }],
  });
  // The unique index on (workspace, source, external_id): the second filing is a dedup, as in Postgres.
  const from = db.from;
  db.from = (t) => {
    const q = from(t);
    if (t !== 'observations') return q;
    const insert = q.insert;
    q.insert = (row) => {
      if (db.tables.observations?.some((o) => row.external_id && o.external_id === row.external_id && o.source === row.source)) {
        q.select = () => q; q.single = () => Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } });
        return q;
      }
      return insert(row);
    };
    return q;
  };
  const meeting = {
    recording_id: 'rec1', title: 'Harborline pilot', recording_start_time: new Date(Date.now() - 40 * 86400_000).toISOString(),
    calendar_invitees: [{ email: 'mara@harborline.example', name: 'Mara Velde', is_external: true }],
    transcript: [{ speaker: { display_name: 'Mara Velde' }, text: transcript }],
  };
  const store = {};
  const first = await withSyncOnly(store, () => reprocessFathom(db, WS, meeting, { onceOnly: true }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(first.logged, 1, 'the meeting landed');
  assert.deepEqual(store.refused, [], 'nothing even tried the door');
  assert.equal(modelCalls, 0);

  const second = await reprocessFathom(db, WS, meeting, { onceOnly: true });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(second.logged, 0, 'the timeline row dedups');
  assert.ok(modelCalls > 0, 'and the meeting is read anyway');
});

test('a synced email is still due for the thread reader', async () => {
  const { threadsToRead } = await import('../src/workers/emailThreadsDaily.mjs');
  const { ingestGmail } = await import('../src/webhooks/handlers/composio.mjs');
  const db = fakeDb({
    observations: [], claims: [], entities: [{ id: 'c1', workspace_id: WS, type: 'person', status: 'active' }],
    entity_identifiers: [{ entity_id: 'c1', workspace_id: WS, kind: 'email', status: 'active', value: 'mara@harborline.example' }],
    contacts: [{ id: 'c1', workspace_id: WS, company_id: null }],
  });
  const conn = { workspace_id: WS, owner_user_id: 'u1', account_email: 'ines@fernpoint.example' };
  const at = new Date(Date.now() - 2 * 86400_000).toISOString();
  const logged = await withSyncOnly({}, () => ingestGmail(db, conn, {
    id: 'm1', thread_id: 't1', subject: 'Re: pricing', sender: 'Mara <mara@harborline.example>', to: 'ines@fernpoint.example',
    message_text: 'Thanks. We will take this to finance next week and come back with the budget for the pilot.',
    messageTimestamp: at, labelIds: ['INBOX'],
  }));
  assert.equal(logged, 1, 'the email is filed');
  assert.equal(modelCalls, 0);
  const obs = db.tables.observations.find((o) => o.source === 'gmail');
  // The fake does not project the reader's column aliases; these are the same raw fields.
  Object.assign(obs, { threadId: obs.raw.thread_id, from: obs.raw.from, to: obs.raw.to, subject: obs.value.description, isOutbound: String(obs.raw.is_outbound) });
  const { due } = await threadsToRead(db, WS, { days: 3 });
  assert.ok(due.some((u) => JSON.stringify(u).includes('t1')), 'no noema.read yet, so a later read picks it up');
});

test('a person a sync just created can have mail filed before the view shows them', async () => {
  const { ingestGmail } = await import('../src/webhooks/handlers/composio.mjs');
  const db = fakeDb({ observations: [], claims: [], entities: [], entity_identifiers: [], contacts: [] });
  const conn = { workspace_id: WS, owner_user_id: 'u1', account_email: 'ines@fernpoint.example' };
  const msg = { id: 'm2', thread_id: 't2', subject: 'Hello', sender: 'Teo <teo@quillfield.example>', to: 'ines@fernpoint.example',
    message_text: 'Glad to talk next week about the rollout and what it would take.', messageTimestamp: new Date(Date.now() - 86400_000).toISOString(), labelIds: ['INBOX'] };
  assert.equal(await ingestGmail(db, conn, msg), 0, 'outside a sync, Gmail never bootstraps a person');
  const logged = await withSyncOnly({ discovered: new Map([['teo@quillfield.example', { id: 'p1', company_id: 'co1' }]]) },
    () => ingestGmail(db, conn, msg));
  assert.equal(logged, 1);
});

test('a sync job finishes without credits, watermark or reading', async () => {
  const job = { job_id: 'j1', workspace_id: WS, state: { sync_only: true } };
  const db = fakeDb({ contact_enrichment_jobs: [{ ...job, status: 'running' }], workspaces: [{ id: WS, history_backfilled_at: null }] });
  let inSync = null, opts = null;
  await runSyncJob(db, job, [], { enrich: async (_s, _w, _i, _j, o) => { inSync = isSyncOnly(); opts = o; return { activitiesLogged: 3, failedSources: [] }; } });
  const row = db.tables.contact_enrichment_jobs[0];
  assert.equal(inSync, true, 'the enricher ran inside the sync context');
  assert.equal(opts.allowEmpty, true, 'an empty graph still syncs');
  await opts.creditGuard('gmail');   // the only guard is the trial's; credits never stop a sync
  assert.equal(row.status, 'done');
  assert.ok(row.state.sync_finished_at);
  assert.equal(row.state.sync_only, true);
  assert.equal(db.tables.workspaces[0].history_backfilled_at, null, 'the watermark must not move, or a backfill skips what was only filed');
});

test('a failed sync retries, then says failed', async () => {
  const job = { job_id: 'j2', workspace_id: WS, state: { sync_only: true } };
  const db = fakeDb({ contact_enrichment_jobs: [{ ...job, status: 'running' }] });
  const boom = async () => { throw new Error('gmail down'); };
  await runSyncJob(db, job, [], { attempts: 1, enrich: boom });
  assert.equal(db.tables.contact_enrichment_jobs[0].status, 'pending');
  await runSyncJob(db, job, [], { attempts: 3, enrich: boom });
  assert.equal(db.tables.contact_enrichment_jobs[0].status, 'failed');
});

test('a lapsed trial stops the sync, before it starts or between sources, and Free is untouched', async () => {
  const { trialHasLapsed } = await import('@nous/core');
  const past = new Date(Date.now() - 86400_000).toISOString();
  const future = new Date(Date.now() + 86400_000).toISOString();
  assert.equal(trialHasLapsed({ status: 'trialing', trial_ends_at: past }), true);
  assert.equal(trialHasLapsed({ status: 'trialing', trial_ends_at: future }), false);
  assert.equal(trialHasLapsed({ status: 'trialing', trial_ends_at: past, stripe_subscription_id: 'sub_1' }), false, 'Stripe bills it');
  assert.equal(trialHasLapsed({ status: 'trialing', trial_ends_at: past, is_comp: true }), false);
  assert.equal(trialHasLapsed({ plan_id: 'free', status: 'active' }), false);
  assert.equal(trialHasLapsed(null), false);

  const job = { job_id: 'j3', workspace_id: WS, state: { sync_only: true } };
  const db = fakeDb({ contact_enrichment_jobs: [{ ...job, status: 'running' }] });
  let ran = false;
  await runSyncJob(db, job, [], { lapsed: async () => true, enrich: async () => { ran = true; } });
  assert.equal(ran, false);
  assert.equal(db.tables.contact_enrichment_jobs[0].status, 'paused_trial_ended');

  let calls = 0;
  const db2 = fakeDb({ contact_enrichment_jobs: [{ ...job, status: 'running' }] });
  await runSyncJob(db2, job, [], {
    lapsed: async () => calls++ > 0,
    enrich: async (_s, _w, _i, _j, o) => { await o.creditGuard('gmail'); },
  });
  assert.equal(db2.tables.contact_enrichment_jobs[0].status, 'paused_trial_ended', 'stopped mid-run, not failed');
});

test('every ongoing pull asks about the trial', () => {
  for (const f of ['services/gmailSync', 'services/calendarSync', 'pollers/granola', 'pollers/notetakers', 'pollers/smtp', 'pollers/fellow', 'pollers/ringcentral', 'workers/crmSync']) {
    assert.match(readFileSync(new URL(`../src/${f}.mjs`, import.meta.url), 'utf8'), /await withoutLapsedTrials\(supabase,/, f);
  }
});

test('wiring: the job routes a sync before the credit gate, and the enricher skips the paid lookup', () => {
  const JOBS = readFileSync(new URL('../src/workers/contactEnrichmentJobs.mjs', import.meta.url), 'utf8');
  const SRC = readFileSync(new URL('../src/services/contactHistoryEnricher.mjs', import.meta.url), 'utf8');
  assert.ok(JOBS.indexOf('job.state?.sync_only') < JOBS.indexOf('const preflight = await backfillCreditState'));
  assert.match(SRC, /connections\.linkedin\?\.account_id && !syncOnly/);
  assert.match(SRC, /!syncOnly && !\(await appOwnsHistoryBackfill/, 'the api tier syncs');
});

test('a lapsed trial\'s pushes are dropped with a 200; everyone else, and a handshake, go through', async () => {
  const { dropForLapsedTrial, webhookWorkspaceId } = await import('../src/webhooks/inboundGate.mjs');
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(webhookWorkspaceId({ path: `/fireflies/${id}` }), id);
  assert.equal(webhookWorkspaceId({ path: '/fathom', query: { workspace_id: id } }), id);
  assert.equal(webhookWorkspaceId({ path: '/composio' }), null);
  const run = async (req, lapsed) => {
    let nexted = false, sent = null;
    const res = { status(c) { sent = { c }; return this; }, json(b) { sent.b = b; return this; } };
    await dropForLapsedTrial(req, res, () => { nexted = true; }, { lapsed, db: {} });
    return { nexted, sent };
  };
  const dropped = await run({ path: `/fireflies/${id}`, body: {} }, async () => true);
  assert.equal(dropped.nexted, false);
  assert.equal(dropped.sent.c, 200);
  assert.equal((await run({ path: `/fireflies/${id}`, body: {} }, async () => false)).nexted, true);
  assert.equal((await run({ path: `/fellow/${id}`, body: { type: 'url_verification' } }, async () => true)).nexted, true);
  assert.equal((await run({ path: `/fireflies/${id}`, body: {} }, async () => { throw new Error('down'); })).nexted, true, 'fails open');
  assert.match(readFileSync(new URL('../src/webhooks/handlers/composio.mjs', import.meta.url), 'utf8'), /await workspaceTrialLapsed\(supabase, conn\.workspace_id\)/);
});

test('a long sync holds its lane and nothing else: only sync rows, one at a time', async () => {
  const { processSyncJobs } = await import('../src/workers/contactEnrichmentJobs.mjs');
  const asked = [];
  const rows = [{ job_id: 's1', workspace_id: WS, status: 'pending', contacts: [], state: { sync_only: true } }];
  const db = { from() {
    const q = {
      select: () => q, or: () => q, order: () => q, limit: () => q, update: () => q,
      eq: (c, v) => { asked.push([c, v]); return q; },
      maybeSingle: async () => ({ data: { job_id: 's1' } }),
      then: (res) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return q;
  } };
  let release, ran = 0;
  const run = () => { ran++; return new Promise(r => { release = r; }); };
  const first = processSyncJobs({ db, run });
  await new Promise(r => setTimeout(r, 10));
  await processSyncJobs({ db, run });
  assert.equal(ran, 1, 'a second sync waits for the first');
  assert.ok(asked.some(([c, v]) => c === 'state->>sync_only' && v === 'true'));
  release(); await first;
  const JOBS = readFileSync(new URL('../src/workers/contactEnrichmentJobs.mjs', import.meta.url), 'utf8');
  assert.match(JOBS, /\.is\('state->>sync_only', null\)/, 'the main lane never picks up a sync');
  assert.match(readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8'), /processSyncJobs\(\)/);
});

test('two runs at once keep their own window and owner', async () => {
  const SRC = readFileSync(new URL('../src/services/contactHistoryEnricher.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(SRC, /^let _/m, 'no run state at module level');
  assert.match(SRC, /enrichRun\.run\(/);
});

test('a document a sync filed is not a read, so a paid read reaches the meeting', async () => {
  const { meetingAlreadyRead } = await import('../src/signals/index.mjs');
  const { saveDocument } = await import('@nous/core');
  const claims = [{ workspace_id: WS, value: { metadata: { source_ref: 'source://fireflies/m1', filed_unread: true } } }];
  const db = { from(name) {
    const fs = [];
    const q = {
      select: () => q, limit: () => q,
      eq(c, v) { fs.push((r) => (c === 'workspace_id' ? r.workspace_id === v : c.includes('source_ref') ? r.value?.metadata?.source_ref === v : true)); return q; },
      is(c) { fs.push((r) => r.value?.metadata?.[c.split('>>')[1]] == null); return q; },
      then: (res) => Promise.resolve({ data: name === 'claims' ? claims.filter(r => fs.every(f => f(r))) : [] }).then(res),
    };
    return q;
  } };
  assert.equal(await meetingAlreadyRead(db, WS, 'source://fireflies/m1'), false);
  claims.push({ workspace_id: WS, value: { metadata: { source_ref: 'source://fireflies/m1' } } });
  assert.equal(await meetingAlreadyRead(db, WS, 'source://fireflies/m1'), true, 'a real fact is a read');
  assert.ok(saveDocument);
  assert.match(readFileSync(new URL('../../../packages/core/src/db/notes.ts', import.meta.url), 'utf8'), /if \(isSyncOnly\(\)\) metadata\.filed_unread = true/);
});

test('a lapsed trial runs no RevPlay, and sends no webhook until it pays', async () => {
  const { dropStoppedRoutines } = await import('@nous/core');
  const past = { team_id: 't1', status: 'trialing', trial_ends_at: '2020-01-01T00:00:00Z' };
  const tables = {
    workspaces: [{ id: 'lapsed', team_id: 't1' }, { id: 'paying', team_id: 't2' }],
    subscriptions: [past, { team_id: 't2', status: 'active', stripe_subscription_id: 's' }],
    workspace_members: [{ workspace_id: 'paying', user_id: 'still-here' }],
  };
  const db = { from(name) { const q = { select: () => q, in: () => q, then: (r) => Promise.resolve({ data: tables[name] }).then(r) }; return q; } };
  const rows = [
    { id: 'a', workspace_id: 'lapsed' }, { id: 'b', workspace_id: 'paying' },
    { id: 'c', workspace_id: 'paying', visibility: 'personal', user_id: 'still-here' },
    { id: 'd', workspace_id: 'paying', visibility: 'personal', user_id: 'gone' },
  ];
  assert.deepEqual((await dropStoppedRoutines(db, rows)).map(r => r.id), ['b', 'c']);
  assert.deepEqual(await dropStoppedRoutines(db, []), []);
  const SRC = readFileSync(new URL('../src/workers/triggerDelivery.mjs', import.meta.url), 'utf8');
  assert.match(SRC, /workspaceTrialLapsed/);
  assert.match(readFileSync(new URL('../src/pollers/posthog.mjs', import.meta.url), 'utf8'), /withoutLapsedTrials|workspaceTrialLapsed/);
});

test('every place a RevPlay starts asks first, and a personal play fires only on what its owner sees', async () => {
  const ENGINE = readFileSync(new URL('../../../packages/core/src/services/automationRun.mjs', import.meta.url), 'utf8');
  assert.ok((ENGINE.match(/await dropStoppedRoutines\(supabase,/g) ?? []).length >= 5);
  assert.ok((ENGINE.match(/await ownerMaySee\(supabase,/g) ?? []).length >= 5);
  assert.match(readFileSync(new URL('../../api/src/cloud/lib/routineRunner.mjs', import.meta.url), 'utf8'), /await dropStoppedRoutines\(supabase,/);
  const { ownerMaySee, registerStepHandler } = await import('@nous/core');
  registerStepHandler('visible_accounts', async ({ userId }) => (userId === 'closed' ? new Set(['acct-1']) : null));
  assert.equal(await ownerMaySee({}, 'w', { user_id: 'closed' }, 'acct-2'), true, 'a shared play is as it was');
  assert.equal(await ownerMaySee({}, 'w', { visibility: 'personal', user_id: 'closed' }, 'acct-1'), true);
  assert.equal(await ownerMaySee({}, 'w', { visibility: 'personal', user_id: 'closed' }, 'acct-2'), false);
  assert.equal(await ownerMaySee({}, 'w', { visibility: 'personal', user_id: 'open' }, 'acct-2'), true);
});
