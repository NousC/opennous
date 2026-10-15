// A timeout is not an answer.
//
// This lookup used to swallow every failure and return an empty map — indistinguishable from "none
// of these domains belongs to a company we hold". One day the database was under load from a
// claim-queue drain, the read timed out, and a call with three attendees on ashgrovehealth.example —
// with Ashgrove Health active in the graph under exactly that domain — filed itself on one of
// Harborline's own employees. The page looked normal. Nothing said it was a guess.
//
// Run: node --test apps/worker/tests/fellowDomainLookup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyIdsByAttendeeDomain } from '../src/webhooks/handlers/fellow.mjs';

/** A Supabase stub whose read fails `failTimes` times before answering with `rows`. */
function stub({ failTimes = 0, rows = [], error = 'canceling statement due to statement timeout' } = {}) {
  const state = { calls: 0 };
  const client = {
    from() {
      const q = {
        select: () => q,
        eq: () => q,
        in: () => {
          state.calls += 1;
          return state.calls <= failTimes
            ? Promise.resolve({ data: null, error: { message: error } })
            : Promise.resolve({ data: rows, error: null });
        },
      };
      return q;
    },
  };
  return { client, state };
}

const externals = [{ email: 'ysolde@ashgrovehealth.example' }, { email: 'barnaby@ashgrovehealth.example' }];
const ROW = { entity_id: 'ashgrove-health', value: 'ashgrovehealth.example' };

test('a clean read maps the domain to its company', async () => {
  const { client } = stub({ rows: [ROW] });
  const { byDomain, read } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(read, 'ok');
  assert.equal(byDomain.get('ashgrovehealth.example'), 'ashgrove-health');
});

test('a read that times out once is retried, and the answer still arrives', async () => {
  const { client, state } = stub({ failTimes: 1, rows: [ROW] });
  const { byDomain, read } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(read, 'ok');
  assert.equal(byDomain.get('ashgrovehealth.example'), 'ashgrove-health');
  assert.equal(state.calls, 2);
});

test('two failures still resolve on the third attempt', async () => {
  const { client, state } = stub({ failTimes: 2, rows: [ROW] });
  const { read } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(read, 'ok');
  assert.equal(state.calls, 3);
});

test('a read that never succeeds says so, instead of answering "no match"', async () => {
  const { client, state } = stub({ failTimes: 99 });
  const { byDomain, read } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(read, 'failed');          // the distinction the old code threw away
  assert.equal(byDomain.size, 0);
  assert.equal(state.calls, 3);          // and it stops, rather than hammering a loaded database
});

test('a genuine empty result is "ok", not a failure', async () => {
  const { client } = stub({ rows: [] });
  const { byDomain, read } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(read, 'ok');
  assert.equal(byDomain.size, 0);
});

test('nothing worth looking up never touches the database', async () => {
  const { client, state } = stub({ failTimes: 99 });
  // A fake local part; the case needs gmail.com itself.
  const { read } = await companyIdsByAttendeeDomain(client, 'ws', [{ email: 'test.user.0003@gmail.com' }]);
  assert.equal(read, 'ok');              // free mail is not a company domain, and that is not a failure
  assert.equal(state.calls, 0);
});

test('the first active holder of a domain wins, deterministically', async () => {
  const { client } = stub({ rows: [ROW, { entity_id: 'someone-else', value: 'ashgrovehealth.example' }] });
  const { byDomain } = await companyIdsByAttendeeDomain(client, 'ws', externals);
  assert.equal(byDomain.get('ashgrovehealth.example'), 'ashgrove-health');
});
