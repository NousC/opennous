# Benchmarks: reconstruct vs the context graph

A standalone, runnable benchmark that puts two agents head to head on the same tasks, against the same data, with the same model. It turns "you cannot just build it yourself" from an assertion into numbers.

## The proof

Two arms, one shared synthetic fixture, identical prompts.

- **Arm A, reconstruct (the honest baseline).** An agent given raw tools that return scattered, unresolved rows: duplicate people under different emails, no joins, no scoring. It has to stitch context itself on every call. This is the "point the agent at every tool" approach, and it is built to be a competent baseline (good tools, a fair prompt, all the data present), not a strawman.
- **Arm B, graph.** The same underlying data, but the agent reads a resolved context graph. A `get_context`-style tool returns one compact, resolved account block (identity merged, the buried fact attached to the right account, ICP fit and intent precomputed), plus a `query` tool.

Both arms run the same tasks against the same fixture, so the gap is the point.

## What it measures

- **Coverage / accuracy** (does the answer surface the planted buried fact, does it resolve the identity).
- **Decision quality** (does "who should I focus on" name the right accounts).
- **Consistency** (run the same prioritization task five times, count how many distinct answers each arm gives; 1 means perfectly consistent).
- **Token cost and latency** (captured per task from the SDK usage and wall clock).

The fixture plants the ground truth on purpose so scoring is possible:

- An identity trap. Sarah Chen at Acme appears under three identifiers (`sarah@acme.com`, `s.chen@acme.com`, and a LinkedIn URL) across an email, a meeting transcript, and a CRM row. Ground truth: one person.
- A buried fact. One important Acme fact (the budget owner is the CFO, sign-off needed over $50k) appears only on a thread from the secondary email `s.chen@acme.com`. Ground truth: it belongs to Acme.
- A focus set. Exactly three accounts (Acme, Globex, Pied Piper) are designed to be the correct "who should I focus on today" answer (high ICP fit plus fresh intent in the last seven days).

## How to run

Install once (this is a pnpm ESM package):

```
pnpm install
```

Real run (needs an Anthropic API key, and makes model calls):

```
ANTHROPIC_API_KEY=... node run.mjs
```

Override the model if you want:

```
ANTHROPIC_API_KEY=... node run.mjs --model=claude-haiku-4-5-20251001
```

Dry run (no key, no network). This validates the fixture, the tasks, and the scorers by feeding each scorer a canned correct and a canned incorrect answer and confirming it separates them:

```
node run.mjs --dry-run
```

A real run writes two artifacts: `results.json` (the raw numbers) and `results.md` (a comparison table plus a short summary), and prints the table to stdout.

## The files

- `fixture.mjs` is the deterministic synthetic fixture with the planted ground truth. It exposes `rawView` (what Arm A reads), `resolvedView` (what Arm B reads), and `GROUND_TRUTH`.
- `tasks.mjs` is the task suite (full account picture, who to focus on, identity resolution, consistency), each with its own scorer.
- `arms.mjs` runs the Anthropic tool-use loop for both arms and captures tokens, latency, and tool-call counts.
- `score.mjs` holds the heuristic scorers (set overlap, contains-fact, count-distinct).
- `run.mjs` is the runner (real run and dry run).

## Honest caveats

- The fixture is synthetic, with designed ground truth. That is exactly what makes scoring possible, and it is disclosed rather than hidden. A stronger claim would run a second pass on a sanitized real workspace.
- Arm A has to be a genuinely competent baseline, with good tools and a fair prompt. A weak baseline would invalidate the whole thing, so the raw tools are real and the data is all present, it just is not resolved.
- v0 uses heuristic string and set scoring. That is fine for tasks with a clean ground truth (identity, buried fact, focus set, consistency). Open-ended answers (for example a drafted follow-up email) want an LLM-judge with a published rubric, scored blind to which arm produced the answer. That is the phase-2 upgrade.
- Report the cases where the gap is small, or where reconstruct wins, if any. Selective reporting kills credibility faster than a small delta.
