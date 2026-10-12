// The history backfill must read a Composio mailbox through Composio (GET-552).
//
// It did not: scanGmailBulk refreshed a native Google token on every Gmail connection, and a
// Composio connection has none — Composio holds the grant. The refresh threw "No refresh token
// stored", the connection was flagged for re-auth, and the lane reported done with 0. Every new
// customer's Gmail history was skipped and their mailbox marked broken, and nothing errored.
//
// Checked structurally, like gmailReadWiring: the failure is a missing branch, not a behaviour a
// unit test without Composio and a database can drive.
//
// Run: node --test apps/worker/tests/gmailBackfillComposioWiring.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/services/contactHistoryEnricher.mjs', import.meta.url), 'utf8');

const body = (name) => {
  const start = SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return SRC.slice(start, SRC.indexOf('\n}\n', start));
};

test('a Composio mailbox is routed to the Composio read before any token refresh', () => {
  const bulk = body('scanGmailBulk');
  const route = bulk.indexOf("managed_by === 'composio'");
  const refresh = bulk.indexOf('refreshGoogleToken(');
  assert.ok(route >= 0, 'scanGmailBulk checks managed_by');
  assert.ok(refresh > route, 'the composio branch comes before the native refresh');
  assert.match(body('scanGmailComposio'), /syncGmailConnection\(/, 'the composio read is the mailbox scan');
});

test('the per-contact Gmail scan never refreshes a Composio connection', () => {
  const one = body('scanGmail');
  assert.ok(one.indexOf("managed_by === 'composio'") < one.indexOf('refreshGoogleToken('));
});

test('the connection loader carries what the Composio read needs', () => {
  const loader = body('getWorkspaceConnections');
  for (const col of ['managed_by', 'composio_connection_id', 'owner_user_id', 'workspace_id']) {
    assert.ok(loader.includes(col), `selects ${col}`);
  }
});

test('a failed source says failed, not done with 0', () => {
  assert.match(SRC, /setSource\(c\.id, source, failed \? 'failed' : 'done', n\)/);
  assert.match(SRC, /setSource\(contact\.id, source, failed \? 'failed' : 'done', n\)/);
});

test('a run with a failed source does not advance the backfill watermark', () => {
  const JOBS = readFileSync(new URL('../src/workers/contactEnrichmentJobs.mjs', import.meta.url), 'utf8');
  assert.match(SRC, /failedSources: \[\.\.\.failedSources\]/, 'the enricher reports failed sources');
  const stamp = JOBS.indexOf('history_backfilled_at: new Date()');
  const guard = JOBS.lastIndexOf('if (failed.length)', stamp);
  assert.ok(guard >= 0 && guard < stamp, 'the stamp sits behind the failed-sources check');
});
