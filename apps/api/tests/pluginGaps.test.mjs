// The two capabilities the plugin was missing, and the one contract that must not drift.
//
// Gap 1 — the plugin could WRITE the ICP and never read it. A skill triaging a list could ask
// the engine to grade something and never see the standard it was graded against, which makes
// the judgement unarguable in exactly the place we tell the agent not to take things on faith.
//
// Gap 3 — "always write shorter", said outright, had no door. Constraints had one; preferences
// only arrived as a side effect of a verdict, so a volunteered preference was lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFile(join(root, p), 'utf8');

test('query answers scope.foundation = icp', async () => {
  const src = await read('apps/api/src/routes/v2/query.mjs');
  assert.match(src, /scope\?\.foundation === 'icp'/);
  assert.match(src, /readIcp/);
  // An undefined ICP is a normal state on a fresh workspace, not an error — and the reply has
  // to say what to do about it rather than returning an empty body.
  assert.match(src, /defined: false/);
  assert.match(src, /set_icp/);
});

test('the write door accepts a stated preference', async () => {
  const src = await read('apps/api/src/lib/recordObservations.mjs');
  assert.match(src, /o\.property === 'preference'/);
  assert.match(src, /addPreference/);
  // Person scope binds to the caller. A preference attached to the wrong person reshapes
  // somebody else's output, which is the one direction this must never fail in.
  assert.match(src, /opts\.userId \?\? v\.user_id/);
});

test('save_document still speaks the shape /v2/documents returns', async () => {
  // Pages moved fast — renamed, re-styled, re-sidebar'd. The MCP tool reads five fields off the
  // response and a drift in any of them turns a successful save into a confusing failure
  // message, which is worse than an error because the document IS filed.
  const route = await read('apps/api/src/routes/v2/documents.mjs');
  const mcp = await read('apps/mcp/src/server.js');
  for (const field of ['document_id', 'title', 'version', 'url', 'sources']) {
    assert.match(route, new RegExp(`${field}:`), `POST /v2/documents must return ${field}`);
    assert.ok(mcp.includes(`r.${field}`), `save_document reads r.${field}`);
  }
  // The ambiguous-account branch is a contract too: the tool prints candidates and asks the
  // agent to call again with an entity id.
  assert.match(route, /status: 'ambiguous', candidates/);
  assert.ok(mcp.includes('r.status === "ambiguous"'));
});
