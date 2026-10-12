#!/usr/bin/env node
// Link every .mjs module of an app WITHOUT running it (GET-754).
//
// Builds the ES module graph with vm.SourceTextModule and links it, which is exactly the step
// that fails at boot with "does not provide an export named", "Cannot find module" or a
// SyntaxError — but evaluates no app code, so one-off scripts with top-level side effects
// (process.exit on missing env, network calls) are checked safely. Packages are really
// imported (that is how their export names are known). Literal dynamic imports of relative
// files are checked for existence too.
//
// Run: node --experimental-vm-modules scripts/check-module-links.mjs apps/api [src] [skipRegex]
import vm from 'node:vm';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const appDir = resolve(process.argv[2]);
const srcDir = join(appDir, process.argv[3] || 'src');
const skip = new RegExp(process.argv[4] || '^$');
const req = createRequire(join(appDir, 'package.json'));
const ctx = vm.createContext(globalThis);
const cache = new Map();
const pkgCache = new Map();
const errors = [];
function srcModule(path) {
  if (cache.has(path)) return cache.get(path);
  const m = new vm.SourceTextModule(readFileSync(path, 'utf8'), { identifier: pathToFileURL(path).href, context: ctx });
  cache.set(path, m); return m;
}
async function pkgModule(spec) {
  if (pkgCache.has(spec)) return pkgCache.get(spec);
  let ns;
  if (spec.startsWith('node:') || !spec.startsWith('.')) {
    let target = spec;
    if (!spec.startsWith('node:')) {
      try { target = pathToFileURL(req.resolve(spec)).href; }
      catch { target = spec; }
    }
    try { ns = await import(target); }
    catch (e) {
      // ESM-only packages that require.resolve can't see: resolve via import from appDir
      ns = await import(spec).catch(() => { throw new Error(`Cannot find package '${spec}'`); });
    }
  }
  const names = Object.keys(ns);
  const m = new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, ns[n]); }, { identifier: spec, context: ctx });
  pkgCache.set(spec, m); return m;
}
async function linker(spec, ref) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const base = dirname(new URL(ref.identifier).pathname);
    const p = resolve(base, spec);
    if (!existsSync(p)) throw new Error(`Cannot find module '${spec}' imported from ${relative(appDir, new URL(ref.identifier).pathname)}`);
    return srcModule(p);
  }
  return pkgModule(spec);
}
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); } else if (p.endsWith('.mjs')) files.push(p); } })(srcDir);
let n = 0;
for (const f of files.sort()) {
  const rel = relative(srcDir, f);
  if (skip.test(rel)) continue;
  n++;
  try {
    const m = srcModule(f);
    if (m.status === 'unlinked') await m.link(linker);
  } catch (e) {
    errors.push(`${rel}: ${String(e.message).split('\n')[0]}`);
    cache.delete(f);
  }
  // literal dynamic imports of relative files must exist too
  const src = readFileSync(f, 'utf8');
  for (const mm of src.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    if (!existsSync(resolve(dirname(f), mm[1]))) errors.push(`${rel}: dynamic import('${mm[1]}') — Cannot find module`);
  }
}
for (const e of errors) console.log('LINK', e);
console.log(`${relative(process.cwd(), srcDir) || srcDir}: linked ${n} modules, ${errors.length} link errors`);
process.exit(errors.length ? 1 : 0);
