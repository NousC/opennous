import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePipelineWeek, joinWeekDeals, dealsAtRisk } from '../dist/db/pipelineWeek.js';

// Monday 21 Sep 2026 00:00 → Saturday 26 Sep 2026 12:00.
const since = new Date('2026-09-21T00:00:00Z');
const now = new Date('2026-09-26T12:00:00Z');
const stages = new Map([
  ['disc', { sortOrder: 0, kind: 'active' }],
  ['demo', { sortOrder: 1, kind: 'active' }],
  ['prop', { sortOrder: 2, kind: 'active' }],
  ['won', { sortOrder: 3, kind: 'won' }],
  ['lost', { sortOrder: 4, kind: 'lost' }],
]);
const hop = (entity_id, stage, observed_at) => ({ entity_id, value: stage, observed_at, raw: { stage_id: stage } });

test('each line counts a deal once, by what it did inside the week', () => {
  const stageRows = [
    hop('created', 'disc', '2026-09-22T10:00:00Z'),                                            // new
    hop('advanced', 'disc', '2026-08-01T10:00:00Z'), hop('advanced', 'prop', '2026-09-23T10:00:00Z'), // moved up
    hop('backwards', 'prop', '2026-08-01T10:00:00Z'), hop('backwards', 'demo', '2026-09-23T10:00:00Z'), // not up
    hop('closed', 'prop', '2026-08-01T10:00:00Z'), hop('closed', 'won', '2026-09-24T10:00:00Z'),        // won
    hop('dead', 'demo', '2026-08-01T10:00:00Z'), hop('dead', 'lost', '2026-09-25T10:00:00Z'),          // lost
    hop('quiet', 'demo', '2026-08-01T10:00:00Z'),                                                // untouched
  ];
  const w = summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now });
  assert.deepEqual({ new: w.new, moved_up: w.moved_up, won: w.won, lost: w.lost }, { new: 1, moved_up: 1, won: 1, lost: 1 });
  assert.equal(w.has_history, true);
});

test('a deal created and advanced in the same week is new, not moved up', () => {
  const stageRows = [hop('fast', 'disc', '2026-09-21T09:00:00Z'), hop('fast', 'prop', '2026-09-24T09:00:00Z')];
  const w = summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now });
  assert.equal(w.new, 1);
  assert.equal(w.moved_up, 0);
});

test('won and lost fall back to the verdict on the observation when the stage is unknown', () => {
  const stageRows = [
    { entity_id: 'x', value: 'Closed', observed_at: '2026-08-01T00:00:00Z', raw: { stage_id: 'unknown-open', status: 'open' } },
    { entity_id: 'x', value: 'Closed Won', observed_at: '2026-09-22T00:00:00Z', raw: { stage_id: 'unknown-won', status: 'won' } },
  ];
  assert.equal(summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now }).won, 1);
});

test('slipped: a close date pushed later this week, or passed this week while still open, once per deal', () => {
  const closeRows = [
    { entity_id: 'pushed', value: '2026-09-30', observed_at: '2026-08-01T00:00:00Z' },
    { entity_id: 'pushed', value: '2026-10-31', observed_at: '2026-09-22T00:00:00Z' },
    { entity_id: 'pulled', value: '2026-10-31', observed_at: '2026-08-01T00:00:00Z' },
    { entity_id: 'pulled', value: '2026-09-30', observed_at: '2026-09-22T00:00:00Z' },
  ];
  const openDeals = [
    { entity_id: 'passed', close_date: '2026-09-23' },
    { entity_id: 'pushed', close_date: '2026-09-24' },
    { entity_id: 'future', close_date: '2026-10-15' },
    { entity_id: 'old', close_date: '2026-09-01' },
  ];
  assert.equal(summarizePipelineWeek({ stageRows: [], closeRows, stages, openDeals, since, now }).slipped, 2);
});

test('no stage rows means no history, reported as such', () => {
  assert.equal(summarizePipelineWeek({ stageRows: [], closeRows: [], stages, openDeals: [], since, now }).has_history, false);
});

// ── The deals behind each count (Home opens a number onto its rows) ─────────────────────────

const ids = (list) => list.map((d) => d.id).sort();

test('every count is the length of the list of deals that make it', () => {
  const stageRows = [
    hop('created', 'disc', '2026-09-22T10:00:00Z'),
    hop('advanced', 'disc', '2026-08-01T10:00:00Z'), hop('advanced', 'prop', '2026-09-23T10:00:00Z'),
    hop('closed', 'prop', '2026-08-01T10:00:00Z'), hop('closed', 'won', '2026-09-24T10:00:00Z'),
    hop('dead', 'demo', '2026-08-01T10:00:00Z'), hop('dead', 'lost', '2026-09-25T10:00:00Z'),
  ];
  const closeRows = [
    { entity_id: 'pushed', value: '2026-09-30', observed_at: '2026-08-01T00:00:00Z' },
    { entity_id: 'pushed', value: '2026-10-31', observed_at: '2026-09-22T00:00:00Z' },
  ];
  const w = summarizePipelineWeek({ stageRows, closeRows, stages, openDeals: [{ entity_id: 'passed', close_date: '2026-09-23' }], since, now });
  for (const b of ['new', 'moved_up', 'won', 'lost', 'slipped']) assert.equal(w[b], w.deals[b].length, b);
  assert.deepEqual(ids(w.deals.new), ['created']);
  assert.deepEqual(ids(w.deals.moved_up), ['advanced']);
  assert.deepEqual(ids(w.deals.won), ['closed']);
  assert.deepEqual(ids(w.deals.lost), ['dead']);
  assert.deepEqual(ids(w.deals.slipped), ['passed', 'pushed']);
});

