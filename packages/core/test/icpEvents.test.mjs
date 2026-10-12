// ICP events (GET-588) and connected repos (GET-674): what counts as an ICP change, from any
// scorer; what a GitHub workflow receives for people.added; which repos a webhook can pick.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/icpEvents.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { icpChanges } from '../dist/services/automationRun.mjs';
import { githubClientPayload } from '../dist/db/webhookDeliveries.js';
import { connectedRepos, connectedRepoDestination } from '../dist/db/managedWebhooks.js';
import { TRIGGER_EVENTS } from '../dist/db/triggers.js';

// supabase-js shape over in-memory rows: eq / is / gte (incl. jsonb ->> paths) / in / limit / maybeSingle.
function fakeSupabase(tables = {}) {
  const get = (row, col) => {
    const m = col.match(/^(\w+)->>(\w+)$/);
    return m ? row[m[1]]?.[m[2]] : row[col];
  };
  return {
    from(name) {
      const f = [];
      let single = false;
      const b = {
        select() { return b; },
        eq(c, v) { f.push(r => get(r, c) === v); return b; },
        is(c, v) { f.push(r => (get(r, c) ?? null) === v); return b; },
        gte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) >= String(v)); return b; },
        in(c, vs) { f.push(r => vs.includes(get(r, c))); return b; },
        limit() { return b; }, order() { return b; },
        maybeSingle() { single = true; return b; },
        then(res, rej) {
          const rows = (tables[name] ?? []).filter(r => f.every(fn => fn(r)));
          return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

const SINCE = '2026-10-04T10:00:00Z';
const pred = (id, entity_id, predicted_value, over = {}) => ({
  id, workspace_id: 'ws', kind: 'icp_fit', resolved_at: null, entity_id,
  predicted_at: '2026-10-01T00:00:00Z', model_version: 'ext:opennous-icp-v1', predicted_value, ...over,
});

test('the catalog has the ICP and people events', () => {
  for (const e of ['icp.score_changed', 'icp.tier_changed', 'people.added']) assert.ok(TRIGGER_EVENTS.includes(e));
});

test('a moved score is a change: from history[0] to the head, with the employer as the account', async () => {
  const sb = fakeSupabase({
    predictions: [
      // Tier 3 → Tier 2 at 11:00, inside the window.
      pred('p1', 'person1', { score: 74, tier: 'tier_2', reason: 'pain stated in call', rescored_at: '2026-10-04T11:00:00Z',
        history: [{ score: 58, tier: 'tier_3', at: '2026-10-03T09:00:00Z' }] }),
      // Moved yesterday: outside the window.
      pred('p2', 'person2', { score: 80, tier: 'tier_2', rescored_at: '2026-10-03T11:00:00Z', history: [{ score: 60, tier: 'tier_3' }] }),
      // A resolved bet never counts.
      pred('p3', 'person3', { score: 90, tier: 'tier_1', rescored_at: '2026-10-04T11:00:00Z', history: [{ score: 70, tier: 'tier_2' }] },
        { resolved_at: '2026-10-04T12:00:00Z' }),
    ],
    relationships: [{ workspace_id: 'ws', type: 'works_at', valid_to: null, from_entity_id: 'person1', to_entity_id: 'acme' }],
  });
  const out = await icpChanges(sb, 'ws', SINCE);
  assert.equal(out.length, 1);
  const c = out[0];
  assert.deepEqual(c.from, { score: 58, tier: 'tier_3' });
  assert.deepEqual(c.to, { score: 74, tier: 'tier_2' });
  assert.equal(c.first, false);
  assert.equal(c.accountId, 'acme');
  assert.equal(c.personId, 'person1');
  assert.equal(c.scorer, 'ext:opennous-icp-v1');
  assert.equal(c.reason, 'pain stated in call');
});

test('a first score inside the window is a change from nothing', async () => {
  const sb = fakeSupabase({
    predictions: [pred('p1', 'person1', { score: 88, tier: 'tier_1' }, { predicted_at: '2026-10-04T10:30:00Z' })],
    relationships: [],
  });
  const [c] = await icpChanges(sb, 'ws', SINCE);
  assert.equal(c.first, true);
  assert.equal(c.from, null);
  assert.deepEqual(c.to, { score: 88, tier: 'tier_1' });
  assert.equal(c.accountId, null);
});

test('a head equal to its history is not a change', async () => {
  const sb = fakeSupabase({
    predictions: [pred('p1', 'person1', { score: 70, tier: 'tier_2', rescored_at: '2026-10-04T11:00:00Z', history: [{ score: 70, tier: 'tier_2' }] })],
    relationships: [],
  });
  assert.deepEqual(await icpChanges(sb, 'ws', SINCE), []);
});

test('people.added reaches a GitHub workflow with the ids and the count, inside ten keys', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `p${i}`);
  const p = githubClientPayload('people.added', { id: 'e', workspace_id: 'ws', data: { count: 120, person_ids: ids } });
  assert.equal(p.count, 120);
  assert.equal(p.person_ids.length, 100);
  assert.ok(Object.keys(p).length <= 10);
  const other = githubClientPayload('deal.won', { id: 'e', data: {} });
  assert.equal(other.person_ids, null);
  assert.equal(other.count, null);
});

test('connected repos: the person\'s own and the workspace\'s, never a token', async () => {
  const sb = fakeSupabase({
    personal_workspaces: [{ workspace_id: 'ws', user_id: 'u1', source_type: 'github', github_repo: 'theo/notes', github_token_enc: 'ENC_P' }],
    company_workspaces: [{ workspace_id: 'ws', source_type: 'github', github_repo: 'opennous/company', github_token_enc: 'ENC_C' }],
  });
  const repos = await connectedRepos(sb, 'ws', 'u1');
  assert.deepEqual(repos, [{ source: 'personal', repo: 'theo/notes' }, { source: 'company', repo: 'opennous/company' }]);
  assert.ok(!JSON.stringify(repos).includes('ENC'));
  assert.deepEqual(await connectedRepoDestination(sb, 'ws', 'u1', 'company'), { type: 'github', repo: 'opennous/company', tokenEnc: 'ENC_C' });
  assert.deepEqual(await connectedRepos(sb, 'ws', 'u2'), [{ source: 'company', repo: 'opennous/company' }]);
});
