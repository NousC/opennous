// When a HubSpot field changes (GET-781): read from HubSpot's own field history, one change per
// history entry inside the window, filtered by the value it changes to or from.
//
// Run: pnpm --filter @nous/core build && node --test packages/core/test/hubspotFieldTrigger.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesFromHistory, changeText } from '../dist/services/hubspotFieldTrigger.mjs';

const since = Date.parse('2026-10-08T12:00:00Z');
const history = [
  { value: 'Active', timestamp: '2026-10-08T12:20:00Z' },
  { value: 'Pending', timestamp: '2026-10-08T12:05:00Z' },
  { value: 'Not started', timestamp: '2026-09-01T10:00:00Z' },
];

test('each entry inside the window is a change, with the value before it', () => {
  assert.deepEqual(changesFromHistory(history, { since }).map(c => [c.old, c.new]), [['Pending', 'Active'], ['Not started', 'Pending']]);
});

test('changes to or from a value keep only those; a re-save of the same value is not a change', () => {
  assert.deepEqual(changesFromHistory(history, { since, to: 'active' }).map(c => c.new), ['Active']);
  assert.deepEqual(changesFromHistory(history, { since, from: 'Not started' }).map(c => c.new), ['Pending']);
  assert.equal(changesFromHistory([{ value: 'A', timestamp: '2026-10-08T12:30:00Z' }, { value: 'A', timestamp: '2026-10-08T12:10:00Z' }], { since: Date.parse('2026-10-08T12:15:00Z') }).length, 0);
});

test('the change in words, the way {{signal.text}} reads it', () => {
  assert.equal(changeText({ property: 'onboarding_status', property_label: 'Onboarding Status' }, { name: 'Acme Corp', old: 'Pending', new: 'Active' }),
    'Acme Corp: Onboarding Status changed from "Pending" to "Active".');
  assert.equal(changeText({ property: 'x' }, { name: null, old: null, new: 'Yes' }), 'x changed from (empty) to "Yes".');
});

test('a date field reads as a date, not a timestamp', () => {
  assert.equal(changeText({ property: 'last_login_date', property_label: 'Last Login Date' }, { name: 'Globex', old: '1790985600000', new: '1791331200000' }),
    'Globex: Last Login Date changed from "2026-10-03" to "2026-10-07".');
});
