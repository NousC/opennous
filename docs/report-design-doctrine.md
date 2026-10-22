# Report design doctrine

How a report is built, who decides what, and which decisions are deliberately not the
agent's. The contract between `ReportBlocks.tsx`, the `present_document` tool schema, and
the app notes in `scripts/sync-plugin-skills.mjs`.

## The one idea

**The agent supplies data. The app supplies pixels.**

A document used to be `{ label, body }` — labelled markdown, nothing else. There was
nowhere to put a number, a series or a colour, so the agent could only write paragraphs.
That is why every report read like an essay, and no prompt was ever going to fix it. It was
a data-model problem.

## Four layers, and which decision lives where

| Layer | Where | Decides |
|---|---|---|
| **Vocabulary** | `present_document` schema in `playgroundAgent.mjs` | what a section may contain |
| **Renderer** | `apps/frontend/src/components/ReportBlocks.tsx` | what every block looks like |
| **Doctrine** | `REPORT_BLOCKS_NOTE` in `scripts/sync-plugin-skills.mjs` | which block carries which claim |
| **Shape** | each skill's `SKILL.md` in `revenue-plugin` | which sections a report has |

The rule for deciding where something belongs:

> **Appearance is hardcoded. Choice is instructed.**
> Anything you would be annoyed to see differ between two reports is code.

Colours, type scale, spacing, bar height, number formatting, page-break behaviour: code.
Which block fits this claim, what the finding is, what to recommend: instructions.

The test that it is working: you can restyle every report in the product by editing one
file, and no skill text changes.

### How this differs from ChatGPT's `pdfs` skill

There, the model writes a Python script each run (matplotlib + python-docx) and the skill
file is a long prose style guide trying to pin appearance down in words. That is the right
design *when there is no app*: the output is a one-off file, so the design has to live in the
generated script. The cost is that the design is re-decided on every run, prose cannot
constrain a script, two reports never quite match, and you can never fix all reports at
once — only re-word the guide and hope.

We have an app, so the design lives in a compiled renderer and the instructions teach only
choice.

## The block doctrine is keyed on the CLAIM, not the section

`REPORT_BLOCKS_NOTE` is written once and prepended to every skill whose app note carries
`report: true`. It maps *the shape of what you are asserting* to a block:

| The claim | Block |
|---|---|
| "here is the state, in a few numbers" | `metrics` (2–5) |
| "these are ranked, and the top one dominates" | `chart` `bar` (horizontal — labels are words) |
| "A against B across categories" | `chart` `grouped`, semantic colours |
| "this moved over the period" | `chart` `line` |
| "each of these has several attributes worth comparing" | `table` |
| "two sources disagree" | `table`, a column each, then your read |
| "one thing here matters more than the rest" | `callout` |
| "here is why, and what to do about it" | `prose` |

Keyed this way on purpose. A ranking of dollars across six patterns is a bar chart whether
it lands in a revenue report's leakage section or a win-loss report's objection ranking.
Keying it to section names makes the mapping rot the moment a report's sections change, and
it is the wrong axis anyway: **the block follows from the data, the sections follow from the
report, and which report a seat gets follows from the role.** Three separate decisions.

`brief` and `plan-account` deliberately do NOT get this note. They stay prose — telling them
about charts would only invite one into a pre-call read.

## RULING: `revenue-report` is a template, on purpose

*Product decision, 2026-09-11.*

`revenue-report` has a fixed shape — nine sections — and its audience is the **founder, CRO
or VP Sales**: the seats that think in coverage, leakage and what to change. It is not
dynamically composed and should not be made so. All nine sections are mapped to blocks in
its app note precisely *because* the shape is fixed; a fixed document with unmapped sections
is how half a report comes out as blocks and half as essay.

**It is not the report for every seat.** `ROLE_PROFILES[role].report` already carries a
genuinely different outline per role — an SDR's (best accounts · who to contact · the angle ·
reply and meeting conversion) asks for analyses this skill does not contain, and bending it
to fit produces an approximation instead of an answer. Route those seats to `triage-leads`
or `focus` instead.

**Per-role report shapes come later, as their own skills** built on the role profiles, when
custom skills for personal profiles land. The role block still decides emphasis and what to
leave out *within* a report — that is `roleProfiles.mjs` and it already works. What it does
not do, yet, is choose the document.

## The design system

One accent, two semantic colours, one neutral. Defined once in `REPORT_COLORS`:

