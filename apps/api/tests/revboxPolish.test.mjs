// RevBox page polish (GET-872): a failed run's reason in words with its fix, the built-in jobs as
// the Jobs list reads them, and the run states the Results list draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFailure, builtinJobsOut, routineRunState, saveJobStepTarget } from '../src/routes/api/revboxes.mjs';

test('a failed run says why in words, from the failed step, with Connect or Reconnect when a connection is the cause', () => {
  const log = [{ step: 1, type: 'hubspot', status: 'ok' }, { step: 3, type: 'slack', name: 'Slack', status: 'failed', detail: "Slack isn't connected" }];
  assert.deepEqual(runFailure("Step 3 · Slack: Slack isn't connected", log), { text: "Slack isn't connected", fix: { label: 'Connect Slack', href: '/integrations' } });
  assert.deepEqual(runFailure('Step 2 · Slack: the Slack connection expired. Reconnect Slack in Sources', []), { text: 'The Slack connection expired', fix: { label: 'Reconnect', href: '/integrations' } });
  assert.deepEqual(runFailure('Step 2 · Slack: no channel set', null), { text: 'No channel set', fix: null });
  assert.deepEqual(runFailure(null, []), { text: 'The run stopped before it finished.', fix: null });
});

test('built-in jobs come out with their definition and what they drafted', () => {
  const out = builtinJobsOut(['deal_risk', 'stale_deal'], [{ key: 'stale_deal', drafts: 4, last_at: '2026-10-12T00:00:00Z' }]);
  assert.deepEqual(out.map(j => j.key), ['stale_deal', 'deal_risk']);
  assert.equal(out[0].cadence, 'Nightly');
  assert.equal(out[0].drafts_30d, 4);
  assert.equal(out[1].drafts_30d, 0);
  assert.equal(out[1].last_draft_at, null);
  assert.equal('drafts' in out[0], false);
});

test('a denied run keeps its own state', () => {
  assert.equal(routineRunState('rejected'), 'rejected');
  assert.equal(routineRunState('awaiting_approval'), 'needs_review');
  assert.equal(routineRunState('error'), 'failed');
});

// ── A job's own delivery target, edited from the Delivery rail ─────────────────────────────

function boxDb() {
  const tables = {
    workspace_members: [{ workspace_id: 'ws', user_id: 'ed' }, { workspace_id: 'ws', user_id: 'viewer' }],
    revboxes: [{ id: 'box', workspace_id: 'ws', owner_id: 'owner', shared: true, delivery: [] }],
    revbox_members: [{ workspace_id: 'ws', revbox_id: 'box', user_id: 'ed', role: 'editor' }],
    agent_routines: [{ id: 'job', workspace_id: 'ws', revbox_id: 'box', name: 'TU daily', enabled: true, version: 3, trigger_config: {}, steps: [
      { id: 'summary', type: 'agent', config: { prompt: 'Summarize.' } },
      { id: 'post', type: 'slack', config: { action: 'channel', channel_id: 'C0OLD', channel: 'old', text: '{{steps.summary.output}}' } },
      { id: 'hook', type: 'webhook', config: { url: 'https://hooks.example.com/x' } },
    ] }],
  };
  const writes = [];
  const sb = { tables, writes, from(table) {
    const filters = []; let patch = null;
    const q = {
      select: () => q, order: () => q, limit: () => q,
      eq: (k, v) => { filters.push(r => r[k] === v); return q; },
      update: (p) => { patch = p; return q; },
      run() {
        const hit = (tables[table] ?? []).filter(r => filters.every(f => f(r)));
        if (patch) { writes.push({ table, patch, filters: filters.length }); for (const r of hit) { Object.assign(r, structuredClone(patch)); if (table === 'agent_routines') r.version += 1; } }
        return hit;
      },
      maybeSingle: () => Promise.resolve({ data: structuredClone(q.run()[0] ?? null), error: null }),
      then: (ok, ko) => Promise.resolve({ data: structuredClone(q.run()), error: null }).then(ok, ko),
    };
    return q;
  } };
  return sb;
}
const deps = {
  slackTargets: async () => ({ connected: true, channels: [{ id: 'C0TU', name: 'credit_check-cs' }] }),
  mailboxes: async () => [],
  assertUrl: async (url) => { if (/localhost|10\.|169\.254/.test(url)) throw new Error('blocked_private_address'); },
};
const args = (userId, stepId, body) => ({ workspaceId: 'ws', revboxId: 'box', userId, jobId: 'job', stepId, body });

test('an editor changes a job\'s Slack channel: id and name stored, versioned, still on', async () => {
  const sb = boxDb();
  const job = await saveJobStepTarget(sb, args('ed', 'post', { kind: 'slack', channel_id: 'C0TU' }), deps);
  const post = job.steps.find(s => s.id === 'post');
  assert.deepEqual(post.config, { action: 'channel', channel_id: 'C0TU', channel: 'credit_check-cs', text: '{{steps.summary.output}}' });
  assert.equal(job.version, 4);
  assert.equal(job.enabled, true);
  const w = sb.writes.find(x => x.table === 'agent_routines');
  assert.equal(w.patch.edited_by, 'ed');
  assert.equal('enabled' in w.patch, false);
});

test('a viewer cannot change a job\'s target', async () => {
  await assert.rejects(saveJobStepTarget(boxDb(), args('viewer', 'post', { kind: 'slack', channel_id: 'C0TU' }), deps), e => e.status === 403);
});

test('an unknown Slack channel is refused', async () => {
  await assert.rejects(saveJobStepTarget(boxDb(), args('ed', 'post', { kind: 'slack', channel_id: 'C0NOPE' }), deps), e => e.status === 400 && /can't find that channel/.test(e.message));
});

test('a private webhook host is refused, and http is refused', async () => {
  await assert.rejects(saveJobStepTarget(boxDb(), args('ed', 'hook', { kind: 'webhook', url: 'https://169.254.169.254/latest' }), deps), e => e.status === 400 && /public host/.test(e.message));
  await assert.rejects(saveJobStepTarget(boxDb(), args('ed', 'hook', { kind: 'webhook', url: 'http://hooks.example.com/y' }), deps), e => e.status === 400);
  const ok = await saveJobStepTarget(boxDb(), args('ed', 'hook', { kind: 'webhook', url: 'https://hooks.example.com/y' }), deps);
  assert.equal(ok.steps.find(s => s.id === 'hook').config.url, 'https://hooks.example.com/y');
});

test('the step kind cannot change here', async () => {
  await assert.rejects(saveJobStepTarget(boxDb(), args('ed', 'post', { kind: 'email', to: 'a@b.com' }), deps), e => e.status === 400 && /change its kind/.test(e.message));
  await assert.rejects(saveJobStepTarget(boxDb(), args('ed', 'summary', { kind: 'agent' }), deps), e => e.status === 400);
});
