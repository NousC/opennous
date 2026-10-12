// A newer statement retires the one it replaces (GET-770).
//
// Acme, 2026-10-07: Dana said "you guys moved really fast… now I want to present it to the
// other stakeholders". On file since Sep 29, still live and fresh: "needs this turnaround for
// another couple of months, not thinking six months". Three things let the old one stand:
//   - the extractor never saw what was on file, so it could not notice the position had moved,
//     and nothing told it that readiness to take it internally is a buying signal;
//   - the merge only compared look-alike sentences (cosine ≥ 0.82) — a contradiction is not a
//     look-alike — and showed no dates, so even a compared pair could not be ordered;
//   - nothing could say "this one replaces that one" except UPDATE, which wrote no link.
//
// Run: node --test apps/worker/tests/positionShift.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivitySignalsPrompt, buildMeetingSignalsPrompt,
  resolveReplaces, mergeCandidates, buildMergePrompt, parseMergeDecisions,
} from '../src/signals/index.mjs';

const text = r => (typeof r === 'string' ? r : r.prompt);

const ON_FILE = [
  { id: 'c-goal', entity_id: 'p-dana', category: 'goal', content: 'Dana Reyes needs this turnaround for another couple of months and is not thinking in six-month terms.', said_at: '2026-09-29T15:00:00Z' },
  { id: 'c-obj', category: 'objection', content: 'Dana Reyes said the workspace is very slow.', said_at: '2026-09-28T10:00:00Z' },
];

test('the extractor is shown the dated positions on file, numbered, and asked what replaces what', () => {
  const p = text(buildActivitySignalsPrompt({ contactName: 'Dana Reyes', company: 'Acme', type: 'meeting_held', summary: 'transcript', positionsOnFile: ON_FILE }));
  assert.match(p, /ON FILE/);
  assert.match(p, /1\. \[2026-09-29\] \[goal\] Dana Reyes needs this turnaround/);
  assert.match(p, /2\. \[2026-09-28\] \[objection\]/);
  assert.match(p, /"replaces"/);
  const m = buildMeetingSignalsPrompt({ roster: '1. Dana Reyes (Acme)', transcript: 't', maxFacts: 12, positionsOnFile: ON_FILE });
  assert.match(m, /1\. \[2026-09-29\] \[goal\]/);
  assert.match(m, /"replaces"/);
});

test('the position-shift rules are always there, with or without anything on file', () => {
  for (const p of [
    text(buildActivitySignalsPrompt({ contactName: 'A', type: 'email_received', summary: 'x' })),
    buildMeetingSignalsPrompt({ roster: '1. A', transcript: 't', maxFacts: 8 }),
  ]) {
    assert.match(p, /WHEN A POSITION MOVES/);
    // Readiness to take it internally is the case that was missed.
    assert.match(p, /present it to (the )?other stakeholders/i);
    assert.match(p, /objection.*resolved/i);
    assert.match(p, /timeline/i);
    assert.doesNotMatch(p, /ON FILE/, 'no empty on-file block');
  }
});

test('resolveReplaces turns the model\'s number into the claim id, and ignores anything else', () => {
  const facts = [
    { content: 'Dana Reyes wants to present Nous to the other stakeholders.', replaces: 1 },
    { content: 'x', replaces: '2' },
    { content: 'y', replaces: 7 },
    { content: 'z', replaces: 'the goal one' },
    { content: 'w' },
  ];
  const out = resolveReplaces(facts, ON_FILE);
  assert.equal(out[0].replacesClaimId, 'c-goal');
  assert.equal(out[1].replacesClaimId, 'c-obj');
  assert.equal(out[2].replacesClaimId, undefined);
  assert.equal(out[3].replacesClaimId, undefined);
  assert.equal(out[4].replacesClaimId, undefined);
  assert.equal('replaces' in out[0], false, 'the raw number does not travel into storage');
  assert.equal(out[0].replacesEntityId, 'p-dana', 'whose record the replaced claim is on travels with it');
});

test('a time-bound fact is compared with every live claim of its category, not only look-alikes', () => {
  const similar = [{ id: 's1', content: 'Dana Reyes wants the CS module.', said_at: '2026-10-05T00:00:00Z', category: 'goal' }];
  const sameCategory = [
    { id: 'c-goal', content: ON_FILE[0].content, said_at: ON_FILE[0].said_at, category: 'goal' },
    { id: 's1', content: 'Dana Reyes wants the CS module.', said_at: '2026-10-05T00:00:00Z', category: 'goal' },
  ];
  const timeBound = mergeCandidates('goal', similar, sameCategory);
  assert.deepEqual(timeBound.map(c => c.id).sort(), ['c-goal', 's1'], 'deduped union');
  const standing = mergeCandidates('discovery', similar, sameCategory);
  assert.deepEqual(standing.map(c => c.id), ['s1'], 'a standing fact still only meets its look-alikes');
});

test('the merge prompt dates both sides and offers SUPERSEDE', () => {
  const p = buildMergePrompt([{
    fact: 'Dana Reyes wants to present Nous to the other stakeholders.', category: 'buying_signal', saidAt: '2026-10-07T18:00:00Z',
    candidates: [{ id: 'c-goal', content: ON_FILE[0].content, said_at: ON_FILE[0].said_at, category: 'goal' }],
  }]);
  assert.match(p, /NEW FACT \(said 2026-10-07, buying_signal\)/);
  assert.match(p, /\[ID:c-goal\] \(said 2026-09-29, goal\)/);
  assert.match(p, /SUPERSEDE:<ID>/);
});