```
accent  #FF5C00   brand orange — primary series, the leader in a ranking
good    #2E7D66   won / healthy — never anything else
risk    #C5793C   watch / exposed
bad     #B95050   lost / at risk
neutral #94A3B8
```

**Colour is semantic, never decorative.** "Won" is the same green in every report in the
product, so a reader learns the language once and reads every later report faster. The model
may pass `good` / `risk` / `bad` / `accent` and **never a hex value** — the schema enforces
it.

A **ranking gets one colour with the leader emphasised** (accent at full strength, the rest
at `B3` alpha), not a rainbow: in a ranking, colour means nothing, and pretending otherwise
is decoration. Only `grouped` charts carry multiple colours, and then they are semantic.

Text, gridlines and axes come from theme tokens, not the palette, so one report is legible
in both themes without a second palette.

## Text against graphics

No global ratio — a ratio is unenforceable and the agent would pad to hit it. Three
per-section rules instead:

- **At most one chart per section.** Two charts means the section is two sections.
- **Lead with the visual, then say what it MEANS.** Never restate numbers the reader can
  see. This single instruction does the most work of anything in the doctrine.
- **Two sentences of prose, not five paragraphs.**

That lands at roughly one visual plus 2–4 sentences per section without ever naming a ratio.
Prose carries interpretation, causation and the recommendation — what a chart physically
cannot say.

**A section with no number, no series and no quote is not a section.** Cut it.

## Charts

Recharts, `isAnimationActive={false}` throughout (a report is not a dashboard),
`ResponsiveContainer` so it reflows at any dock width, bar height scaling with row count so
a ranking of twelve does not crush into a ranking of four.

A chart needs **a comparison or a trend, and at least four data points.** Three bars is a
sentence pretending to be a chart.

> ⚠️ The instructions say four; `ChartBlock` currently drops below **two**. The floor was
> left loose deliberately — silently dropping a chart the agent built is worse than drawing
> a thin one — but the two numbers should be reconciled.

**Gap: there are no diagrams.** Every graphic we render is quantitative. No funnel, no
buying-committee map, no flow. Each would need a new block type; the funnel is the
highest-value one to add.

## Tables

The most under-rated block: they carry multi-dimensional qualitative material a chart cannot
touch (pattern · behaviour · pipeline affected · priority).

- Header row on `bg-muted/50`, semibold, rounded top corners.
- **First column is the row label** — medium weight, full foreground.
- **`emphasis`** marks the one column a reader scans (a priority, a delta): semibold plus
  `tabular-nums`.
- Hairline row separators, none on the last row. **No vertical rules** — they fence data that
  should read as rows.
- `12.5px`, `align-top`, inside `overflow-x-auto`.
- On print, `thead { display: table-header-group }` repeats the header on every page.
- **`units`**, one per column (`usd` / `pct` / `days` / `count` / null). A unit column carries
  raw numbers and is formatted by the same `fmt` as a chart axis, digits aligned, never
  wrapped. Before it existed the model typed "$200K" into the recovery table — the one table
  people act on. The sanitizer also recovers "$200K" / "3.5M" as numbers when the model
  formats one anyway.

## Metrics

A metric is **a raw number plus a unit**, formatted by the same `fmt` that formats the chart
axis beside it. This was the last place the model formatted a value itself (`"$3.5M"`) —
the exact thing every other block forbids, in the most-read part of the document. `text` is
the escape hatch for a headline that genuinely is not a number ("3 of 10"), and a plain
string `value` still renders, because documents written before this carried one.

**Four at most**, and the row is as wide as its cards: a fixed four-column grid left two cards
sharing half a row and put a fifth alone on its own line.

## Widgets — the same blocks, inside a chat message

*GET-93, 2026-09-11.* A question with a shape ("report me on the pipeline last 7 days") gets
blocks too, drawn inline under the message that answered it: `present_answer`, rendered by
`AnswerBlocks`. Same vocabulary, same sanitizer (`apps/api/src/lib/reportBlocks.mjs`), same
renderer, so a table in a widget and a table in a report can never disagree.

Three containers, chosen by the size and the life of the answer — never by keywords:

| The answer | Container |
|---|---|
| one number, a yes or a no | a sentence |
| a trend, a ranking, A against B, rows with several attributes, a few headline numbers | `present_answer` — 1–3 blocks, inline |
| more than one section, or something kept, forwarded or reopened | `present_document` |

