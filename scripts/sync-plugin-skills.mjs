#!/usr/bin/env node
//
// Pull the revenue plugin's skill library into the app.
//
// The plugin (github.com/NousC/revenue-plugin) is the source of truth for what skills exist —
// one `skills/<name>/SKILL.md` per skill, exactly the format Claude Code reads. The app
// needs the same list to show an operator what their agent knows how to do, but the app
// can't read another repo at runtime, so we generate a manifest and commit it.
//
//   node scripts/sync-plugin-skills.mjs            # ../revenue-plugin (or ../nous-plugin) next to this repo
//   NOUS_PLUGIN_DIR=/path/to/revenue-plugin node scripts/sync-plugin-skills.mjs
//
// Writes apps/api/src/data/plugin-skills.json. Re-run it whenever the plugin ships or
// renames a skill; the diff is the changelog. Deliberately NOT wired into the build —
// a generated file that regenerates itself silently is a file nobody reviews.
//
// The one thing this file owns that the plugin doesn't: GROUPS. The plugin's skills carry
// only `name` and `description` in their front-matter, and the grouping is prose in
// docs/revenue-plugin/skills-catalog.md. Until that lives in the front-matter, it lives here.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseSkillFile } from '../apps/api/src/lib/skillFile.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = process.env.NOUS_PLUGIN_DIR
  ? resolve(process.env.NOUS_PLUGIN_DIR)
  // The repo was renamed nous-plugin -> revenue-plugin (GET-210). A fresh clone lands in
  // revenue-plugin; older checkouts still sit in nous-plugin, so take whichever exists.
  : [resolve(REPO, '..', 'revenue-plugin'), resolve(REPO, '..', 'nous-plugin')].find((d) => existsSync(d))
    ?? resolve(REPO, '..', 'revenue-plugin');
const SKILLS_DIR = join(PLUGIN_DIR, 'plugins', 'opennous', 'skills');
const MANIFEST_JSON = join(REPO, 'apps', 'api', 'src', 'data', 'plugin-skills.json');

// The catalog's own sections, in the order an operator meets them: get set up, work the
// day, build and work an account, work the deal, read the pipeline, close the loop.
// Mirrors docs/revenue-plugin/skills-catalog.md.
const GROUPS = [
  { key: 'setup',      label: 'Setup & ingestion', blurb: 'Get the graph filled and keep it current.',        skills: ['onboard', 'welcome', 'status', 'sync', 'backfill'] },
  { key: 'daily',      label: 'Every day',         blurb: 'The morning worklist.',                            skills: ['focus'] },
  { key: 'account',    label: 'Accounts',          blurb: 'Build the record, then act on it.',                skills: ['build-record', 'plan-account', 'brief', 'meeting-prep', 'reach-out'] },
  { key: 'deal',       label: 'Deals',             blurb: 'Plans to win the one in front of you.',            skills: ['map-committee', 'objection-prep', 'forecast'] },
  { key: 'pipeline',   label: 'Pipeline',          blurb: 'Patterns across every account at once.',           skills: ['review-pipeline', 'whats-changed', 'triage-leads', 'ask-nous'] },
  { key: 'reporting',  label: 'Close the loop',    blurb: 'The one revenue report, and your seat\'s read of it.', skills: ['revenue-report', 'role-report'] },
  { key: 'automation', label: 'Automation',        blurb: 'The skills that run without being asked.',         skills: ['after-call', 'automate'] },
];

const groupOf = (name) => GROUPS.find(g => g.skills.includes(name))?.key ?? 'other';

// Which surfaces can actually RUN a skill.
//
// The plugin runs inside the operator's coding agent: their repo, their tokens, their
// shell. The in-app agent runs server-side with the same read primitives (get_context,
// get_account, query, score, whoami) but no repo, no file system, and — until the
// observations handler is a service — no `record`. A skill that needs any of those is
// plugin-only, and says why, because "it isn't in the app" is a fact somebody will ask
// about in three weeks.
// The other direction: a skill that only makes sense in the app. `connect_sources` puts a
// provider card on screen with a Configure button — there is no such thing in a terminal, and
// a coding agent onboards through `onboard` instead.
const APP_ONLY = {
  welcome: 'connects tools through cards in the chat; the plugin onboards via `onboard`',
  'welcome-seat': 'introduces one SEAT to a workspace that is already set up — a person joining a company, not a company being built. The plugin has no equivalent because a coding agent is never the surface a rep meets the product on',
};