test('from/to: stage labels for moved up, won and lost; null for new', () => {
  const stageRows = [
    hop('created', 'disc', '2026-09-22T10:00:00Z'),
    hop('advanced', 'disc', '2026-08-01T10:00:00Z'), hop('advanced', 'demo', '2026-09-22T10:00:00Z'), hop('advanced', 'prop', '2026-09-23T10:00:00Z'),
    hop('closed', 'prop', '2026-08-01T10:00:00Z'), hop('closed', 'won', '2026-09-24T10:00:00Z'),
  ];
  const w = summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now });
  assert.deepEqual(w.deals.new[0], { id: 'created', from: null, to: null });
  // Measured from where the week STARTED, not the hop in between: disc to prop, not demo to prop.
  assert.deepEqual(w.deals.moved_up[0], { id: 'advanced', from: 'disc', to: 'prop' });
  assert.deepEqual(w.deals.won[0], { id: 'closed', from: 'prop', to: 'won' });
});

test('a deal created and won inside the week closed from a real stage, and is on both lines', () => {
  const stageRows = [hop('quick', 'demo', '2026-09-21T09:00:00Z'), hop('quick', 'won', '2026-09-25T09:00:00Z')];
  const w = summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now });
  assert.deepEqual(w.deals.new, [{ id: 'quick', from: null, to: null }]);
  assert.deepEqual(w.deals.won, [{ id: 'quick', from: 'demo', to: 'won' }]);
});

test('a deal won with no earlier hop on record has no from', () => {
  const stageRows = [hop('cold', 'won', '2026-09-22T09:00:00Z')];
  assert.deepEqual(summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now }).deals.won, [{ id: 'cold', from: null, to: 'won' }]);
});

test('slipped: the old and new close day for a push, the passed day and no new one for a lapse', () => {
  const closeRows = [
    { entity_id: 'pushed', value: '2026-09-30T00:00:00Z', observed_at: '2026-08-01T00:00:00Z' },
    { entity_id: 'pushed', value: '2026-10-31T00:00:00-04:00', observed_at: '2026-09-22T00:00:00Z' },
  ];
  const openDeals = [
    { entity_id: 'passed', close_date: '2026-09-23T00:00:00+00:00' },
    // Pushed AND lapsed: counted once, as the push, which says more.
    { entity_id: 'pushed', close_date: '2026-09-24' },
  ];
  const w = summarizePipelineWeek({ stageRows: [], closeRows, stages, openDeals, since, now });
  const byId = Object.fromEntries(w.deals.slipped.map((d) => [d.id, d]));
  assert.equal(w.slipped, 2);
  // The calendar day as written, not shifted through UTC.
  assert.deepEqual(byId.pushed, { id: 'pushed', from: '2026-09-30', to: '2026-10-31' });
  assert.deepEqual(byId.passed, { id: 'passed', from: '2026-09-23', to: null });
});

test('slipped: the same close day re-saved at another hour or offset is not a slip', () => {
  // Seen on live data: HubSpot re-stamped Nov 27 midnight Eastern as Nov 27 05:00 UTC. The instant
  // moved, the date did not, and the week read "slipped Nov 27 → Nov 27".
  const closeRows = [
    { entity_id: 'restamp', value: '2026-11-27T00:00:00-05:00', observed_at: '2026-08-01T00:00:00Z' },
    { entity_id: 'restamp', value: '2026-11-27T05:00:00Z', observed_at: '2026-09-22T00:00:00Z' },
  ];
  const w = summarizePipelineWeek({ stageRows: [], closeRows, stages, openDeals: [], since, now });
  assert.equal(w.slipped, 0);
});

test('an object-shaped stage value still reads as its label', () => {
  const stageRows = [
    { entity_id: 'x', value: { value: 'Discovery' }, observed_at: '2026-08-01T00:00:00Z', raw: { stage_id: 'disc' } },
    { entity_id: 'x', value: { label: 'Proposal' }, observed_at: '2026-09-22T00:00:00Z', raw: { stage_id: 'prop' } },
  ];
  assert.deepEqual(summarizePipelineWeek({ stageRows, closeRows: [], stages, openDeals: [], since, now }).deals.moved_up, [{ id: 'x', from: 'Discovery', to: 'Proposal' }]);
});

// ── joinWeekDeals: ids to what Home draws ─────────────────────────────────────────────────────

