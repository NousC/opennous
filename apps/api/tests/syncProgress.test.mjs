import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressForConnection, syncProgressByConnection, STALE_MS } from '../src/providers/syncProgress.mjs';

// The source cards' "Syncing n%" (GET-620 E5). What must hold: the number comes from a backfill
// that is actually running, per source; a CRM, a stale job, a finished source or a slow read is
// null — never a guess.

const NOW = Date.parse('2026-10-03T12:00:00Z');
const fresh = new Date(NOW - 10_000).toISOString();
const lane = (status) => ({ status, count: 0 });
const contacts = (bySource) => {
  const n = Math.max(...Object.values(bySource).map((l) => l.length));
  return Array.from({ length: n }, (_, i) => ({ id: `a${i}`, sources: Object.fromEntries(Object.entries(bySource).map(([k, l]) => [k, l[i] ?? lane('skipped')])) }));
};
const job = (state, over = {}) => ({ job_id: 'j1', status: 'running', done: false, updated_at: fresh, state, ...over });
const gmail = { id: 'c-gmail', scope: 'personal', owner_user_id: 'u1', provider: { name: 'gmail_oauth' } };
const fireflies = { id: 'c-ff', scope: 'personal', owner_user_id: 'u1', provider: { name: 'fireflies' } };
const hubspot = { id: 'c-hs', scope: 'company', owner_user_id: 'u1', provider: { name: 'hubspot' } };

test('filing: a source\'s finished lanes over its lanes, skipped lanes ignored', () => {
  const j = job({ contacts: contacts({
    gmail: [lane('done'), lane('failed'), lane('scanning'), lane('pending')],
    fireflies: [lane('done'), lane('done'), lane('skipped'), lane('skipped')],
  }) });
  assert.deepEqual(progressForConnection(gmail, [j], NOW), { percent: 50, done: 2, total: 4, label: 'Importing history' });
  // Fireflies' part is finished while gmail still files: it is not syncing.
  assert.equal(progressForConnection(fireflies, [j], NOW), null);
  // A source with no lanes at all (not in the job), and a CRM, have no measurable progress.
  assert.equal(progressForConnection(hubspot, [j], NOW), null);
});

test('reading: email sources show threads read of threads to read; others are done', () => {
  const j = job({ filed_at: fresh, reading: { total: 400, done: 290, read: 280, failed: 10 }, contacts: contacts({ gmail: [lane('done')], fireflies: [lane('done')] }) });
  assert.deepEqual(progressForConnection(gmail, [j], NOW), { percent: 72, done: 290, total: 400, label: 'Reading email' });
  assert.equal(progressForConnection(fireflies, [j], NOW), null);
  // Not started, finished, deferred behind the daily reader, or an empty window: null.
  for (const reading of [undefined, { total: 400, done: 400, finished: true }, { deferred: true }, { total: 0, done: 0 }]) {
    assert.equal(progressForConnection(gmail, [job({ filed_at: fresh, reading })], NOW), null);
  }
});

test('only a running, fresh job counts', () => {
  const state = { contacts: contacts({ gmail: [lane('done'), lane('pending')] }) };
  assert.equal(progressForConnection(gmail, [job(state, { status: 'paused_awaiting_confirmation' })], NOW), null);
  assert.equal(progressForConnection(gmail, [job(state, { done: true })], NOW), null);
  assert.equal(progressForConnection(gmail, [job(state, { updated_at: new Date(NOW - STALE_MS - 1).toISOString() })], NOW), null);
  assert.equal(progressForConnection(gmail, [], NOW), null);
});

test('a member\'s own backfill covers their personal source; a shared source reads the workspace\'s', () => {
  const mine = job({ owner_user_id: 'u2', contacts: contacts({ gmail: [lane('done'), lane('done'), lane('done'), lane('pending')] }) }, { job_id: 'm' });
  const ws = job({ contacts: contacts({ gmail: [lane('pending'), lane('pending')], slack: [lane('done'), lane('pending'), lane('pending'), lane('pending')] }) }, { job_id: 'w' });
  const membersGmail = { ...gmail, owner_user_id: 'u2' };
  assert.equal(progressForConnection(membersGmail, [ws, mine], NOW).percent, 75);
  // A personal source whose owner has no job of their own falls back to the workspace's.
  assert.equal(progressForConnection(gmail, [ws, mine], NOW).percent, 0);
  // A shared source never reads a member's job.
  const slack = { id: 'c-sl', scope: 'company', owner_user_id: 'u2', provider: { name: 'slack' } };
  assert.equal(progressForConnection(slack, [mine], NOW), null);
  assert.equal(progressForConnection(slack, [ws, mine], NOW).percent, 25);
});

function fakeSupabase({ jobs = [], error = null, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const f = { table, eq: {} };
      const b = {
        select() { return b; },
        eq(c, v) { f.eq[c] = v; return b; },
        order() { return b; },
        limit() { return b; },
        then(res, rej) {
          calls.push(f);
          if (hang) return new Promise(() => {}).then(res, rej);
          const rows = jobs.filter((j) => Object.entries(f.eq).every(([k, v]) => j[k] === v));
          return Promise.resolve({ data: error ? null : rows, error }).then(res, rej);
        },
      };
      return b;
    },
  };
}

test('syncProgressByConnection: one read of running jobs in the workspace, null for everything else', async () => {
  const sb = fakeSupabase({ jobs: [{ ...job({ contacts: contacts({ gmail: [lane('done'), lane('pending')] }) }), workspace_id: 'ws' }] });
  const out = await syncProgressByConnection(sb, 'ws', [gmail, hubspot], { now: NOW });
  assert.deepEqual(out.get('c-gmail'), { percent: 50, done: 1, total: 2, label: 'Importing history' });
  assert.equal(out.get('c-hs'), null);
  assert.equal(sb.calls.length, 1);
  assert.deepEqual(sb.calls[0].eq, { workspace_id: 'ws', status: 'running' });
});

test('syncProgressByConnection: an error or a slow read is all-null, never a throw', async () => {
  const err = await syncProgressByConnection(fakeSupabase({ error: { message: 'boom' } }), 'ws', [gmail], { now: NOW });
  assert.equal(err.get('c-gmail'), null);
  const t0 = Date.now();
  const slow = await syncProgressByConnection(fakeSupabase({ hang: true }), 'ws', [gmail], { now: NOW, deadlineMs: 50 });
  assert.equal(slow.get('c-gmail'), null);
  assert.ok(Date.now() - t0 < 1000);
});