const PLUGIN_ONLY = {
  'after-call':   'writes the follow-up into the operator\'s repo and needs `record`',
  automate:       'installs GitHub Actions in the operator\'s own repo',
  backfill:       'bulk ingestion on the agent\'s tokens; in the app the connectors do this',
  'build-record': 'open web research on the agent\'s tokens, then `record`',
  onboard:        'the app has its own onboarding surface; this one drives the plugin\'s',
  status:         'reports on the plugin install; the app answers this in Settings',
  sync:           'reads a transcript from the operator\'s repo and needs `record`',
};

// ── Where the report doctrine lives, and why it is NOT here ──
//
// It used to live in this file: a REPORT_BLOCKS_NOTE prepended to every skill flagged
// `report: true`. That worked for the skills on the list and failed for everything else —
// four report skills shipped with no idea blocks existed because nobody remembered to add
// the flag, and a skill the USER writes with `write_skill` could never be on a list that
// lives in our repo at all.
//
// So the doctrine moved onto the `present_document` TOOL, in playgroundAgent.mjs — its
// description and its `blocks` property. The tool is present on every turn regardless of
// which skill is driving, so a custom report skill written five minutes ago is taught the
// same vocabulary, the same colour rules and the same "a section with no number is not a
// section" as revenue-report. Choice belongs to the tool that does the thing; only the
// SECTIONS a particular report has belong to that report's note below.

// A skill that runs on both surfaces but does one step differently here. Appended to the
// seeded body after the general surface note, so the app's copy stays the plugin's words
// plus a stated difference — never a quietly forked procedure.
const APP_NOTES = {
  'role-report': {
    tools: ['whoami', 'reporting', 'insights', 'present_document'],
    note: [
      '- **The data for this exists here — read it, do not reconstruct it.** `reporting` returns',
      '  the recurring objections with the answer that has worked, how many accounts each hits,',
      '  and the lines buyers actually said. `insights` returns the recorded themes with their',
      '  quote and speaker. Cite both with `[n]` markers; the operator can open the call behind',
      '  each one. If a theme you want to state is not in what came back, say so plainly.',
    ].join('\n'),
  },
  // This one is a TEMPLATE, on purpose, and its ten sections are fixed (product decision, 2026-09-11;
  // recut 2026-09-22, GET-416). It is THE report — it absorbed win-loss, market-read and
  // team-report — written for the founder, the CRO, the VP Sales and the CS lead. Every section
  // is mapped rather than left to judgement: a fixed document with unmapped sections is how half
  // a report comes out as blocks and half as essay.
  //
  // The sections, the data recipes and the voice live in the PLUGIN's SKILL.md. This note carries
  // only what this surface adds: the tools, and which block renders each section.
  'revenue-report': {
    tools: ['whoami', 'revenue_report_data', 'crm_coverage_data', 'win_loss_data', 'customer_success_data', 'insights', 'metrics', 'get_account', 'present_document'],
    note: [
      '- **Budget: each tool ONCE.** load_skill, whoami, five payload tools, two metrics, one',
      '  get_account, then `present_document`. Never re-call a payload; never call `get_account`',
      '  for names (the payloads carry them). `supports` on each payload is binding.',
      '- **The section head carries two lines.** `kicker` is the FORMAL title ("Customer Health and',
      '  Retention Risk") and `label` is the quantified finding ("7 of 30 customers carry an',
      '  explicit risk signal"). The app draws the first as the heading and the second beneath it.',
      '- **No bold inside a sentence, no uppercase labels, no product-internal words.** A figure is',
      '  a number with one or two plain words under it; pass a ratio as `text` ("7 / 30").',
      '- Which block carries each section. The CONTENT is in the skill body; this is how it is drawn:',
      '  · 00 → `metrics` (4 counts) · `table` of sources · `callout` titled "Data Coverage Gap" · `prose`',
      '  · 01 → `metrics` (4 from `headline`) · `bullets` heading "Key Findings" · `prose`',
      '  · 02 → `bar` of `funnel` · `table` with `emphasis` on conversion · `metrics` · `prose`',
      '  · 03 → `metrics` (ratios as `text`) · `table` or `columns` · `evidence` (ONE quote) · `prose`',
      '  · 04 → `bar` or `table` of asks by product · `metrics` · `evidence` (ONE quote) · `prose`',
      '  · 05 → `path` from `win_loss_data.paths.patterns[0]` (`pct` per step from `paths.steps`,',
      '    `cohort` "of N lost opportunities", `compare` the won rate) · `grouped` won "good" vs',
      '    not-won "bad" · `table` of `taxonomy.causes` with `emphasis` on controllable ·',
      '    `timeline` of the ONE account from `get_account` · `prose`',
      '  · 06 → `metrics` · `bar` of signals by kind, EVERY kind returned and not the top three ·',
      '    `table` of tasks by the person they are for · `evidence` · `bullets`',
      '  · 07 → `prose` · `bullets` per grouped finding · `table` priority/finding/action/owner',
      '  · Data Notes → `table` field/detail',
      '- `more` on every list that previews a longer one, with `more_label` naming where the rest is.',
      '- **Close a section in `bullets`, never a paragraph.** Three to five lines, one sentence each.',
      '  A six-sentence block restating the figures above it is the way this document stops being read.',
      '- No `callout` except the titled "Data Coverage Gap". At most one chart per section.',
    ].join('\n'),
  },
  brief: {
    tools: ['present_brief'],
    note: [
      '- **Hand the brief over with `present_brief`, not `present_document`.** A brief is a prep',
      '  sheet read in the ninety seconds before a call, not a document somebody files — the tool',
      '  is prose-only for that reason, with no metric tiles or charts to reach for. Once you have',
      '  read the record, call it with the sections you would have written (Who · Where things stand ·',
      "  What's on their mind · Your angle · Watch-outs — skip any with nothing real in it), your",
      '  and your headline. **Leave out the final "The move" section** — on this surface the',
      '  recommendation goes in the CHAT line, as a question they can answer in one word, not',
      '  as the last paragraph of a document nobody can reply to. Keep the `[n]` citation',
      '  markers inside the section bodies:',
      '  they stay clickable in the card, so every line traces back to the call or email it came',
      '  from. Then write ONE line in the chat — do not repeat the brief underneath it.',
    ].join('\n'),
  },
  // GET-231. The meeting and its attendees come from `get_context` (meeting_prep) — the same
  // on both surfaces. What this note owns is the delivery: a meeting_brief document, the
  // attendees drawn as a real table.
  'meeting-prep': {
    tools: ['calendar', 'present_document'],
    note: [
      '- **Hand it over with `present_document`**, `kind: "meeting_brief"`, `focus` = the account,',
      '  `title` = the meeting title exactly as invited, and `headline` = the date line',
      '  ("Monday, September 14 · 1:00–2:00 PM · Harborline"). Not `present_brief`: a meeting brief',
      '  never opens with At a glance.',
      '- One section per heading, labels exactly as the skill writes them, in sentence case. The',
      '  **Attendees** section is a `table` block (headers Name · Company · Title · Role in the',
      '  deal · Last contact, their side first) with the one-line note under it as `body`. Every',
      '  other section is `body`: bullets or short prose, `[n]` markers kept in.',
      '- `calendar` only when the operator names a meeting that is not the account\'s next one',
      '  ("my Thursday call") — never as the first step; the account already carries the meeting.',
      '- Then ONE line in the chat: the objective for the call. Do not repeat the brief.',
    ].join('\n'),
  },
  'plan-account': {
    tools: ['present_document'],
    note: [
      '- **Hand the plan over as a document.** Call `present_document` (kind: "plan") with your sections (the',
      '  committee, the objections, deal health, ICP fit, the moves) and the headline. Keep the',
      '  `[n]` markers in the bodies so each line stays traceable. Then write ONE line in the',
      '  chat — the finding, and the move you would make — rather than repeating the plan.',
    ].join('\n'),
  },
  'reach-out': {
    tools: ['propose_email', 'propose_linkedin_message', 'propose_linkedin_invite'],
    note: [
      '- **You do not hand the draft back as text here.** Put it in front of the operator with',
      '  `propose_email`, `propose_linkedin_message` or `propose_linkedin_invite` — they approve,',
      '  edit and send it from the app, and the send is logged for you.',
      '- Skip the closing `record` step. This surface logs the touch when the message actually goes.',
    ].join('\n'),
  },
};

