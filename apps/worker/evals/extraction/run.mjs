#!/usr/bin/env node
// The extraction eval runner (GET-1048). Measure before changing a prompt.
//
// For each case: run the production read on its text into an in-memory database (extract.mjs),
// render what it would save one claim per line, apply the deterministic checks (checks.mjs), and
// only when those pass, ask the judge (judge.mjs) about each trap and each must. A case passes when
// every check passes, no trap is confirmed and every must is met.
//
// Usage (from apps/worker; needs model keys, writes nothing anywhere but --out):
//   npm run eval:extraction -- --minimum                  the cases to run before merging a prompt change
//   npm run eval:extraction -- --case att-rep-guess-budget
//   npm run eval:extraction -- --out results.json         the full set, results written as JSON
//
// Exit code: 0 when every selected case passed, 1 when any failed or errored, 2 on a setup problem.
// The JSON carries pass/total by category, the models and prompt fingerprints, and token use, so
// two runs (before and after a prompt change) compare line by line.
//
// runEval() is exported with the extractor and the judge injected; tests/extractionEvals.test.mjs
// runs it with fakes, no network and no keys.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CASE_CATEGORIES, loadCases, selectCases, renderClaims, deterministicChecks } from './checks.mjs';
import { judgeCase } from './judge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(HERE, 'cases');

/** --minimum, --case <id>, --out <file>. Unknown flags are an error, so a typo never runs the full set. */
export function parseArgs(argv) {
  const out = { minimum: false, caseId: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--minimum') out.minimum = true;
    else if (a === '--case' || a === '--out') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a === '--case' ? 'caseId' : 'out'] = v;
    } else throw new Error(`unknown argument ${a} (use --minimum, --case <id>, --out <file>)`);
  }
  return out;
}

/** Add one model's usage map into another: { model: { calls, input_tokens, output_tokens } }. */
function addUsage(into, from = {}) {
  for (const [model, u] of Object.entries(from)) {
    into[model] ??= { calls: 0, input_tokens: 0, output_tokens: 0 };
    into[model].calls += u.calls ?? 0;
    into[model].input_tokens += u.input_tokens ?? 0;
    into[model].output_tokens += u.output_tokens ?? 0;
  }
  return into;
}

/**
 * Run the cases.
 * @param {object} o
 * @param {object[]} o.cases
 * @param {(c) => Promise<{claims: object[], usage?: object}>} o.extract   one case → the claims it would save
 * @param {(args) => Promise<{meets: boolean|null, reasoning: string}>} o.ask   one judge verdict
 * @param {object} [o.meta]   identifiers stamped on the result (models, prompts, judge, git)
 * @param {(line: string) => void} [o.log]
 */
export async function runEval({ cases, extract, ask, meta = {}, log = () => {} }) {
  const results = [];
  const extractionUsage = {};
  for (const c of cases) {
    const r = { id: c.id, category: c.category, minimum: !!c.minimum, origin: c.origin, status: 'fail', pass: false, reasons: [], claims: [], deterministic: null, judge: null };
    try {
      const { claims, ours = [], usage } = await extract(c);
      addUsage(extractionUsage, usage);
      r.claims = claims.length ? renderClaims(claims).split('\n') : [];
      // What our side said (GET-1052): shown in the result, checked by code, never judged as a claim.
      r.ours = ours.map(o => `- [${o.category}] ${o.content}${o.speaker ? ` {said by: ${o.speaker}}` : ''}`);
      r.deterministic = deterministicChecks(claims, c, ours);
      r.reasons.push(...r.deterministic.reasons);
      // The judge is slow and costs money; a case the checks already failed is not asked about.
      if (r.deterministic.pass && (c.traps.length || c.must.length)) {
        r.judge = await judgeCase(ask, c, renderClaims(claims), { claimCount: claims.length });
        r.reasons.push(...r.judge.reasons);
      }
      r.pass = r.reasons.length === 0;
      r.status = r.pass ? 'pass' : 'fail';
    } catch (err) {
      // An error is a failure, never a skip: a run that errored on half its cases is not a pass.
      r.status = 'error';
      r.reasons.push(`error: ${err?.message ?? err}`);
    }
    results.push(r);
    log(`[EVAL] ${r.status.toUpperCase().padEnd(5)} ${c.id} (${c.category}) · ${r.claims.length} claim(s)${r.reasons.length ? `\n        ${r.reasons.join('\n        ')}` : ''}`);
  }
  const by_category = {};
  for (const cat of CASE_CATEGORIES) {
    const of = results.filter(r => r.category === cat);
    if (of.length) by_category[cat] = { pass: of.filter(r => r.pass).length, total: of.length };
  }
  const { judgeUsage, ...stamp } = meta;
  return {
    at: new Date().toISOString(),
    ...stamp,
    totals: { pass: results.filter(r => r.pass).length, total: results.length, errors: results.filter(r => r.status === 'error').length },
    by_category,
    usage: { extraction: extractionUsage, ...(judgeUsage ? { judge: judgeUsage } : {}) },
    cases: results,
  };
}

/** The one-screen summary. */
export function summaryLines(result) {
  const lines = [`[EVAL] ${result.totals.pass}/${result.totals.total} passed${result.totals.errors ? ` (${result.totals.errors} errored)` : ''}`];
  for (const [cat, s] of Object.entries(result.by_category)) lines.push(`[EVAL]   ${cat.padEnd(18)} ${s.pass}/${s.total}`);
  return lines;
}

const gitRev = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim(); } catch { return null; } };

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (err) { console.error(err.message); process.exit(2); }

  // Before anything that reads the environment is loaded (safeEnv.mjs says why).
  const { scrubProductionEnv } = await import('./safeEnv.mjs');
  const removed = scrubProductionEnv();
  if (removed.length) console.log(`[EVAL] removed ${removed.length} production setting(s) from this process: ${removed.join(', ')}`);
  const env = (k) => (process.env[k] || '').trim();
  if (!env('OPENROUTER_API_KEY') && !env('LLM_API_KEY') && !env('LLM_BASE_URL')) {
    console.error('[EVAL] no model key: set OPENROUTER_API_KEY (the judge is not a Claude model, so it needs OpenRouter or LLM_BASE_URL)');
    process.exit(2);
  }

  const cases = selectCases(await loadCases(CASES_DIR), args);
  const { extractCase, extractorInfo } = await import('./extract.mjs');
  const { createMessage } = await import('../../src/lib/llm.mjs');
  const { createModelJudge, judgeModelFor } = await import('./judge.mjs');
  const extractor = extractorInfo();
  let judgeModel;
  try { judgeModel = judgeModelFor({ graded: Object.values(extractor.models) }); } catch (err) { console.error(`[EVAL] ${err.message}`); process.exit(2); }
  const judge = createModelJudge({ createMessage, model: judgeModel });

  console.log(`[EVAL] ${cases.length} case(s) · extraction ${extractor.models.extraction} · check ${extractor.models.signal_check} · judge ${judgeModel}`);
  const result = await runEval({
    cases, extract: extractCase, ask: judge.ask, log: (l) => console.log(l),
    meta: {
      git: gitRev(), selection: { minimum: args.minimum, case: args.caseId },
      extractor, judge: { model: judgeModel }, judgeUsage: judge.usage,
    },
  });
  for (const l of summaryLines(result)) console.log(l);
  if (args.out) { writeFileSync(args.out, JSON.stringify(result, null, 2)); console.log(`[EVAL] results written to ${args.out}`); }
  process.exit(result.totals.pass === result.totals.total ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[EVAL] failed:', err?.stack ?? err); process.exit(2); });
}
