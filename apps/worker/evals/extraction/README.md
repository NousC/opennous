# Extraction evals

A fixed set of conversations that the signal extractor has misread before, each with what it must
record and the mistakes it must not make. Run them before you change an extraction prompt, so you
measure the change instead of guessing. (GET-1048. The approach is ported from Hindsight's
`hindsight-system-evals`, MIT.)

## Run it

From `apps/worker`, with a model key in `../../.env` or in your shell:

```sh
npm run eval:extraction -- --minimum                      # the minimum set: run before merging any prompt change
npm run eval:extraction -- --case att-rep-guess-budget    # one case
npm run eval:extraction -- --out results.json             # the full set, results written as JSON
```

The judge is not a Claude model, so it needs `OPENROUTER_API_KEY` (or `LLM_API_KEY` / `LLM_BASE_URL`).
The extractor uses whatever production uses (`EXTRACTION_MODEL`, `INSIGHT_BOARD_MODEL`). The judge
defaults to `z-ai/glm-5.2`. Set `EVAL_JUDGE_MODEL` to change it. The runner refuses a judge
from the same model family as the extractor or the check pass it grades, so a Claude judge is
refused while the check pass runs on Claude. `openai/gpt-4.1-mini` and `google/gemini-2.5-flash`
are not routable on our OpenRouter account, which is why they are not the default (GET-1050).

The exit code is 0 when every selected case passed, 1 when any case failed or errored, and 2 on a
setup problem.

**Nothing is written anywhere.** Each case runs the production read (`extractActivitySignals`, or
`extractMeetingSignals` for a call with several buyers) with `dryRun` on, against an in-memory
database seeded for that case. Before the extractor loads, the runner removes every database, API
and telemetry setting from its own environment (`safeEnv.mjs`). The only network calls go to the
models.

The dry run covers the whole read since GET-1050: the repair turn for an unusable answer, the split
of an answer cut off at its token limit, and the drop of a category outside the list all run as in
production. Only the delta skip (a re-synced meeting with the same text) is off, since it reads the
database for an earlier read and a case is always a first read.

## How a case is graded

1. **Extract.** The claims that would be saved are rendered one per line:
   `- [category] text (tags) [said date] {person: Name}` or `{account: Name}`.
2. **Deterministic checks** run first: `expect.maxClaims`, `expect.categories` (each present),
   `expect.notCategories` (each absent), `expect.contains` (text or tag; a nested array means any
   one of them counts), and a placeholder-year check (a year that is in neither the text nor
   within a year of the said date, or `20XX` and similar). A case that fails here is not sent to
   the judge.
3. **The judge** gets the source text, the rendered claims and one criterion, and must reply with
   `{"meets_criteria": true|false, "reasoning": "..."}`. Any other reply counts as a failing verdict.
   - **Traps first**, because a wrong fact is worse than a missing one. A trap is hit only when a
     second read (at temperature 0.5) confirms the first. A hit fails the case, and its musts are
     not asked.
   - **Musts**: if one fails at temperature 0, it is asked twice more at 0.5, and two of the three
     verdicts decide.

The JSON output has pass/fail with reasons per case, `by_category` pass/total, the extraction and
judge models, a fingerprint of each prompt (so two result files show whether the prompt changed),
and token use per model.

## Minimum cases

Cases marked `minimum: true` (at least one per category) are the gate. **Run `--minimum` before
merging any change to an extraction prompt** (`signals/index.mjs`, `signalCheck.mjs`,
`accountBrief.mjs`, the claim category block) and put the result in the PR. Run the full set when
you change something broad, or when the minimum set passes and you want to know what else moved.

## Add a case from a real misread

When the extractor files something wrong on a real account:

1. **Anonymize it completely.** This folder is published with the open-source repo. Keep the
   *shape* of the mistake (a rep's guess filed as the buyer's budget, a customer's own bot filed as
   a competitor). Drop every real name, company, product, number and sentence. Write a new short
   conversation that has the same trap in it. Use the invented cast in `cases/_shared.mjs` (Brindle,
   Ines Halloran, Atlas Freight, Lanternly, Tallyhook, …) or invent more. Never use a real client or
   contact.
2. Add it to the file for its category in `cases/` (selectivity, attribution, category, temporal,
   no_invention, competitor_naming):

   ```js
   {
     id: 'cat-short-name',                 // lowercase-with-dashes, unique
     category: 'category',
     origin: 'What went wrong, said generically.',
     minimum: false,                       // true only if it should gate every prompt change
     input: { kind: 'meeting' | 'email', saidAt: 'YYYY-MM-DD', account, people, ourSide: OUR_SIDE, text },
     must:  ['What a correct read records, as one checkable sentence.'],
     traps: ['The specific wrong claim, as one checkable sentence.'],
     expect: { maxClaims, categories, notCategories, contains },   // any subset, {} for none
   }
   ```

   Write each criterion so a reader who sees only the text and the claims can answer it yes or no.
   One idea per criterion. Prefer a deterministic `expect` check when one can express it.
3. Run it alone (`--case <id>`) and check that it fails on the old behaviour, if you can reproduce
   that, and passes on the fix.
4. `npm test` checks every case's shape. Before the PR, run
   `node scripts/export-preview.mjs --scan --strict` from the repo root. It fails on a real name.
