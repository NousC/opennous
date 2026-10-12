// "After every call" as a real webhook (GET-672): the toggle and the connected repo decide whether a
// seat has one, sync keeps it matching, the old queue skips moved seats, and installed workflows
// keep receiving the event name they listen for.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/managedWebhooks.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seatWantsAfterCall, syncAfterCallWebhook, reconcileAfterCallWebhooks, seatsWithAfterCallWebhook,
  connectedRepoDestination, AFTER_CALL_GITHUB_EVENT_TYPE,
} from '../dist/db/managedWebhooks.js';
import { enqueueGithubDispatches } from '../dist/db/githubDispatch.js';
import { sendGithubDispatch } from '../dist/db/webhookDeliveries.js';

// In-memory supabase-js shape: eq/not filters, select, maybeSingle, insert, update, delete, upsert.
function fakeSupabase(tables = {}) {
  let n = 0;
  return {
    tables,
    from(name) {
      tables[name] ??= [];
      const st = { f: [], mode: 'select', row: null, single: false };
      const rows = () => tables[name].filter(r => st.f.every(fn => fn(r)));
      const b = {
        select() { return b; },
        eq(c, v) { st.f.push(r => r[c] === v); return b; },
        not(c, op, v) { st.f.push(r => !(op === 'is' && v === null ? r[c] == null : r[c] === v)); return b; },
        insert(row) { st.mode = 'insert'; st.row = row; return b; },
        update(row) { st.mode = 'update'; st.row = row; return b; },
        delete() { st.mode = 'delete'; return b; },
        upsert(row) { st.mode = 'upsert'; st.row = row; return b; },
        maybeSingle() { st.single = true; return b; },
        then(res, rej) {
          let out = { data: null, error: null };
          if (st.mode === 'insert' || st.mode === 'upsert') {
            const list = Array.isArray(st.row) ? st.row : [st.row];
            for (const r of list) tables[name].push({ id: `id_${++n}`, ...r });
          } else if (st.mode === 'update') {
            for (const r of rows()) Object.assign(r, st.row);
          } else if (st.mode === 'delete') {
            const keep = tables[name].filter(r => !st.f.every(fn => fn(r)));
            tables[name].length = 0; tables[name].push(...keep);
          } else {
            const hit = rows();
            out.data = st.single ? (hit[0] ?? null) : hit;
          }
          return Promise.resolve(out).then(res, rej);
        },
      };
      return b;
    },
  };
}

const seat = (over = {}) => ({
  workspace_id: 'ws', user_id: 'u1', source_type: 'github', github_repo: 'acme/gtm', github_token_enc: 'ENC1',
  automation_enabled: true, automation_events: ['interaction.meeting_held'], ...over,
});

test('a seat wants the webhook only when the toggle is on AND a repo with a token is connected', () => {
  assert.equal(seatWantsAfterCall(seat()), true);
  assert.equal(seatWantsAfterCall(seat({ automation_events: [] })), true, 'empty list = meeting_held, as the old queue read it');
  assert.equal(seatWantsAfterCall(seat({ automation_enabled: false })), false);
  assert.equal(seatWantsAfterCall(seat({ automation_events: ['something_else'] })), false);
  assert.equal(seatWantsAfterCall(seat({ source_type: 'none', github_repo: null })), false, 'toggle on before a repo is connected');
  assert.equal(seatWantsAfterCall(seat({ github_token_enc: null })), false);
  assert.equal(seatWantsAfterCall(null), false);
});

test('sync creates the webhook: GitHub, the seat repo and token, call_ended, sent as nous.meeting_held', async () => {
  const sb = fakeSupabase({ personal_workspaces: [seat()] });
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'created');
  const [w] = sb.tables.trigger_subscriptions;
  assert.equal(w.destination_type, 'github');
  assert.equal(w.github_repo, 'acme/gtm');
  assert.equal(w.github_token_enc, 'ENC1');
  assert.deepEqual(w.events, ['conversation.call_ended']);
  assert.equal(w.github_event_type, AFTER_CALL_GITHUB_EVENT_TYPE);
  assert.equal(w.managed_by, 'after_call');
  assert.equal(w.owner_user_id, 'u1');
  assert.equal(w.url, null);
  assert.ok(w.signing_secret.startsWith('whsec_'));
});