test('SUPERSEDE retires the older claim; an older "new" fact is filed already retired by the newer one', () => {
  const contested = [
    { idx: 0, saidAt: '2026-10-07T18:00:00Z', candidates: [{ id: 'c-goal', said_at: '2026-09-29T15:00:00Z' }] },
    // A backfill reading June after October: the fact on file is the newer one.
    { idx: 1, saidAt: '2026-06-01T00:00:00Z', candidates: [{ id: 'c-goal', said_at: '2026-09-29T15:00:00Z' }] },
    { idx: 2, saidAt: '2026-10-07T18:00:00Z', candidates: [{ id: 'c-obj', said_at: '2026-09-28T10:00:00Z' }] },
  ];
  const d = parseMergeDecisions([
    { n: 1, decision: 'SUPERSEDE:c-goal' },
    { n: 2, decision: 'SUPERSEDE:c-goal' },
    { n: 3, decision: 'SUPERSEDE:not-offered' },
  ], contested, 3);
  assert.deepEqual(d[0], { action: 'SUPERSEDE', supersedes: 'c-goal' });
  assert.deepEqual(d[1], { action: 'ADD', supersedes: null, retiredBy: 'c-goal' });
  assert.deepEqual(d[2], { action: 'ADD', supersedes: null }, 'an id the model was not offered is ignored');
});

test('SKIP and UPDATE keep working as before', () => {
  const contested = [
    { idx: 0, saidAt: '2026-10-07T00:00:00Z', candidates: [{ id: 'a', said_at: '2026-10-01T00:00:00Z' }] },
    { idx: 1, saidAt: '2026-10-07T00:00:00Z', candidates: [{ id: 'b', said_at: '2026-10-01T00:00:00Z' }] },
  ];
  const d = parseMergeDecisions([{ n: 1, decision: 'SKIP:a' }, { n: 2, decision: 'UPDATE:b' }], contested, 2);
  assert.deepEqual(d[0], { action: 'SKIP', supersedes: null, restates: 'a' });
  assert.deepEqual(d[1], { action: 'SUPERSEDE', supersedes: 'b' });
});

test('ON FILE keeps older positions visible: a few per topic, never this conversation\'s own read', async () => {
  const { selectPositions } = await import('../src/signals/index.mjs');
  const note = (id, category, said_at, source_ref = null) => ({ id, category, content: `${id} content`, said_at, intel: true, freshness: 'fresh', metadata: source_ref ? { source_ref } : {} });
  const today = Array.from({ length: 8 }, (_, i) => note(`today-goal-${i}`, 'goal', `2026-10-08T00:0${i}:00Z`, 'source://granola/today'));
  const notes = [
    ...today,
    note('sep-goal', 'goal', '2026-09-29T15:00:00Z', 'source://fireflies/sep29'),
    note('sep-obj', 'objection', '2026-09-28T10:00:00Z'),
    note('found', 'discovery', '2026-09-01T00:00:00Z'),
    { ...note('old', 'timeline', '2026-01-01T00:00:00Z'), freshness: 'expired' },
  ];
  const ids = selectPositions(notes, { excludeSourceRef: 'source://granola/today' }).map(p => p.id);
  assert.ok(ids.includes('sep-goal'), 'the September position is shown, so it can be replaced');
  assert.ok(ids.includes('sep-obj'));
  assert.ok(!ids.some(id => id.startsWith('today-')), 'a re-read does not see its own earlier output as "on file"');
  assert.ok(!ids.includes('found') && !ids.includes('old'), 'standing and expired facts are not positions');
  const capped = selectPositions(today, {}).map(p => p.id);
  assert.equal(capped.length, 6, 'a deal topic keeps six');
  const stack = Array.from({ length: 5 }, (_, i) => note(`sq-${i}`, 'status_quo', `2026-10-0${i + 1}T00:00:00Z`));
  assert.equal(selectPositions(stack, {}).length, 2, 'standing context keeps two');
});

test('a fact with no known date never retires anything: it may be the older one', () => {
  const contested = [{ idx: 0, saidAt: null, candidates: [{ id: 'c-goal', said_at: '2026-09-29T15:00:00Z' }] }];
  const d = parseMergeDecisions([{ n: 1, decision: 'SUPERSEDE:c-goal' }], contested, 1);
  assert.deepEqual(d[0], { action: 'ADD', supersedes: null });
});

test('replaces only reaches a claim on the same person or their account', async () => {
  const { replacesAllowed } = await import('../src/signals/index.mjs');
  const fact = { contactId: 'p-alice', companyId: 'co-acme', about: 'person', replacesClaimId: 'x' };
  assert.equal(replacesAllowed({ ...fact, replacesEntityId: 'p-alice' }), true);
  assert.equal(replacesAllowed({ ...fact, replacesEntityId: 'co-acme' }), true);
  assert.equal(replacesAllowed({ ...fact, replacesEntityId: 'p-bob-othercorp' }), false, 'another account on the same call');
  assert.equal(replacesAllowed({ ...fact, replacesEntityId: undefined }), false);
});
