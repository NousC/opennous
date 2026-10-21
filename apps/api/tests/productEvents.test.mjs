// Our own product events (GET-820): only the events in the tracking plan are sent, with the
// user's id as the distinct id, and the person's email and name set on the person only.
//
// Run: node --test apps/api/tests/productEvents.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productEventBody, PRODUCT_EVENTS } from '../src/lib/productEvents.mjs';

const at = new Date('2026-10-19T12:00:00Z');

test('a signup carries the user id, the workspace, and the person fields as $set', () => {
  const b = productEventBody({ distinctId: 'u-1', event: 'signed_up', set: { email: 'sorrel@harborline.example', name: 'Sorrel Pike' }, workspaceId: 'ws-1', at }, 'phc_test');
  assert.deepEqual(b, {
    api_key: 'phc_test', event: 'signed_up', distinct_id: 'u-1', timestamp: '2026-10-19T12:00:00.000Z',
    properties: { $lib: 'opennous-api', workspace_id: 'ws-1', $set: { email: 'sorrel@harborline.example', name: 'Sorrel Pike' } },
  });
});

test('an event outside the plan, or with no user, is not sent', () => {
  assert.equal(productEventBody({ distinctId: 'u-1', event: 'transcript_read', at }, 'k'), null);
  assert.equal(productEventBody({ distinctId: null, event: 'signed_up', at }, 'k'), null);
});

test('every server event is in the tracking plan doc', () => {
  const doc = readFileSync(new URL('../../../docs/product-events.md', import.meta.url), 'utf8');
  for (const e of PRODUCT_EVENTS) assert.match(doc, new RegExp('`' + e + '`'), e);
});

import { firstActiveToday } from '../src/lib/productEvents.mjs';

test('app_active goes once per user per UTC day, whatever the cookie choice', () => {
  const seen = new Map();
  assert.equal(firstActiveToday('u-1', '2026-10-21', seen), true);
  assert.equal(firstActiveToday('u-1', '2026-10-21', seen), false, 'the same day again');
  assert.equal(firstActiveToday('u-2', '2026-10-21', seen), true, 'another user');
  assert.equal(firstActiveToday('u-1', '2026-10-22', seen), true, 'the next day');
  assert.equal(firstActiveToday(null, '2026-10-22', seen), false);
  assert.ok(productEventBody({ distinctId: 'u-1', event: 'app_active', at }, 'k'), 'app_active is in the plan');
});