test('sync is idempotent, follows a reconnect, and removes on toggle off or disconnect', async () => {
  const sb = fakeSupabase({ personal_workspaces: [seat()] });
  await syncAfterCallWebhook(sb, 'ws', 'u1');
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'unchanged');

  Object.assign(sb.tables.personal_workspaces[0], { github_repo: 'acme/new', github_token_enc: 'ENC2' });
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'updated');
  assert.equal(sb.tables.trigger_subscriptions[0].github_repo, 'acme/new');
  assert.equal(sb.tables.trigger_subscriptions[0].github_token_enc, 'ENC2');
  assert.equal(sb.tables.trigger_subscriptions.length, 1);

  Object.assign(sb.tables.personal_workspaces[0], { source_type: 'none', github_repo: null, github_token_enc: null });
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'removed');
  assert.equal(sb.tables.trigger_subscriptions.length, 0);
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'none');
});

test('sync never touches a webhook someone made by hand', async () => {
  const mine = { id: 'hand', workspace_id: 'ws', owner_user_id: null, managed_by: null, destination_type: 'url', url: 'https://x.example.com' };
  const sb = fakeSupabase({ personal_workspaces: [seat({ automation_enabled: false })], trigger_subscriptions: [mine] });
  assert.equal(await syncAfterCallWebhook(sb, 'ws', 'u1'), 'none');
  assert.deepEqual(sb.tables.trigger_subscriptions, [mine]);
});

test('reconcile: the first run moves every enabled seat; a seat switched off loses its webhook', async () => {
  const sb = fakeSupabase({
    personal_workspaces: [seat(), seat({ user_id: 'u2', github_repo: 'beta/gtm' }), seat({ user_id: 'u3', source_type: 'none', github_repo: null, github_token_enc: null })],
  });
  const r1 = await reconcileAfterCallWebhooks(sb);
  assert.equal(r1.created, 2);
  assert.equal(r1.none, 1, 'toggle on but no repo yet: nothing to create');

  sb.tables.personal_workspaces[1].automation_enabled = false;
  const r2 = await reconcileAfterCallWebhooks(sb);
  assert.equal(r2.removed, 1);
  assert.equal(r2.unchanged, 1);
  assert.deepEqual(sb.tables.trigger_subscriptions.map(w => w.owner_user_id), ['u1']);
});

test('the old queue skips a seat that has moved, and keeps one that has not', async () => {
  const sb = fakeSupabase({
    personal_workspaces: [seat(), seat({ user_id: 'u2', github_repo: 'beta/gtm' })],
    trigger_subscriptions: [{ id: 'w', workspace_id: 'ws', owner_user_id: 'u1', managed_by: 'after_call', active: true }],
  });
  assert.deepEqual([...await seatsWithAfterCallWebhook(sb, 'ws')], ['u1']);
  const n = await enqueueGithubDispatches(sb, {
    workspaceId: 'ws', eventType: 'interaction.meeting_held', entityId: 'p', occurredAt: 't', dedupKey: 'm1', clientPayload: {},
  });
  assert.equal(n, 1);
  assert.deepEqual(sb.tables.github_dispatches.map(d => d.user_id), ['u2']);
});

test('connected_repo resolves to the seat repo and its stored token, or nothing', async () => {
  const sb = fakeSupabase({ personal_workspaces: [seat(), seat({ user_id: 'u2', source_type: 'none', github_repo: null, github_token_enc: null })] });
  assert.deepEqual(await connectedRepoDestination(sb, 'ws', 'u1'), { type: 'github', repo: 'acme/gtm', tokenEnc: 'ENC1' });
  assert.equal(await connectedRepoDestination(sb, 'ws', 'u2'), null);
  assert.equal(await connectedRepoDestination(sb, 'ws', 'nobody'), null);
});

test('a webhook github_event_type overrides nous.<event>', async () => {
  let sent;
  await sendGithubDispatch({
    repo: 'acme/gtm', token: 't', eventType: 'conversation.call_ended', githubEventType: 'nous.meeting_held', payload: { id: 'e' },
    fetchImpl: async (_u, init) => { sent = JSON.parse(init.body); return { status: 204, statusText: '', headers: { get: () => null }, body: { cancel: async () => {} } }; },
  });
  assert.equal(sent.event_type, 'nous.meeting_held');
  assert.equal(sent.client_payload.event_type, 'conversation.call_ended');
});
