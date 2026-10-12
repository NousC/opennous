// The CRM agent's ranker: which open deal was this activity about. Pure; every signal is
// a hand-built candidate so the weights are testable without a database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankDealCandidates } from '../dist/services/crmAgent.js';

const deal = (over = {}) => ({
  dealEntityId: 'd', name: null, stage: null, stageId: null, status: 'open', value: null,
  closeDate: null, ownerEmail: null, roster: [], products: [], lastStageChangeAt: null, ...over,
});
const act = (over = {}) => ({ personEntityIds: [], ownerEmail: null, text: '', occurredAt: null, ...over });

test('a single open deal is proposed with high confidence and is not ambiguous', () => {
  const r = rankDealCandidates(act(), [deal({ dealEntityId: 'A' })]);
  assert.equal(r.ranked.length, 1);
  assert.equal(r.ranked[0].dealEntityId, 'A');
  assert.ok(r.ranked[0].confidence >= 0.85);
  assert.equal(r.ambiguous, false);
});

test('no candidates → empty, not ambiguous', () => {
  const r = rankDealCandidates(act(), []);
  assert.deepEqual(r.ranked, []);
  assert.equal(r.ambiguous, false);
});

test('roster separates: the deal the attendee sits on wins', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['solveig'] }),
    [deal({ dealEntityId: 'A', roster: ['marcus'] }), deal({ dealEntityId: 'B', roster: ['marcus', 'solveig'] })],
  );
  assert.equal(r.ranked[0].dealEntityId, 'B');
  assert.ok(r.ranked[0].reasons.some(s => /roster|attendee/i.test(s)));
  assert.equal(r.ambiguous, false);
});

test('a shared stakeholder separates nothing; product named in the text does', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['marcus'], text: 'Discussed pricing for the Analytics Add-on rollout' }),
    [
      deal({ dealEntityId: 'A', name: 'Platform Rollout', roster: ['marcus'], products: ['Core Platform'] }),
      deal({ dealEntityId: 'B', name: 'Analytics Add-on', roster: ['marcus'], products: ['Analytics Add-on'] }),
    ],
  );
  assert.equal(r.ranked[0].dealEntityId, 'B');
  assert.equal(r.ambiguous, false);
});

test('owner match counts when the activity carries an owner email', () => {
  const r = rankDealCandidates(
    act({ ownerEmail: 'ae2@x.example' }),
    [deal({ dealEntityId: 'A', ownerEmail: 'ae1@x.example' }), deal({ dealEntityId: 'B', ownerEmail: 'AE2@x.example' })],
  );
  assert.equal(r.ranked[0].dealEntityId, 'B');
});

test('two deals and nothing to separate them → ambiguous, equal confidence', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['marcus'] }),
    [deal({ dealEntityId: 'A', roster: ['marcus'] }), deal({ dealEntityId: 'B', roster: ['marcus'] })],
  );
  assert.equal(r.ambiguous, true);
  assert.equal(r.ranked[0].confidence, r.ranked[1].confidence);
});

test('recency is a tiebreaker only: it never beats a real signal', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['solveig'] }),
    [
      deal({ dealEntityId: 'A', roster: ['marcus'], lastStageChangeAt: '2026-09-14T00:00:00Z' }),
      deal({ dealEntityId: 'B', roster: ['solveig'], lastStageChangeAt: '2026-01-01T00:00:00Z' }),
    ],
  );
  assert.equal(r.ranked[0].dealEntityId, 'B');
});

test('closed deals are never candidates', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['solveig'] }),
    [deal({ dealEntityId: 'A', status: 'won', roster: ['solveig'] }), deal({ dealEntityId: 'B', status: 'open' })],
  );
  assert.deepEqual(r.ranked.map(x => x.dealEntityId), ['B']);
});

test('confidences sum to about 1 across the ranked set', () => {
  const r = rankDealCandidates(
    act({ personEntityIds: ['p'], text: 'core platform' }),
    [deal({ dealEntityId: 'A', roster: ['p'] }), deal({ dealEntityId: 'B', products: ['Core Platform'] }), deal({ dealEntityId: 'C' })],
  );
  const sum = r.ranked.reduce((s, x) => s + x.confidence, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `sum=${sum}`);
});
