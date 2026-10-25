// get_account lists what they asked us to build in its own section (GET-1026), so an agent never
// reads "build your own recorder" as "they are shopping for a recorder".
//
// Run: node --test apps/mcp/tests/featureRequestsBlock.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureRequestsBlock } from '../src/server.js';

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

test('each request names the thing, says what they want and when, and quotes them when we may', () => {
  const text = featureRequestsBlock([
    { what: 'Own meeting recorder', content: 'Dana Reyes wants us to build our own meeting recorder.', occurred_at: daysAgo(2), source_system: 'slack', quote: null },
    { what: 'Date filter', content: 'Wants a date filter on the inbox.', occurred_at: daysAgo(9), source_system: 'gmail', quote: 'can we filter by date?' },
  ]).join('\n');
  assert.match(text, /^FEATURE REQUESTS \(what they asked us to build/);
  assert.match(text, /not a tool they are shopping for/);
  assert.match(text, /Own meeting recorder: Dana Reyes wants us to build our own meeting recorder\.\s+\(asked \w{3} \d{1,2} · 2d ago · slack\)/);
  assert.match(text, /"can we filter by date\?"/);
  assert.equal(text.match(/"/g).length, 2, 'a private quote is not printed');
});

test('no requests, no section', () => {
  assert.deepEqual(featureRequestsBlock([]), []);
  assert.deepEqual(featureRequestsBlock(undefined), []);
});
