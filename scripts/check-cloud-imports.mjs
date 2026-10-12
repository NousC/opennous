#!/usr/bin/env node
// Cloud boundary guard (GET-754).
//
// The open-source repo is this one minus the Workspace (Cloud) layer: every apps/*/src/cloud/
// folder (the frontend's Clerk sign-in lives in apps/frontend/src/cloud/auth/clerk/). So public
// code must never import from those folders; it reaches Cloud only through the loaders
// (apps/frontend/src/lib/cloud.ts, apps/{api,worker}/src/lib/cloud.mjs), which check the
// folder exists first. Cloud code may import public code freely.
//
// This fails on any import/export-from/import()/require() whose target is inside a cloud
// folder, from a file outside one — including core's, as '@nous/core/cloud' (the learned ICP
// scorer, GET-754 slice 8; public core reaches it only through src/services/icpScorer.ts).
// Frontend public code also may not import @clerk/* (the Clerk SDK is Cloud's).
//
// Run: node scripts/check-cloud-imports.mjs [--root <dir>]

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argRoot = process.argv.indexOf('--root');
const root = argRoot > -1
  ? resolve(process.argv[argRoot + 1])
  : join(dirname(fileURLToPath(import.meta.url)), '..');

const SRC_EXT = /\.(m?[jt]sx?|cjs)$/;
const FRONTEND_SRC = join(root, 'apps/frontend/src');

// Folders that belong to the Workspace layer (dropped from the open-source export).
function isCloudPath(p) {
  const rel = relative(root, p).split(sep).join('/');
  return /^apps\/[^/]+\/src\/cloud(\/|$)/.test(rel)
    || /^packages\/[^/]+\/src\/cloud(\/|$)/.test(rel);
}

function sourceFiles() {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      if (f === 'node_modules' || f === 'dist') continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (SRC_EXT.test(f)) out.push(p);
    }
  };
  for (const base of ['apps', 'packages']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const pkg of readdirSync(dir)) {
      const src = join(dir, pkg, 'src');
      if (existsSync(src)) walk(src);
    }
  }
  return out;
}

const SPEC = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];
let checked = 0;
for (const file of sourceFiles()) {
  if (isCloudPath(file)) continue;
  checked++;
  const src = readFileSync(file, 'utf8');
  const inFrontend = file.startsWith(FRONTEND_SRC + sep);
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2] || m[3] || m[4];
    if (!spec) continue;
    let target = null;
    if (spec.startsWith('.')) target = resolve(dirname(file), spec);
    else if (spec.startsWith('@/') && inFrontend) target = join(FRONTEND_SRC, spec.slice(2));
    if ((target && isCloudPath(target)) || /^@nous\/core\/cloud(\/|$)/.test(spec)) {
      violations.push(`${relative(root, file)} imports '${spec}' (cloud-only code)`);
    } else if (inFrontend && /^@clerk\//.test(spec)) {
      violations.push(`${relative(root, file)} imports '${spec}' (the Clerk SDK is Cloud-only; go through lib/cloud.ts)`);
    }
  }
}

if (violations.length) {
  console.error('Public code imports the Workspace (Cloud) layer — the open-source build would break:');
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error('\nRead it through the cloud registry instead (apps/frontend/src/lib/cloud.ts, apps/*/src/lib/cloud.mjs, packages/core/src/services/icpScorer.ts).');
  process.exit(1);
}
console.log(`cloud boundary ok — ${checked} public source files, no imports into cloud/`);
