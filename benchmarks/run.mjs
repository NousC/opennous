// run.mjs
//
// The runner. Two modes:
//
//   node run.mjs --dry-run
//     Validates the fixture, tasks, and scorers WITHOUT calling the model. It
//     feeds each scorer a canned CORRECT answer and a canned INCORRECT answer and
//     checks the scorer separates them. This proves the harness works without an
//     API key or a network.
//
//   ANTHROPIC_API_KEY=... node run.mjs
//     Real run. For each task, runs Arm A (reconstruct) and Arm B (graph),
//     "repeats" times, scores, collects tokens/latency, writes results.json and
//     results.md, and prints a comparison table.
//
// Optional: --model=<id> to override the model.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TASKS } from './tasks.mjs';
import { GROUND_TRUTH, resolvedView, rawView } from './fixture.mjs';
import { runArm, DEFAULT_MODEL } from './arms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const modelArg = argv.find((a) => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : DEFAULT_MODEL;

const ARMS = [
  { name: 'reconstruct', label: 'A reconstruct' },
  { name: 'graph', label: 'B graph' },
];

// ---------------------------------------------------------------------------
// Dry run: prove the scorers and fixture without the model.
// ---------------------------------------------------------------------------

function dryRun() {
  console.log('DRY RUN: validating fixture, tasks, and scorers (no model calls)\n');

  // 1. Fixture sanity: the planted traps exist.
  const resolved = resolvedView();
  const acme = resolved.accounts.find((a) => a.name === 'Acme Corp');
  const sarah = acme.stakeholders.find((s) => s.name === 'Sarah Chen');
  const focus = resolved.accounts.filter((a) => a.focusRank === 'high').map((a) => a.name).sort();
  const raw = rawView();
  const sarahRawRows = raw.contacts.filter((c) => (c.name || '').toLowerCase().includes('chen'));

  const fixtureChecks = [
    ['12 accounts present', resolved.accounts.length === 12],
    ['Sarah resolves from 3 fragments', sarah && sarah.resolvedFrom === 3],
    ['Sarah has 3 identifiers', sarah && sarah.identifiers.length === 3],
    ['raw view still has 3 unresolved Chen rows', sarahRawRows.length === 3],
    ['Acme carries the buried fact', acme.durableFacts.some((f) => f.includes('CFO') && f.includes('50k'))],
    ['exactly 3 focus accounts', focus.length === 3],
    ['focus set matches ground truth', JSON.stringify(focus) === JSON.stringify([...GROUND_TRUTH.focusAccounts].sort())],
  ];

  let ok = true;
  console.log('Fixture checks:');
  for (const [label, pass] of fixtureChecks) {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) ok = false;
  }

  // 2. Scorer checks: canned correct vs incorrect answers.
  const canned = {
    t1_full_account: {
      correct:
        'Acme Corp is a 180-person B2B SaaS company. Sarah Chen (VP RevOps) is the champion. Important: the budget owner is the CFO, David Okafor, and any purchase over 50k needs CFO sign-off.',
      incorrect: 'Acme Corp is a 180-person B2B SaaS company. Sarah Chen is engaged. Nothing else notable.',
    },
    t2_who_to_focus: {
      correct: 'Prioritize Acme Corp, Globex, and Pied Piper. All three are high ICP fit with fresh intent this week.',
      incorrect: 'Prioritize Hooli, Initech, and Cyberdyne Systems based on open deals sorted by close date.',
    },
    t3_identity: {
      correct:
        'Sarah Chen is one person. She appears under sarah@acme.com, s.chen@acme.com, and https://www.linkedin.com/in/sarahchen-revops across an email, a meeting, and a CRM row.',
      incorrect: 'There appear to be three separate people named Sarah Chen or S. Chen at Acme. Hard to say if related.',
    },
    t5_consistency: {
      // For consistency, "correct" = identical answers each run; "incorrect" = varied.
      correctSet: [
        'Focus on Acme Corp, Globex, and Pied Piper.',
        'Focus on Globex, Pied Piper, and Acme Corp.',
        'Prioritize Pied Piper, Acme Corp, and Globex.',
        'Acme Corp, Globex, Pied Piper.',
        'Globex, Acme Corp, Pied Piper.',
      ],
      incorrectSet: [
        'Focus on Acme Corp, Globex, and Pied Piper.',
        'Focus on Hooli, Initech, and Cyberdyne Systems.',
        'Prioritize Massive Dynamic, Umbrella Analytics, and Globex.',
        'Acme Corp, Pied Piper, and Initech.',
        'Globex, Hooli, and Pied Piper.',
      ],
    },
  };

  console.log('\nScorer checks:');
  for (const task of TASKS) {
    if (task.id === 't5_consistency') {
      const good = task.scoreSet(canned.t5_consistency.correctSet, 'graph');
      const bad = task.scoreSet(canned.t5_consistency.incorrectSet, 'reconstruct');
      const pass = good.distinctSets === 1 && bad.distinctSets > 1;
      console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${task.id}: consistent set -> ${good.distinctSets} distinct, varied set -> ${bad.distinctSets} distinct`);
      if (!pass) ok = false;
      continue;
    }
    const c = canned[task.id];
    const good = task.score(c.correct, 'graph');
    const bad = task.score(c.incorrect, 'reconstruct');
    const goodPass = good.passed === true || (typeof good.score === 'number' && good.score >= 0.99);
    const badFail = bad.passed === false || (typeof bad.score === 'number' && bad.score < 0.5);
    const pass = goodPass && badFail;
    const fmt = (r) => (typeof r.score === 'number' ? `score=${r.score.toFixed(2)}` : `passed=${r.passed}`);
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${task.id}: correct -> ${fmt(good)}; incorrect -> ${fmt(bad)}`);
    if (!pass) ok = false;
  }

  console.log(`\n${ok ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Real run.
// ---------------------------------------------------------------------------

async function realRun() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Set it, or run: node run.mjs --dry-run');
    process.exit(1);
  }

  console.log(`Running benchmark with model ${MODEL}\n`);

  const rows = []; // one row per (task, arm)

  for (const task of TASKS) {
    for (const arm of ARMS) {
      const answers = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let latencyMs = 0;
      let toolCalls = 0;

      for (let i = 0; i < task.repeats; i++) {
        const r = await runArm(arm.name, task, { model: MODEL, apiKey });
        answers.push(r.answerText);
        inputTokens += r.inputTokens;
        outputTokens += r.outputTokens;
        latencyMs += r.latencyMs;
        toolCalls += r.toolCalls;
      }

      // Score. Consistency scores across the whole set; others score the first answer.
      let scoreCell;
      let detail;
      if (typeof task.scoreSet === 'function') {
        const s = task.scoreSet(answers, arm.name);
        scoreCell = `${s.distinctSets} distinct / ${s.repeats}`;
        detail = s.detail;
      } else {
        const s = task.score(answers[0], arm.name);
        if (typeof s.score === 'number') scoreCell = s.score.toFixed(2);
        else scoreCell = s.passed ? 'pass' : 'fail';
        detail = s.detail;
      }

      const avgLatency = Math.round(latencyMs / task.repeats);
      rows.push({
        task: task.id,
        arm: arm.label,
        metric: task.metric,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs: avgLatency,
        toolCalls,
        repeats: task.repeats,
        score: scoreCell,
        detail,
        answers,
      });
    }
  }

  // Write results.json
  const jsonPath = join(__dirname, 'results.json');
  writeFileSync(
    jsonPath,
    JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), rows }, null, 2),
  );

  // Build the markdown report + stdout table.
  const md = buildMarkdown(MODEL, rows);
  const mdPath = join(__dirname, 'results.md');
  writeFileSync(mdPath, md);

  printTable(rows);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

function buildMarkdown(model, rows) {
  const lines = [];
  lines.push('# Benchmark results: reconstruct vs the context graph');
  lines.push('');
  lines.push(`Model: \`${model}\`. Generated ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('| task | arm | total tokens | latency (ms) | score | notes |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${r.task} | ${r.arm} | ${r.totalTokens} | ${r.latencyMs} | ${r.score} | ${r.detail} |`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(summarize(rows));
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push('The fixture is synthetic with designed ground truth (that is what makes scoring possible, and it is disclosed). Arm A is a competent baseline with good tools and a fair prompt, not a strawman. v0 uses heuristic string and set scoring; an LLM-judge is the phase-2 upgrade for open-ended answers.');
  return lines.join('\n');
}

function summarize(rows) {
  const byArm = {};
  for (const r of rows) {
    byArm[r.arm] = byArm[r.arm] || { tokens: 0, latency: 0, n: 0 };
    byArm[r.arm].tokens += r.totalTokens;
    byArm[r.arm].latency += r.latencyMs;
    byArm[r.arm].n += 1;
  }
  const parts = [];
  for (const [arm, v] of Object.entries(byArm)) {
    parts.push(`${arm}: ${v.tokens} total tokens across ${v.n} runs, avg ${Math.round(v.latency / v.n)} ms/run.`);
  }
  return parts.join(' ');
}

function printTable(rows) {
  const header = ['task', 'arm', 'tokens', 'latencyMs', 'score', 'notes'];
  const data = rows.map((r) => [r.task, r.arm, String(r.totalTokens), String(r.latencyMs), String(r.score), r.detail]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((row) => row[i].length)));
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of data) console.log(fmt(row));
}

// ---------------------------------------------------------------------------

if (DRY_RUN) {
  dryRun();
} else {
  realRun().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
