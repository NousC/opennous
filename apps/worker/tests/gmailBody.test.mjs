// Fetching the sent body. The guard is the test: a wrong hash is indistinguishable from a real
// edit, so anything we are not certain about must come back as null rather than as a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasOpenProposalFor } from '../src/webhooks/handlers/gmailBody.mjs';

const db = (rows) => ({
  from() {
    const c = {};
    for (const m of ['select', 'eq', 'in', 'gte']) c[m] = () => c;
    c.limit = () => Promise.resolve({ data: rows });
    return c;
  },
});

test('no recipients means nothing to resolve, and no call is made', async () => {
  assert.equal(await hasOpenProposalFor(db([{ id: 'd1' }]), 'ws-1', []), false);
  assert.equal(await hasOpenProposalFor(db([{ id: 'd1' }]), 'ws-1', [null, '']), false);
});

test('an open proposal for the recipient is worth a fetch', async () => {
  assert.equal(await hasOpenProposalFor(db([{ id: 'd1' }]), 'ws-1', ['jack@acme.example']), true);
});

test('no open proposal means we do not spend a call', async () => {
  // Most outbound mail has no recommendation behind it. One API call per sent email to learn
  // nothing is a cost with no payoff.
  assert.equal(await hasOpenProposalFor(db([]), 'ws-1', ['jack@acme.example']), false);
});