// The primitives a skill's body names. Read off the body rather than declared, because the
// body is what the model follows — if it says `record`, it will try to call `record`.
const PRIMITIVES = [
  'whoami', 'get_context', 'get_account', 'query', 'score', 'record_insight',
  'record_closed_deals', 'set_icp', 'record',
  // App-surface hand-offs: the agent stops the turn and the operator acts. Named here so a
  // skill that leans on them advertises them, like any other tool it calls.
  'connect_sources', 'ask_user', 'set_workspace_profile', 'complete_onboarding',
  'fetch_crm_stages', 'set_workspace_stages', 'get_workspace_stages',
  'get_workspace_pipelines', 'set_workspace_pipelines', 'write_skill',
];
function primitivesIn(body) {
  const found = new Set();
  for (const p of PRIMITIVES) if (new RegExp(`\`${p}\``).test(body)) found.add(p);
  // `record` matches inside `record_insight`; only count the bare verb.
  if (found.has('record') && !/`record`/.test(body)) found.delete('record');
  return [...found];
}

// What the in-app agent holds today. Anything else a skill names is a step it must skip
// here rather than fake — the surface note in the seeded body says so out loud.
const APP_TOOLS = new Set([
  'whoami', 'get_context', 'get_account', 'query', 'score', 'record_insight',
  // The in-app hand-offs. The plugin has no equivalent — a coding agent tells the operator
  // to run a command; the app puts the tool on screen — so these only ever appear here.
  'connect_sources', 'ask_user', 'set_workspace_profile', 'complete_onboarding',
  'fetch_crm_stages', 'set_workspace_stages', 'get_workspace_stages',
  'get_workspace_pipelines', 'set_workspace_pipelines', 'write_skill',
  // The revenue report's arithmetic, computed server-side. App-only: the plugin's agent
  // reads the same graph but this payload is built by the API.
  'revenue_report_data',
]);

