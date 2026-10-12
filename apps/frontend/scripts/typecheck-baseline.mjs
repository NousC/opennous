#!/usr/bin/env node
// Real frontend typecheck with a ratchet. Runs tsc against tsconfig.app.json —
// the config that actually covers src/ (the root tsconfig.json is a solution
// file with "files": [] and checks nothing) — and fails only when the error
// count grows past the committed baseline in typecheck-baseline.json.
// Lower "maxErrors" as errors get fixed; never raise it.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsPkg = require.resolve('typescript/package.json', { paths: [appRoot] });
const tscBin = path.join(path.dirname(tsPkg), 'bin', 'tsc');

const res = spawnSync(
  process.execPath,
  [tscBin, '--noEmit', '-p', 'tsconfig.app.json', '--pretty', 'false'],
  { cwd: appRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (res.error) {
  console.error('[typecheck] failed to run tsc:', res.error.message);
  process.exit(1);
}

const out = `${res.stdout || ''}${res.stderr || ''}`;
const errors = out.split(/\r?\n/).filter(l => /error TS\d+:/.test(l));
const { maxErrors } = JSON.parse(
  readFileSync(path.join(appRoot, 'typecheck-baseline.json'), 'utf8'),
);

// Guard the degenerate cases where tsc never actually checked the sources —
// without these, a broken tsconfig or a moved tsc binary would sail under the
// baseline (1 config error <= 67, or 0 countable errors) and CI would stay
// green while type-checking nothing.
if (res.status !== 0 && errors.length === 0) {
  console.error(out);
  console.error('\n[typecheck] tsc exited non-zero without reporting any TS errors — the checker never ran. Failing.');
  process.exit(1);
}
const configErrors = errors.filter(l => /error TS(5\d{3}|6053|18003):/.test(l));
if (configErrors.length) {
  console.error(out);
  console.error('\n[typecheck] tsc reported a config-level error (TS5xxx/TS6053/TS18003) — the project did not load correctly, so nothing was really checked. Failing.');
  process.exit(1);
}

if (errors.length > maxErrors) {
  console.error(out);
  console.error(
    `\n[typecheck] ${errors.length} errors — baseline is ${maxErrors}. ` +
    'New type errors were introduced; fix them before merging.',
  );
  process.exit(1);
}

console.log(`[typecheck] ${errors.length} errors (baseline ${maxErrors}) — no new type errors.`);
if (errors.length < maxErrors) {
  console.log(
    `[typecheck] Errors went down — lower "maxErrors" in typecheck-baseline.json to ${errors.length} to lock the progress in.`,
  );
}