const week = () => summarizePipelineWeek({
  stageRows: [
    hop('a', 'disc', '2026-08-01T10:00:00Z'), hop('a', 'prop', '2026-09-23T10:00:00Z'),
    hop('b', 'demo', '2026-08-01T10:00:00Z'), hop('b', 'prop', '2026-09-23T10:00:00Z'),
    hop('c', 'disc', '2026-08-01T10:00:00Z'), hop('c', 'demo', '2026-09-23T10:00:00Z'),
    hop('l', 'demo', '2026-08-01T10:00:00Z'), hop('l', 'lost', '2026-09-25T10:00:00Z'),
  ],
  closeRows: [], stages, openDeals: [], since, now,
});
// listDealRows' MAPPED shape: `value`, `id`, `company_name`. Not pipeline_value / entity_id.
const rows = new Map([
  ['a', { id: 'a', name: 'Alpha renewal', company_id: 'co1', company_name: 'Alpha Co', value: 12000, owner_name: 'Alba' }],
  ['b', { id: 'b', name: 'Beta pilot', company_id: 'co2', company_name: 'Beta Co', value: '30000', owner_name: 'Bram' }],
  ['c', { id: 'c', name: 'Gamma', company_id: 'co3', company_name: 'Gamma Co', value: null, owner_name: 'Alba' }],
  ['l', { id: 'l', name: 'Lost one', company_id: 'co4', company_name: 'Lost Co', value: 5000, owner_name: 'Bram' }],
]);

test('join: names, account and amount from the mapped rows; each line summed; biggest first', () => {
  const v = joinWeekDeals(week(), rows);
  assert.equal(v.moved_up, 3);
  assert.equal(v.value.moved_up, 42000);              // 12000 + "30000" + null
  assert.deepEqual(v.deals.moved_up.map((d) => d.id), ['b', 'a', 'c']);
  assert.deepEqual(v.deals.moved_up[0], { id: 'b', company_id: 'co2', name: 'Beta pilot', account: 'Beta Co', value: 30000, from: 'demo', to: 'prop' });
  assert.deepEqual(v.deals.lost[0], { id: 'l', company_id: 'co4', name: 'Lost one', account: 'Lost Co', value: 5000, from: 'demo', to: 'lost' });
  assert.equal(v.value.new, 0);
  assert.equal(v.has_history, true);
});

test('join without a scope leaves every count exactly as summarized, even for a deal with no row', () => {
  const w = week();
  const v = joinWeekDeals(w, new Map([['a', rows.get('a')]]));
  for (const b of ['new', 'moved_up', 'won', 'lost', 'slipped']) assert.equal(v[b], w[b], b);
  const missing = v.deals.moved_up.find((d) => d.id === 'b');
  assert.deepEqual(missing, { id: 'b', company_id: null, name: null, account: null, value: null, from: 'demo', to: 'prop' });
});

test('join with a scope counts only the deals in it, and sums only those', () => {
  const v = joinWeekDeals(week(), rows, { inScope: (id) => rows.get(id)?.owner_name === 'Alba' });
  assert.equal(v.moved_up, 2);
  assert.equal(v.lost, 0);
  assert.equal(v.value.moved_up, 12000);
  assert.deepEqual(v.deals.moved_up.map((d) => d.id), ['a', 'c']);
});

test('join cuts a long line to the limit but the money is the whole line', () => {
  const v = joinWeekDeals(week(), rows, { limit: 1 });
  assert.equal(v.deals.moved_up.length, 1);
  assert.equal(v.moved_up, 3);
  assert.equal(v.value.moved_up, 42000);
});

// ── dealsAtRisk ─────────────────────────────────────────────────────────────────────────────

test('at risk, the Pipeline page\'s rule: known activity 9+ days old, or a Nous health under 50 when the row has one', () => {
  const t = Date.parse('2026-10-02T12:00:00Z');
  const ago = (d) => new Date(t - d * 86_400_000).toISOString();
  const open = [
    { id: 'fresh', value: 1000, last_activity_at: ago(2) },
    { id: 'nine', value: 2000, last_activity_at: ago(9) },               // exactly 9 days: at risk
    { id: 'eight', value: 4000, last_activity_at: ago(8.9) },            // not yet
    { id: 'never', value: '8000', last_activity_at: null },              // never worked: NOT quiet
    { id: 'sick', value: 16000, last_activity_at: ago(1), health_score: 42 },
    { id: 'sickNever', value: '500', last_activity_at: null, health_score: '30' },
    { id: 'healthy', value: 32000, last_activity_at: ago(1), health_score: 80 },
    { id: 'noamount', value: null, last_activity_at: ago(30) },
  ];
  // nine, sick, sickNever and noamount; the one with no amount counts as a deal and adds nothing.
  assert.deepEqual(dealsAtRisk(open, { now: t }), { count: 4, value: 2000 + 16000 + 500 });
  assert.deepEqual(dealsAtRisk([], { now: t }), { count: 0, value: 0 });
});
