import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampWithinDays, toPct, driverLabel, describeDrivers, shapeHealth, modelNotes, timingLabel,
  oddsBasis, ordinal, splitDrivers,
} from '../src/lib/dealOutlook.mjs';

// The deal outlook's words. Pure: the numbers come from @nous/core; this is how they are said
// to an agent, which then says them to a rep. No DB.

const deal = {
  stage: 'negotiation', daysInStage: 41.6, medianDaysInStage: 20.2,
  facts: {
    daysQuiet: 22.4, engagementTrend: 'cooling', stakeholderCount: 3, engagedCount: 1,
    openObjections: 2, competitorPresent: true, inbound: false, icpFit: 88, icpPain: null,
    icpAbility: null, intentScore: null,
  },
  drivers: [
    { key: 'open_objections', x: 2, logit: -0.24, pts: -5.9 },
    { key: 'icp_fit', x: 0.76, logit: 0.152, pts: 3.4 },
    { key: 'age_ratio', x: 1.06, logit: -0.106, pts: -2.6 },
    { key: 'inbound', x: 1, logit: 0.1, pts: 0.04 },
  ],
};

test('within_days defaults to 30 and stays inside a year', () => {
  assert.equal(clampWithinDays(undefined), 30);
  assert.equal(clampWithinDays('abc'), 30);
  assert.equal(clampWithinDays(0), 30);
  assert.equal(clampWithinDays('14'), 14);
  assert.equal(clampWithinDays(9999), 365);
});

test('percentages: whole numbers, one decimal under 1%, unknown stays null', () => {
  assert.equal(toPct(0.4567), 46);
  assert.equal(toPct(0.0033), 0.3);
  assert.equal(toPct(null), null);
});

test('drivers read as direction, points and the fact behind them', () => {
  assert.deepEqual(describeDrivers(deal), [
    '-6 pts 2 open objections',
    '+3 pts ICP fit 88',
    '-3 pts 42d in negotiation (typical 20d)',
    '+<0.1 pts came in inbound',
  ]);
  assert.equal(describeDrivers(deal, 1).length, 1);
  assert.equal(driverLabel('single_threaded', { facts: { engagedCount: 0 } }), 'nobody engaged in the last 45 days');
});

test('list health keeps only what is not fine; one account gets every signal', () => {
  const dh = {
    score: 48, band: 'Needs attention',
    smart: [
      { key: 'competitive_risk', label: 'Competitive Risk', level: 'High', tone: 'bad', reason: '2 live competitors: Clay, Apollo' },
      { key: 'decision_maker', label: 'Decision-Maker Buy-In', level: 'Strong', tone: 'good', reason: '1 senior stakeholder engaged' },
    ],
    numeric: [{ key: 'last_response', label: 'Last Response', value: 'Aug 20', tone: 'warn' }],
  };
  assert.deepEqual(shapeHealth(dh), {
    score: 48, band: 'Needs attention', watch: ['Competitive Risk High: 2 live competitors: Clay, Apollo'],
  });
  const full = shapeHealth(dh, { full: true });
  assert.equal(full.signals.length, 2);
  assert.deepEqual(full.engagement, { last_response: 'Aug 20' });
  assert.equal(shapeHealth(null), null);
});

test('timing says plainly when "within N days" could not be judged', () => {
  assert.equal(timingLabel({ timingBasis: 'judged' }), 'judged');
  assert.equal(timingLabel({ timingBasis: 'too_few_wins', timingWins: 3, stage: 'meeting_booked' }),
    'not judged: only 3 won deals from meeting booked to learn timing from');
  assert.equal(timingLabel({ timingBasis: 'no_history', stage: 'demo' }),
    'not judged: no won deals from demo to learn timing from');
  assert.equal(timingLabel({ timingBasis: 'past_history', stage: 'negotiation', timingLastWinDay: 14.6, daysInStage: 15.2 }),
    'not judged: every won deal here closed within 15d of reaching negotiation, and this one has been there 15d');
});

test('the notes say when the numbers rest on assumptions', () => {
  // Default weights: no percentage is shown, so one note says why there is a rank instead.
  const dflt = modelNotes({ winModel: { basis: 'default' }, stageRatesBasis: 'prior' });
  assert.equal(dflt.length, 1);
  assert.match(dflt[0], /rank among the open deals, not a percentage/);
  assert.doesNotMatch(dflt[0], /weights|ranking, not a promise/);
  assert.equal(modelNotes({ winModel: { basis: 'fitted' }, stageRatesBasis: 'prior' }).length, 1);
  assert.deepEqual(modelNotes({ winModel: { basis: 'fitted' }, stageRatesBasis: 'learned' }), []);
});

test('odds are a rank until the win model is fitted on the workspace (GET-832)', () => {
  assert.equal(oddsBasis({ winModel: { basis: 'default' } }), 'rank');
  assert.equal(oddsBasis({}), 'rank');
  assert.equal(oddsBasis({ winModel: { basis: 'fitted' } }), 'percent');
});

test('ordinals read like a person says them', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 103, 111].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd', '111th']);
});

test('drivers split into what helps and what hurts, in plain words, tiny ones dropped', () => {
  assert.deepEqual(splitDrivers(deal), {
    helping: ['ICP fit 88'],
    hurting: ['2 open objections', '42d in negotiation (typical 20d)'],
  });
  assert.deepEqual(splitDrivers({ drivers: [] }), { helping: [], hurting: [] });
});
