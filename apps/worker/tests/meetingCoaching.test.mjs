import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingCoaching } from '../src/intelligence/jobs/meetingCoaching.mjs';

// meeting.coaching — the content plugin that learns which on-call behavior advances
// the deal, from OUR own transcripts. These tests exercise the real learn()/recommend()
// against a fixture graph through a minimal fake Supabase, with call labels pre-seeded
// in ri_behaviors so no Anthropic call is made (deterministic, offline).

const WS = 'ws_test';
const DAY = 86_400_000;
const filler = 'transcript line. '.repeat(30); // > MIN_TRANSCRIPT_CHARS

function makeDb(now) {
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const claims = [], labels = [], observations = [];
  const L = (nextStep) => JSON.stringify({
    next_step_set: nextStep, multithreaded: true, discovery_done: true,
    pricing_early: false, rep_dominated: false, call_summary: 'x',
  });
  // 10 calls, 20 days ago (inside the 180d lookback AND the 30d recommend window).
  // next_step_set true on c1..c5 (4/5 advance), false on c6..c10 (1/5 advance) →
  // next_step_set is the sole eligible lever: right 0.8, wrong 0.2, lift 0.6.
  const add = (id, entity, nextStep, advanced) => {
    const at = iso(20 * DAY);
    claims.push({ id, workspace_id: WS, entity_id: entity, property: `note.${id}`, invalid_at: null, valid_from: at, computed_at: at, last_observed_at: at, value: { content: filler, metadata: { doc_type: 'transcript' } } });
    labels.push({ workspace_id: WS, subject_type: 'call', subject_id: id, behavior_key: 'meeting.behaviors', value_text: L(nextStep), extractor_version: 1 });
    if (advanced) observations.push({ workspace_id: WS, entity_id: entity, property: 'interaction.meeting_scheduled', observed_at: iso(15 * DAY) });
  };
  add('c1', 'p1', true, true); add('c2', 'p2', true, true); add('c3', 'p3', true, true);
  add('c4', 'p4', true, true); add('c5', 'p5', true, false);
  add('c6', 'p6', false, true);   // advanced → excluded from recommend
  add('c7', 'p7', false, false); add('c8', 'p8', false, false);
  add('c9', 'p9', false, false); add('c10', 'p10', false, false);
  return { claims, ri_behaviors: labels, observations, ri_observations: [], contacts: [] };
}

const likeToRe = (p) => new RegExp('^' + p.replace(/[.]/g, '\\.').replace(/%/g, '.*') + '$');
function fakeSupabase(db) {
  function builder(table) {
    let rows = [...(db[table] ?? [])];
    const api = {
      select() { return api; },
      eq(c, v) { rows = rows.filter((r) => r[c] === v); return api; },
      like(c, p) { const re = likeToRe(p); rows = rows.filter((r) => re.test(r[c] ?? '')); return api; },
      is(c, v) { rows = rows.filter((r) => (r[c] ?? null) === v); return api; },
      in(c, arr) { rows = rows.filter((r) => arr.includes(r[c])); return api; },
      gte(c, v) { rows = rows.filter((r) => r[c] >= v); return api; },
      gt(c, v) { rows = rows.filter((r) => r[c] > v); return api; },
      order(c, o) { rows.sort((a, b) => (a[c] < b[c] ? -1 : 1) * (o?.ascending ? 1 : -1)); return api; },
      limit(n) { rows = rows.slice(0, n); return api; },
      upsert(newRows) { db[table].push(...(Array.isArray(newRows) ? newRows : [newRows])); return { select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }), then: (res) => res({ error: null }) }; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then(resolve) { resolve({ data: rows, error: null }); },
    };
    return api;
  }
  return { from: (t) => builder(t) };
}

test('learn() finds the winning on-call behavior with the right rates', async () => {
  const db = makeDb(Date.now());
  const results = await meetingCoaching.learn({ supabase: fakeSupabase(db), workspaceId: WS });
  assert.equal(results.length, 1);
  const obs = results[0];
  assert.equal(obs.sampleSize, 10);
  assert.equal(obs.evidence.advanced, 5);
  assert.equal(obs.confidence, 'low');           // 8 <= 10 < 20
  assert.equal(obs.evidence.best_lever.key, 'next_step_set');
  assert.equal(obs.evidence.best_lever.rate_right, 0.8);
  assert.equal(obs.evidence.best_lever.rate_wrong, 0.2);
  assert.equal(obs.evidence.best_lever.lift, 0.6);
  const eligible = obs.evidence.by_behavior.filter((b) => b.eligible).map((b) => b.key);
  assert.deepEqual(eligible, ['next_step_set']);  // the only behavior with >=3 calls each way
});

test('learn() stays silent below MIN_SAMPLE (no fake number)', async () => {
  const db = makeDb(Date.now());
  db.claims = db.claims.slice(0, 5);             // only 5 calls
  const results = await meetingCoaching.learn({ supabase: fakeSupabase(db), workspaceId: WS });
  assert.deepEqual(results, []);
});

test('recommend() flags accounts that missed the lever, skips advanced/right ones', async () => {
  const db = makeDb(Date.now());
  const [obs] = await meetingCoaching.learn({ supabase: fakeSupabase(db), workspaceId: WS });
  db.ri_observations.push({ id: 'obs1', workspace_id: WS, question_key: 'meeting.coaching', category: 'meeting', status: 'active', evidence: { best_lever: obs.evidence.best_lever } });

  const recs = await meetingCoaching.recommend({ supabase: fakeSupabase(db), workspaceId: WS });
  const targets = recs.map((r) => r.targetId).sort();
  assert.deepEqual(targets, ['p10', 'p7', 'p8', 'p9']);  // p6 advanced, p1..p5 set a next step
  assert.match(recs[0].text, /didn't lock a next step/);
  assert.equal(recs[0].category, 'meeting');
  assert.equal(recs[0].recKey, 'meeting.coaching');
});

test('recommend() returns nothing until an active lever is learned', async () => {
  const db = makeDb(Date.now());   // ri_observations empty → no active observation
  const recs = await meetingCoaching.recommend({ supabase: fakeSupabase(db), workspaceId: WS });
  assert.deepEqual(recs, []);
});
