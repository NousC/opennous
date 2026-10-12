#!/usr/bin/env node
// Context-graph boundary guard.
//
// Enforces the rule that the open-source substrate never imports closed product code — so a
// leak can't drag the product into the OSS mirror. Reads context-graph.paths.json:
//   - substrate.clean          → HARD FAIL if any imports a productDeny module.
//   - substrate.pending_decouple → WARN only (known fusion points, being decoupled).
//
// Run: node scripts/context-graph-guard.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'context-graph.paths.json'), 'utf8'));
const deny = new Set(manifest.productDeny);

// Extract imported module basenames (no extension) from a source file's import/export-from lines.
function importedModules(src) {
  const mods = [];
  const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    mods.push(basename(spec).replace(/\.(m?[jt]s)$/, ''));
  }
  return mods;
}

function violations(file) {
  let src;
  try { src = readFileSync(join(root, file), 'utf8'); }
  catch { return { file, missing: true, hits: [] }; }
  const hits = importedModules(src).filter((mod) => deny.has(mod));
  return { file, missing: false, hits: [...new Set(hits)] };
}

let failed = false;

console.log('── context-graph boundary guard ──\n');

console.log('CLEAN substrate (must not import product):');
for (const file of manifest.substrate.clean) {
  const { missing, hits } = violations(file);
  if (missing) { console.log(`  ?  ${file} — not found (path moved? update the manifest)`); continue; }
  if (hits.length) { failed = true; console.log(`  ✗  ${file} — imports product: ${hits.join(', ')}`); }
  else console.log(`  ✓  ${file}`);
}

console.log('\nPENDING decouple (warn only, tracked in the manifest):');
for (const { file, reason } of manifest.substrate.pending_decouple) {
  const { missing, hits } = violations(file);
  if (missing) { console.log(`  ?  ${file} — not found`); continue; }
  const tag = hits.length ? `still coupled → ${hits.join(', ')}` : 'no product imports (ready to promote to clean)';
  console.log(`  •  ${file} — ${tag}\n       ${reason}`);
}

if (failed) {
  console.error('\n❌ A clean substrate module imports closed product code. Fix the import or move the file to the product layer.');
  process.exit(1);
}
console.log('\n✅ Clean substrate is product-import-free.');