/**
 * The one line a person reads. A plugin description is written for the MODEL — it opens with
 * what the skill does and then lists every phrase that should trigger it. Keep the first
 * sentence, drop the trigger list.
 */
function summarize(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  // Sentence-split that survives the quoted trigger phrases ("is Nous set up?", "who am I").
  const sentences = text.match(/[^.!?]+[.!?]?/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
  // A few skills lead with the trigger list rather than the job ("Use when the user asks…").
  // Take the first sentence that actually says what the skill does.
  const said = sentences.find(s => !/^use\s+(when|for|it|this)\b/i.test(s)) ?? sentences[0];
  const clean = said.split(/\s+Use (?:when|for|it)\b/i)[0].trim().replace(/[.\s]+$/, '');
  return clean.length > 160 ? `${clean.slice(0, 157).trimEnd()}…` : clean;
}

const gitRev = (dir) => {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
};

let dirs;
try {
  dirs = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
} catch {
  console.error(`No plugin skills at ${SKILLS_DIR}.\nClone github.com/NousC/revenue-plugin next to this repo, or set NOUS_PLUGIN_DIR.`);
  process.exit(1);
}

const skills = [];
for (const dir of dirs.sort()) {
  const { meta, body } = parseSkillFile(await readFile(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8'));
  const name = String(meta.name ?? dir).trim();
  if (!meta.description) { console.warn(`[SKIP] ${dir}: no description in front-matter`); continue; }
  const group = groupOf(name);
  if (group === 'other') console.warn(`[GROUP] ${name}: not in GROUPS — showing under "Other". Add it.`);
  const primitives = primitivesIn(body);
  skills.push({
    name,
    group,
    summary: summarize(meta.description),
    description: String(meta.description).replace(/\s+/g, ' ').trim(),
    // 'both' = the app seeds it for its own agent too. 'plugin' = coding agent only.
    surface: PLUGIN_ONLY[name] ? 'plugin' : APP_ONLY[name] ? 'app' : 'both',
    plugin_only_because: PLUGIN_ONLY[name] ?? null,
    app_only_because: APP_ONLY[name] ?? null,
    primitives,
    // The tools the in-app agent may use for it — the intersection, so a seeded skill
    // never advertises a tool that surface doesn't have.
    app_tools: [...new Set([...primitives.filter((t) => APP_TOOLS.has(t)), ...(APP_NOTES[name]?.tools ?? [])])],
    // A step this surface does differently, in its own words. How a report is BUILT is the
    // present_document tool's job, not this file's — see the note above APP_NOTES.
    app_note: APP_NOTES[name]?.note ?? null,
    // The procedure itself. The whole point of one source of truth: edit the SKILL.md in
    // revenue-plugin, re-run this, and both the plugin and the app carry the same words.
    body,
  });
}

// Catalog order, then alphabetical inside a group, so the file diffs cleanly.
const order = new Map(GROUPS.map((g, i) => [g.key, i]));
skills.sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99) || a.name.localeCompare(b.name));

let version = null;
try { version = JSON.parse(await readFile(join(PLUGIN_DIR, 'plugins', 'opennous', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null; } catch { /* optional */ }

const manifest = {
  schema_version: 1,
  source: { repo: 'NousC/revenue-plugin', plugin_version: version, commit: gitRev(PLUGIN_DIR) },
  generated_at: new Date().toISOString(),
  groups: GROUPS.map(({ key, label, blurb }) => ({ key, label, blurb })),
  skills,
};

await mkdir(dirname(MANIFEST_JSON), { recursive: true });
await writeFile(MANIFEST_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
const appCount = skills.filter((s) => s.surface === 'both' || s.surface === 'app').length;
console.log(`[PLUGIN SKILLS] ${skills.length} skills from ${manifest.source.plugin_version ?? '?'} (${manifest.source.commit ?? 'no git'}) → ${MANIFEST_JSON.replace(`${REPO}/`, '')}`);
console.log(`[PLUGIN SKILLS] ${appCount} run in the app agent too · ${skills.length - appCount} plugin-only`);
