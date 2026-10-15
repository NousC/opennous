// /v2/revboxes (GET-868): the Job Builder is Cloud's, reached through registerJobBuilder. Without it
// (self-host) the builder routes answer 501; with it, a turn comes back as one JSON body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { makeRevboxesV2Router } from '../src/routes/v2/revboxes.mjs';

const BOX = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';

async function serve(router, user = { workspaceId: 'ws', memberUserId: 'u1' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, user); next(); });
  app.use('/v2/revboxes', router);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('without the Cloud layer the builder routes answer 501 job_builder_unavailable', async () => {
  const srv = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => null }));
  try {
    const r = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder`, { message: 'x' });
    assert.equal(r.status, 501);
    assert.equal((await r.json()).error, 'job_builder_unavailable');
    const a = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder/${SESSION}/approve`, {});
    assert.equal(a.status, 501);
  } finally { await srv.close(); }
});

test('a key with no member is refused', async () => {
  const srv = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => null }), { workspaceId: 'ws', memberUserId: null });
  try {
    const r = await fetch(`${srv.url}/v2/revboxes`);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'member_key_required');
  } finally { await srv.close(); }
});

function fakeBuilder(events) {
  const calls = [];
  return {
    calls,
    turnInput: (body) => ({ message: body.message ?? null, answers: body.answers ?? null }),
    openSession: async (a) => { calls.push(['open', a.sessionId]); return { session: { id: SESSION }, isNew: !a.sessionId }; },
    async *runTurn() { yield* events; },
    collectTurn: (evs) => {
      const out = { session_id: null, events: evs, state: 'text' };
      for (const e of evs) { if (e.type === 'session') out.session_id = e.session_id; if (e.type === 'proposal') { out.state = 'proposed'; out.proposal = e.proposal; } if (e.type === 'error') out.error = { code: e.code }; }
      return out;
    },
    approve: async (a) => { calls.push(['approve', a.name]); return { routine: { id: 'r1' } }; },
  };
}

test('a builder turn comes back as one JSON body; credits errors are 402; approve passes a rename', async () => {
  const ok = fakeBuilder([{ type: 'session', session_id: SESSION }, { type: 'proposal', proposal: { name: 'Job' } }, { type: 'credits', credits: 2 }, { type: 'done' }]);
  const srv = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => ok }));
  try {
    const r = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder`, { message: 'Set up a job' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.session_id, SESSION);
    assert.equal(body.state, 'proposed');
    assert.equal(body.proposal.name, 'Job');
    assert.equal(body.events.length, 4);
    const a = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder/${SESSION}/approve`, { name: 'Renamed' });
    assert.deepEqual(await a.json(), { routine: { id: 'r1' } });
    assert.deepEqual(ok.calls.at(-1), ['approve', 'Renamed']);
    const bad = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder`, { session_id: 'nope', message: 'x' });
    assert.equal(bad.status, 400);
  } finally { await srv.close(); }

  const broke = fakeBuilder([{ type: 'session', session_id: SESSION }, { type: 'error', code: 'insufficient_credits', message: 'out' }, { type: 'done' }]);
  const srv2 = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => broke }));
  try {
    const r = await post(`${srv2.url}/v2/revboxes/${BOX}/jobs/builder`, { message: 'x' });
    assert.equal(r.status, 402);
  } finally { await srv2.close(); }
});

test('Edit over /v2: { job_id } with no message returns the new session and its history; approve says whether the job is on', async () => {
  const JOB = '44444444-4444-4444-8444-444444444444';
  const b = fakeBuilder([]);
  b.openForJob = async (a) => { b.calls.push(['edit', a.jobId, a.userId]); return { session: { id: SESSION, job_id: a.jobId, proposal: { name: 'Job' } }, history: [{ role: 'user', text: 'hi' }, { kind: 'proposal', proposal: { name: 'Job' }, approved: true }] }; };
  b.approve = async () => ({ routine: { id: JOB }, enabled: false, reason: 'Credits are required.' });
  const srv = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => b }));
  try {
    const r = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder`, { job_id: JOB });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { session_id: SESSION, job_id: JOB, history: [{ role: 'user', text: 'hi' }, { kind: 'proposal', proposal: { name: 'Job' }, approved: true }], proposal: { name: 'Job' } });
    assert.deepEqual(b.calls.at(-1), ['edit', JOB, 'u1']);
    assert.equal((await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder`, { job_id: 'nope' })).status, 400);
    const a = await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder/${SESSION}/approve`, {});
    assert.deepEqual(await a.json(), { routine: { id: JOB }, enabled: false, reason: 'Credits are required.' });
    // Review 8: a mailbox-owner warning is in the answer.
    const w = [{ kind: 'mailbox_owner', destination_id: 'd1', message: 'Gmail draft destination dana@acme.example belongs to Dana; drafts will fail while you own this job.' }];
    b.approve = async () => ({ routine: { id: JOB }, enabled: true, warnings: w });
    assert.deepEqual(await (await post(`${srv.url}/v2/revboxes/${BOX}/jobs/builder/${SESSION}/approve`, {})).json(), { routine: { id: JOB }, enabled: true, warnings: w });
  } finally { await srv.close(); }
  // Without openForJob (an older Cloud layer) Edit answers 501.
  const old = fakeBuilder([]);
  const srv2 = await serve(makeRevboxesV2Router({ getSb: () => ({}), builder: () => old }));
  try { assert.equal((await post(`${srv2.url}/v2/revboxes/${BOX}/jobs/builder`, { job_id: '44444444-4444-4444-8444-444444444444' })).status, 501); }
  finally { await srv2.close(); }
});
