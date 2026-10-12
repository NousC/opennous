// The surface is a locked decision, so it gets a test rather than a sentence.
//
// It drifted for weeks — the README said eight primitives, a comment said ten, the set held
// thirteen — and nobody noticed because nothing compared them. A lock whose value nobody can
// state is not a lock, so the count now lives in exactly one place and this fails if a tool is
// added without the decision being made deliberately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Update this list ONLY alongside a deliberate decision to widen the surface, and say why in the
// commit. The bar: a capability that cannot fold into an existing primitive.
// The documented core (2026-09-30): one tool per door of the public API, listed FIRST in
// PLUGIN_TOOLS so tools/list leads with them. Cloud adds read_brain and write_brain from its own
// module (src/cloud/index.js, GET-839), so they are not in this literal set.
const DOCUMENTED = [
  'whoami', 'find', 'get_context', 'query', 'attention', 'tasks', 'get_insights',
  'add_note', 'enrich', 'score', 'set_icp',
  'webhooks',
];
// Legacy: still registered because plugin skills call them. Remove with the skills' migration
// (GET-536), not before.
const LEGACY = [
  'get_account', 'deals', 'pages', 'read_page', 'save_page',
  'record', 'record_insight', 'record_closed_deals',
];
const EXPECTED = [...DOCUMENTED, ...LEGACY];

async function pluginTools() {
  const src = await readFile(join(here, '..', 'src', 'server.js'), 'utf8');
  const block = src.match(/PLUGIN_TOOLS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'PLUGIN_TOOLS must stay a literal set — it is the only statement of the surface');
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

test('the surface is exactly the agreed set', async () => {
  assert.deepEqual([...await pluginTools()].sort(), [...EXPECTED].sort());
});

test('the documented core comes first', async () => {
  const tools = await pluginTools();
  assert.deepEqual(tools.slice(0, DOCUMENTED.length).sort(), [...DOCUMENTED].sort());
});

test('the README does not restate the count in prose', async () => {
  // Prose counts are what drifted. The doc describes the set; the set is the count.
  const readme = await readFile(join(here, '..', '..', '..', 'docs', 'revenue-plugin', 'README.md'), 'utf8');
  const stale = readme.match(/\b(six|seven|eight|nine|ten|eleven|twelve)[ -]primitives?\b/gi);
  assert.equal(stale, null, `README states a primitive count in prose: ${stale?.join(', ')}`);
});

test('package.json and SERVER_VERSION agree', async () => {
  // They drifted the moment a rename bumped one and not the other, and the publish failed with
  // "cannot publish over 0.69.0" — which is the GOOD outcome. The bad one is a package that
  // ships announcing a version it is not, so `npm view` and what the server reports disagree and
  // nobody can tell which build a workspace is actually running.
  const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'));
  const src = await readFile(join(here, '..', 'src', 'server.js'), 'utf8');
  const declared = src.match(/SERVER_VERSION = "([^"]+)"/)?.[1];
  assert.equal(declared, pkg.version, 'bump both, or neither');
});

test('every tool in the set is actually registered', async () => {
  const src = await readFile(join(here, '..', 'src', 'server.js'), 'utf8');
  for (const name of await pluginTools()) {
    assert.ok(new RegExp(`tool\\(\\s*\\n?\\s*"${name}"`).test(src), `${name} is allowlisted but never registered`);
  }
});