**The numbers come from `metrics`, never from the model.** Five measures — `touches`,
`stage_moves`, `pipeline_by_stage`, `deals_closed`, `new_accounts` — each groupable by time or
by category, over any window, counted in calendar days in the operator's timezone, and always
with the previous window of the same length beside it. A new question is a new combination of
those parameters, never a new tool. (`apps/api/src/lib/metrics.mjs`)

**The block follows the shape of the data.** `metrics` returns `suggested_block`, computed only
from whether the rows are a series over time or a set of categories, and how many there are:
under four → a metrics row, up to fourteen time buckets → columns, more → a line, categories →
a ranked bar. Nothing in it knows what the question was, which is what keeps it from becoming
a lookup table of question → chart.

**The widget IS the answer, not an illustration beside one.** *Product decision, 2026-09-11, on the first
real one.* The first version put four number cards under five paragraphs of findings — the
account list, the stage mix and the counts were all still prose, and the widget read as a
footnote. The rule: the findings go in the blocks. A named list of accounts with attributes is
a `table` with a what-to-do last column, never bullets in the message. Two to four blocks,
usually `metrics` → one `chart` of a series already pulled → `table` of the specific rows.

**Every widget carries its own `title` and `summary`, both required.** A name the way a figure
is named, then one to three sentences on what the blocks found — the finding, the number that
carries it, what to do. A widget is scrolled back to a week later with the conversation
forgotten, and a chart with no sentence around it is a number nobody can act on. The chat
message then shrinks to a line handing it over and the next move, because the summary already
carries the finding and saying it twice is the essay creeping back.

**A widget lands where the agent reached for it.** Text and tool calls are stored in separate
columns, so position is not recorded anywhere by default and every widget fell to the foot of
the message — which is wrong the moment an answer has two halves ("here is the week" … "and
here are the six deals to work"). The runner appends `[[widget:n]]` to the text when a
`present_answer` call returns, `n` being its index in `tool_calls`; the chat splits the content
on those markers and renders text, widget, text in order. The marker is **never yielded to the
live stream** (it would print mid-sentence, and the client swaps in the persisted message when
the turn ends) and is **stripped from the history** the model reads back, or it starts writing
markers into its own prose. A widget whose marker is missing — every turn written before this —
still renders, at the end, where it always did.

Nothing carries the closing line as a field, though. A `follow_up` string was built and cut the
same hour: the agent already ends a turn by asking for the next move, and a slot for it turns a
conversation into a form with a prompt in it. The line to draw is between the ARTIFACT and the
CONVERSATION — a title and a summary belong to the thing and survive being scrolled back to; a
closing question belongs to the exchange, and is the model's own sentence or nothing.

A widget is not saved. It replays from the turn's own `tool_calls` when a thread reopens, the
same way a document stub does. `callout` and `prose` are both refused in a widget: prose inside
it is the essay coming back.

## PDF export

The PDF is **this document, printed** — not a second layout engine. That is the payoff of
putting the design in CSS: change the look once and both surfaces move together, instead of
a renderer and an exporter drifting apart the way they always do.

Browser print (`window.print()`), no headless Chrome, no new container. The print block lives
at the foot of `apps/frontend/src/index.css`:

- Everything but `#report-print-root` is hidden with **`visibility`, not `display`.**
  Collapsing the layout reflows every recharts SVG to zero width at exactly the moment the
  page is captured, and the charts print blank. This is the bug that makes most print-to-PDF
  attempts look broken.
- `break-inside: avoid` on figures, tables, callouts and metric rows; headings never orphan.
- `print-color-adjust: exact` — a report whose won/lost bars print grey says nothing at all.
- A `print-only` masthead (workspace · kind, title, date), because paper carries no app
  chrome to say whose document this is.

> Open: no logo, and no per-page footer — on a three-page PDF only page one says whose report
> it is.

## Editing any of this

The renderer and the schema are in this repo. **The skill bodies are not** — they live in
`revenue-plugin`, and editing a `SKILL.md` there does nothing in-app until:

```
node scripts/sync-plugin-skills.mjs     # bakes apps/api/src/data/plugin-skills.json
# commit the manifest, then rebuild the api container
```

The app notes (`APP_NOTES`, `REPORT_BLOCKS_NOTE`) live in the sync script in **this** repo —
the app's copy of a skill is the plugin's words plus a stated difference, never a quietly
forked procedure. Check the diff of `plugin-skills.json` for unexpected `body` changes before
committing: the sync reads whatever branch `revenue-plugin` is checked out on.
