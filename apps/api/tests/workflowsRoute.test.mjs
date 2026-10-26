// Workflows (GET-1043): the app calls /api/workflows, and /api/automations keeps answering for API
// keys, the plugin and anything already calling it. Both are the same router behind the same auth.
//
// Run: node --test apps/api/tests/workflowsRoute.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const index = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');

test('/api/workflows and /api/automations mount the same router behind the same auth', () => {
  for (const path of ['/api/workflows', '/api/automations']) {
    assert.match(index, new RegExp(`app\\.use\\('${path.replace(/\//g, '\\/')}',\\s*verifyAuthEither, automationsRouter\\)`), path);
  }
});
