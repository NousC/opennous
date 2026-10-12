#!/usr/bin/env node
// Run an app's tests: the public ones in tests/ and Cloud's in src/cloud/tests/ (GET-754).
// packages/core keeps its tests in test/ and Cloud's in test/cloud/ (slice 8).
//
// Cloud tests live in cloud folders so the open-source export, which drops those, drops them
// with the code they test. A glob that matches nothing must not fail the public build, so
// this lists what exists and hands node --test the files, never a pattern.
//
// Run from an app directory (npm test does): node ../../scripts/run-tests.mjs [node --test flags]
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const app = process.cwd();
const files = [];
for (const dir of ['tests', 'src/cloud/tests', 'test', 'test/cloud']) {
  const abs = join(app, dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs).sort()) if (f.endsWith('.test.mjs')) files.push(join(dir, f));
}
if (!files.length) {
  console.log('no test files');
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
