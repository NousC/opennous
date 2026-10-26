// A feature request is a capability we do not have (GET-1031): an ask for something we already sell
// is refiled as setup, and a failed or empty check never costs a real request.
//
// Run: cd apps/worker && node --test tests/alreadyHave.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatWeSell, buildAlreadyHavePrompt, parseAlreadyHave, screenFeatureRequests } from '../src/signals/alreadyHave.mjs';

const ICP = `## Who we sell to
Founder-led sales teams at seed to Series A.

## What Lanternly sells
An account record agents can read: an MCP server and REST API, an installable phone app, Slack and email capture.

## Signals
<!-- nous:icp start -->learned<!-- nous:icp end -->`;

test('the catalogue is the ICP section that says what we sell', () => {
  assert.equal(whatWeSell(ICP), 'An account record agents can read: an MCP server and REST API, an installable phone app, Slack and email capture.');
});

test('no section: the Positioning foundation, then the ICP itself; too little is none', () => {
  assert.match(whatWeSell('## Who we sell to\nFounder-led sales teams at seed to Series A, selling to RevOps.', 'Lanternly is the account record your agents read, over MCP and an API.'), /^Lanternly is the account record/);
  assert.match(whatWeSell('## Who we sell to\nFounder-led sales teams at seed to Series A, selling to RevOps.'), /^## Who we sell to/);
  assert.equal(whatWeSell('## ICP\nTBD'), null);
});

test('the prompt numbers the requests and holds the catalogue', () => {
  const p = buildAlreadyHavePrompt({ catalogue: 'An MCP server.', requests: [
    { what: 'API/MCP', content: 'Wants to connect the MCP to their bots.' },
    { what: 'Own meeting recorder', content: 'Build your own recorder.', use_case: 'drop other vendors' },
  ] });
  assert.match(p, /"""\nAn MCP server\.\n"""/);
  assert.match(p, /1\. API\/MCP: Wants to connect the MCP to their bots\./);
  assert.match(p, /2\. Own meeting recorder: Build your own recorder\. \(to drop other vendors\)/);
});

test('only real request numbers are kept', () => {
  const m = parseAlreadyHave([{ n: 1, have: 'MCP server' }, { n: 9 }, { n: 'x' }, { n: 0 }], 2);
  assert.deepEqual([...m], [[0, 'MCP server']]);
  assert.equal(parseAlreadyHave(null, 2).size, 0);
});

test('no feature rows: no read, the facts come back as they were', async () => {
  const facts = [{ kind: 'praise', content: 'Love it.' }];
  const sb = { from() { throw new Error('should not read'); } };
  assert.equal(await screenFeatureRequests(sb, 'ws', facts), facts);
});

test('no catalogue on file: every feature stays a feature', async () => {
  const facts = [{ kind: 'feature', what: 'API/MCP', content: 'Wants the MCP.' }];
  const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: null, error: null }) };
  const sb = { from: () => q };
  assert.deepEqual(await screenFeatureRequests(sb, 'ws', facts), facts);
});

test('the About us file (positioning) comes before the ICP\'s own section', () => {
  assert.equal(whatWeSell(ICP, 'Lanternly: the account record for agents, with an MCP server, an API and a phone app.'), 'Lanternly: the account record for agents, with an MCP server, an API and a phone app.');
});
