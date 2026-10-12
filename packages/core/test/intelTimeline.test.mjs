// The intel timeline (GET-794): an account's facts on a time axis by when they were SAID, in topic
// lanes, with a link from each retired fact to the one that replaced it (GET-770).
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/intelTimeline.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountIntelTimeline, TIMELINE_LANES } from '../dist/db/intelTimeline.js';

const CO = 'co-1', DANA = 'p-dana', SAM = 'p-sam';
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

const claim = (id, entity_id, category, content, valid_from, { metadata = {}, invalid_at = null, source = 'signal_extraction' } = {}) => ({
  id, workspace_id: 'ws', entity_id, property: `note.${id}`,
  value: { category, content, source, metadata },
  confidence: 0.8, valid_from, computed_at: valid_from, invalid_at, supporting_observation_ids: [],
});

const ROWS = [
  // A timeline that moved: "needs more time" retired by "ready to present".
  claim('t1', CO, 'timeline', 'Acme needs this pace for another couple of months.', ago(9),
    { invalid_at: ago(1), metadata: { superseded_by: 'b1', superseded_reason: 'updated', quote: 'another couple of months', speaker: 'Dana Reyes' } }),
  claim('b1', DANA, 'buying_signal', 'Dana Reyes is ready to present to the other stakeholders.', ago(1),
    { metadata: { supersedes: 't1' } }),
  // A blocker that was resolved, still live.
  claim('k1', CO, 'blocker', 'Security review pending.', ago(20), { metadata: { status: 'resolved' } }),
  // A retired fact NOBODY replaced (a deleted note): not history, so not on the timeline.
  claim('x1', CO, 'objection', 'Too expensive.', ago(5), { invalid_at: ago(4) }),
  // Bookkeeping: a document, a summary, a speaker link. Never facts.
  claim('d1', CO, 'meeting_notes', 'Call notes', ago(3), { metadata: { doc_type: 'meeting_notes' }, source: 'fireflies' }),
  claim('s1', CO, 'risk_signal', 'Health summary', ago(3), { metadata: { summary: true } }),
  // A personal fact on a person: stays on the person, not the account.
  claim('g1', SAM, 'goal', 'Sam wants better lead quality.', ago(2)),
  // A category with no lane on the timeline.
  claim('f1', CO, 'firmographic', 'Acme has 12 locations.', ago(2)),
  // Older than a 30-day window.
  claim('o1', SAM, 'tech_stack', 'Acme runs Lumen CRM.', ago(60)),
  claim('a1', SAM, 'authority', 'Sam signs off on tooling.', ago(6)),
];

function fakeSupabase() {
  return {
    from() {
      const f = [];
      const q = {
        select() { return q; },
        eq(col, v) { f.push(r => r[col] === v); return q; },
        not(col, op, v) { f.push(r => (col === 'value->>category' ? r.value.category : r[col]) !== v); return q; },
        like(col, pat) { const p = pat.replace('%', ''); f.push(r => String(r[col]).startsWith(p)); return q; },
        is(col, v) { f.push(r => (col === 'value->metadata->>doc_type' ? (r.value.metadata?.doc_type ?? null) : r[col]) === v); return q; },
        in(col, vs) { f.push(r => vs.includes(r[col])); return q; },
        gte(col, v) { f.push(r => String(r[col]) >= v); return q; },
        order() { return q; },
        range() { return q; },
        then(res, rej) { return Promise.resolve({ data: ROWS.filter(r => f.every(fn => fn(r))), error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

test('facts sit in topic lanes, oldest first; documents, bookkeeping, personal and unlaned facts stay out', async () => {
  const t = await accountIntelTimeline(fakeSupabase(), 'ws', CO, [DANA, SAM]);
  assert.deepEqual(t.facts.map(f => f.id), ['o1', 'k1', 't1', 'a1', 'b1']);
  const lane = Object.fromEntries(t.facts.map(f => [f.id, f.lane]));
  assert.equal(lane.b1, 'buying');
  assert.equal(lane.t1, 'timeline');
  assert.equal(lane.k1, 'blockers');
  assert.equal(lane.a1, 'stakeholders');
  assert.equal(lane.o1, 'tech');
  assert.deepEqual(t.lanes.map(l => l.key), TIMELINE_LANES.map(l => l.key));
});

test('a superseded fact is kept as history and linked to what replaced it; an unreplaced retired fact is not', async () => {
  const t = await accountIntelTimeline(fakeSupabase(), 'ws', CO, [DANA, SAM]);
  const by = Object.fromEntries(t.facts.map(f => [f.id, f]));
  assert.equal(by.t1.live, false);
  assert.equal(by.t1.superseded_by, 'b1');
  assert.equal(by.b1.live, true);
  assert.equal(by.b1.supersedes, 't1');
  assert.equal(by.x1, undefined);
  assert.deepEqual(t.links, [{ from: 't1', to: 'b1' }]);
});

test('each fact carries its quote, speaker, status and who voiced it', async () => {
  const t = await accountIntelTimeline(fakeSupabase(), 'ws', CO, [DANA, SAM]);
  const by = Object.fromEntries(t.facts.map(f => [f.id, f]));
  assert.equal(by.t1.quote, 'another couple of months');
  assert.equal(by.t1.speaker, 'Dana Reyes');
  assert.equal(by.k1.status, 'resolved');
  assert.equal(by.b1.voiced_by_contact_id, DANA);
  assert.equal(by.b1.entity_id, DANA);
  assert.ok(by.b1.said_at);
});

test('a window keeps only what was said inside it', async () => {
  const t = await accountIntelTimeline(fakeSupabase(), 'ws', CO, [DANA, SAM], { sinceDays: 30 });
  assert.deepEqual(t.facts.map(f => f.id), ['k1', 't1', 'a1', 'b1']);
  assert.ok(t.since);
});

test('a link needs both ends on the timeline', async () => {
  // Without Dana, the replacement is not on this account's timeline: the old fact stays, unlinked.
  const t = await accountIntelTimeline(fakeSupabase(), 'ws', CO, [SAM]);
  assert.ok(t.facts.some(f => f.id === 't1'));
  assert.deepEqual(t.links, []);
});
