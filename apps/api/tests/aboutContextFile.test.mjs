// The About us file is mirrored into the workspace's positioning foundation (GET-1036): the text the
// feature-request check, the competitor rule and the signal check read as "what we sell".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorAboutFile } from '../src/lib/aboutContextFile.mjs';

function fakeDb(current = null) {
  const writes = [];
  const q = {
    select() { return q; }, eq() { return q; },
    maybeSingle: async () => ({ data: current, error: null }),
    upsert: async (row, opts) => { writes.push({ row, opts }); return { error: null }; },
  };
  return { writes, from: () => q };
}

test('the About file text becomes the positioning foundation', async () => {
  const sb = fakeDb(null);
  const out = await mirrorAboutFile(sb, 'ws', { about: async () => ({ title: 'About Lanternly', text: ' MCP, API, phone app. ' }) });
  assert.equal(out.status, 'mirrored');
  assert.deepEqual({ ...sb.writes[0].row, updated_at: 'x' }, { workspace_id: 'ws', kind: 'positioning', title: 'About Lanternly', body_md: 'MCP, API, phone app.', source: 'nous', updated_at: 'x' });
  assert.equal(sb.writes[0].opts.onConflict, 'workspace_id,kind');
});

test('unchanged text writes nothing; no About file leaves the last text', async () => {
  const same = fakeDb({ body_md: 'MCP, API, phone app.' });
  assert.equal((await mirrorAboutFile(same, 'ws', { about: async () => ({ title: 'A', text: 'MCP, API, phone app.' }) })).status, 'unchanged');
  assert.equal(same.writes.length, 0);
  const none = fakeDb(null);
  assert.equal((await mirrorAboutFile(none, 'ws', { about: async () => null })).status, 'no_about_file');
  assert.equal(none.writes.length, 0);
});
