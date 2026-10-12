// Bring-your-own ICP scorer (GET-586): a score the workspace computed itself lands as the account's
// icp_fit prediction, keeps the trail like ours does, never touches a resolved bet, and is never
// overwritten by Nous's own scorer.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/externalScores.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeExternalScore, isExternalModelVersion, normalizeScorerName, getIcpScorer, getIcpScorerSetting,
  externalScorerWorkspaces, planDefaultScorer, normalizeTierThresholds,
} from '../dist/db/externalScores.js';
// The learned scorer's entry points as public code calls them: Nous's scorecard when the build
// carries src/cloud/, nothing without it (GET-754 slice 8). Either way an external score stands.
import {
  scoreAndStake, rescoreEntityFromClaims, rescoreOpenPredictions, hasLearnedIcpScorer,
} from '../dist/services/icpScorer.js';

// An in-memory PostgREST-shaped client: eq/is filters, insert, update, and every other table empty.
function fakeSupabase(tables = {}) {
  let seq = 0;
  const rowsOf = (t) => (tables[t] ??= []);
  return {
    tables,
    from(table) {
      const f = [];
      let op = 'select', payload = null, single = false;
      const q = {
        select() { return q; },
        insert(row) { op = 'insert'; payload = row; return q; },
        update(patch) { op = 'update'; payload = patch; return q; },
        eq(c, v) { f.push(r => r[c] === v); return q; },
        is(c, v) { f.push(r => (r[c] ?? null) === v); return q; },
        not() { return q; }, like() { return q; }, in() { return q; }, gte() { return q; },
        order() { return q; }, limit() { return q; }, range() { return q; },
        single() { single = true; return q; },
        maybeSingle() { single = true; return q; },
        then(res, rej) {
          let data;
          if (op === 'insert') {
            const row = { id: `pred-${++seq}`, resolved_at: null, ...payload };
            rowsOf(table).push(row);
            data = single ? { id: row.id } : [row];
          } else if (op === 'update') {
            for (const r of rowsOf(table).filter(r => f.every(fn => fn(r)))) Object.assign(r, payload);
            data = null;
          } else {
            const hit = rowsOf(table).filter(r => f.every(fn => fn(r)));
            data = single ? (hit[0] ?? null) : hit;
          }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

const WS = 'ws-1', P = 'person-1';

test('scorer names and the ext: marker', () => {
  assert.equal(normalizeScorerName(' acme-v3 '), 'acme-v3');
  assert.equal(normalizeScorerName('jev/icp.v1'), 'jev/icp.v1');
  assert.equal(normalizeScorerName(''), null);
  assert.equal(normalizeScorerName('has space'), null);
  assert.equal(isExternalModelVersion('ext:acme-v3'), true);
  assert.equal(isExternalModelVersion('sc_a1b2'), false);
  assert.equal(isExternalModelVersion(null), false);
});

test('unset, the plan decides: Custom is scored by Nous, self-serve brings its own', async () => {
  assert.equal(planDefaultScorer({ plan_id: 'custom', status: 'active' }), 'nous');
  assert.equal(planDefaultScorer({ plan_id: 'growth', status: 'active' }), 'nous', 'legacy operated plans resolve to Custom');
  assert.equal(planDefaultScorer({ plan_id: 'api', status: 'active' }), 'external');
  assert.equal(planDefaultScorer({ plan_id: 'pro', status: 'active' }), 'external');
  assert.equal(planDefaultScorer({ plan_id: 'custom', status: 'canceled' }), 'external', 'a dead subscription falls to the API plan');
  assert.equal(planDefaultScorer(null), 'external');

  const sb = fakeSupabase({
    workspaces: [
      { id: 'w-api', team_id: 't-api' },
      { id: 'w-custom', team_id: 't-custom' },
      { id: 'w-chose', team_id: 't-api', icp_scorer: 'nous' },
    ],
    subscriptions: [
      { team_id: 't-api', plan_id: 'api', status: 'active' },
      { team_id: 't-custom', plan_id: 'custom', status: 'active' },
    ],
  });
  if (hasLearnedIcpScorer()) {
    assert.deepEqual(await getIcpScorerSetting(sb, 'w-api'), { scorer: 'external', source: 'plan' });
    assert.deepEqual(await getIcpScorerSetting(sb, 'w-custom'), { scorer: 'nous', source: 'plan' });
    assert.deepEqual(await getIcpScorerSetting(sb, 'w-chose'), { scorer: 'nous', source: 'workspace' });
    assert.equal(await getIcpScorer(sb, 'w-api'), 'external');
    assert.deepEqual([...await externalScorerWorkspaces(sb)], ['w-api']);
  } else {
    // The open-source build has no learned scorer: every workspace scores for itself, whatever
    // its plan or its stored choice says.
    for (const ws of ['w-api', 'w-custom', 'w-chose']) {
      assert.deepEqual(await getIcpScorerSetting(sb, ws), { scorer: 'external', source: 'plan' });
    }
    assert.deepEqual([...await externalScorerWorkspaces(sb)].sort(), ['w-api', 'w-chose', 'w-custom']);
  }
});

test('tier cut-offs: only a descending 1-100 triple is an override', () => {
  assert.deepEqual(normalizeTierThresholds({ tier_1: 90, tier_2: 60, tier_3: 30 }), { tier_1: 90, tier_2: 60, tier_3: 30 });
  assert.equal(normalizeTierThresholds({ tier_1: 60, tier_2: 60, tier_3: 30 }), null);
  assert.equal(normalizeTierThresholds({ tier_1: 101, tier_2: 60, tier_3: 30 }), null);
  assert.equal(normalizeTierThresholds({ tier_1: 90, tier_2: 60 }), null);
  assert.equal(normalizeTierThresholds(null), null);
});

test("an external score without a tier uses the workspace's bands", async () => {
  const sb = fakeSupabase({ workspaces: [{ id: WS, icp_tier_thresholds: { tier_1: 95, tier_2: 80, tier_3: 40 } }] });
  const r = await writeExternalScore(sb, WS, P, { score: 87, scorer: 'acme-v3' });
  assert.equal(r.tier, 'tier_2', '87 is under a 95 tier_1 cut');
  assert.equal(sb.tables.predictions[0].predicted_value.fit, true, '87 clears an 80 tier_2 cut');
  const low = await writeExternalScore(sb, WS, 'person-2', { score: 75, scorer: 'acme-v3' });
  assert.equal(low.tier, 'tier_3');
  assert.equal(sb.tables.predictions[1].predicted_value.fit, false);
});

test('first external score stakes an icp_fit prediction, tier derived from the score', async () => {
  const sb = fakeSupabase();
  const r = await writeExternalScore(sb, WS, P, { score: 87.4, scorer: 'acme-v3', reason: 'fintech, 40 staff' });
  assert.equal(r.status, 'staked');
  assert.equal(r.tier, 'tier_1');
  const [row] = sb.tables.predictions;
  assert.equal(row.kind, 'icp_fit');
  assert.equal(row.model_version, 'ext:acme-v3');
  assert.deepEqual(row.predicted_value, { score: 87, fit: true, reason: 'fintech, 40 staff', tier: 'tier_1' });
});

test('a moved external score keeps the prior head in history; a caller tier wins', async () => {
  const sb = fakeSupabase();
  await writeExternalScore(sb, WS, P, { score: 60, scorer: 'acme-v3' });
  const r = await writeExternalScore(sb, WS, P, { score: 72, tier: 'tier_1', scorer: 'acme-v4' });
  assert.equal(r.status, 'updated');
  assert.equal(r.from, 60);
  const [row] = sb.tables.predictions;
  assert.equal(sb.tables.predictions.length, 1, 'one open prediction per account');
  assert.equal(row.model_version, 'ext:acme-v4');
  assert.equal(row.predicted_value.tier, 'tier_1');
  assert.equal(row.predicted_value.history.length, 1);
  assert.equal(row.predicted_value.history[0].score, 60);
  assert.equal(row.predicted_value.history[0].model_version, 'ext:acme-v3');
});

test('re-posting the same score changes nothing', async () => {
  const sb = fakeSupabase();
  await writeExternalScore(sb, WS, P, { score: 55, scorer: 'acme-v3' });
  const r = await writeExternalScore(sb, WS, P, { score: 55, scorer: 'acme-v3' });
  assert.equal(r.status, 'unchanged');
  assert.equal(sb.tables.predictions[0].predicted_value.history, undefined);
});

test('a resolved bet is never touched; a new score stakes a fresh one', async () => {
  const sb = fakeSupabase({ predictions: [{
    id: 'old', workspace_id: WS, entity_id: P, kind: 'icp_fit', resolved_at: '2026-09-01T00:00:00Z',
    predicted_value: { score: 40 }, model_version: 'sc_x',
  }] });
  const r = await writeExternalScore(sb, WS, P, { score: 90, scorer: 'acme-v3' });
  assert.equal(r.status, 'staked');
  assert.equal(sb.tables.predictions.find(p => p.id === 'old').predicted_value.score, 40);
});

test('Nous never stakes beside an external scorer', async () => {
  const sb = fakeSupabase({ workspaces: [{ id: WS, icp_scorer: 'external' }] });
  const signals = [{ key: 's', weight: 8, active: true, rule: { feature: 'seniority', op: 'exists' } }];
  assert.equal(await scoreAndStake(sb, WS, P, signals), null);
  assert.equal((sb.tables.predictions ?? []).length, 0);
});

test('neither re-score path overwrites an external score', async () => {
  const sb = fakeSupabase({ workspaces: [{ id: WS }], scorecard_signals: [] });
  await writeExternalScore(sb, WS, P, { score: 30, scorer: 'acme-v3' });
  const signals = [{ key: 's', label: 's', weight: 8, active: true, rule: { feature: 'seniority', op: 'exists' } }];

  const one = await rescoreEntityFromClaims(sb, WS, P, { signals });
  assert.equal(one.status, 'external');

  sb.tables.scorecard_signals.push({ workspace_id: WS, ...signals[0] });
  await rescoreOpenPredictions(sb, WS, { force: true });
  const [row] = sb.tables.predictions;
  assert.equal(row.predicted_value.score, 30);
  assert.equal(row.model_version, 'ext:acme-v3');
});
