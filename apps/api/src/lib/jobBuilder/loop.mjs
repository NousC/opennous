// The Job Builder's turn (GET-868): one user message -> a streamed tool loop that ends in plain
// text, an `ask`, or a `proposal` (JOB_BUILDER.md "Flow" and "Events").
//
// Everything with a side effect is injected (deps): the Anthropic client, the credit gate, the
// meter, validation, persistence, the tool helpers. That is how the tests drive a whole turn with
// a scripted model and no network; index.mjs wires the real ones.
//
// THE TRANSCRIPT STAYS VALID ANTHROPIC FORMAT. `ask` and `propose_job` end the turn on a tool_use
// that has no tool_result yet. The next turn opens by answering it (closePending): the answers to
// an ask become the ask's tool_result, a message after a proposal follows the proposal's result.
// Any other tool_use left open by an ended or failed turn is closed as "not run".
import { randomUUID } from 'node:crypto';
import { TOOL_DEFS, TERMINAL_TOOLS, BUILTIN_TOOL, runTool, runBuiltinTool, statusLabel, memo, clip, catalogTrigger, catalogLabel, catalogEntry, catalogEntries } from './tools.mjs';
import { buildSystemPrompt } from './prompt.mjs';
import { SLACK_FORMATS, triggersForSignals, signalKeysProblem, signalsLabel } from '@nous/core';
import { providerFailure } from '../providerAlert.mjs';

export const MAX_ROUNDS = 12;
export const MAX_TOKENS = 4096;
export const FEATURE = 'revbox-job-builder';

// Same caching as the in-app agent (playgroundAgent.mjs): the stable prefix (tools + system) on a
// 1-hour TTL, the moving tail on the default 5 minutes.
const CACHE_TTL = { type: 'ephemeral', ttl: '1h' };
const LAST_ROUND_NOTE = '\n\nThis is your last step this turn: call ask or propose_job now, or say briefly what is still open.';

/** One cache breakpoint on the last block of the conversation; any older one removed. */
export function markLatestForCache(messages) {
  stripCache(messages);
  const last = messages.at(-1);
  if (!last) return messages;
  if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
  const block = Array.isArray(last.content) ? last.content.at(-1) : null;
  if (block && typeof block === 'object') block.cache_control = { type: 'ephemeral' };
  return messages;
}
function stripCache(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && typeof b === 'object' && b.cache_control) delete b.cache_control;
  }
  return messages;
}

const text = (v, n) => String(v ?? '').trim().slice(0, n);

/** `{ answers: [{ id, selected: [labels], other? }] }` -> readable text, against the questions asked. */
export function renderAnswers(answers, questions = []) {
  const byId = new Map((questions ?? []).map(q => [String(q.id), q]));
  const lines = [];
  for (const a of Array.isArray(answers) ? answers.slice(0, 10) : []) {
    const q = byId.get(String(a?.id));
    const picked = (Array.isArray(a?.selected) ? a.selected : []).map(s => text(s, 200)).filter(Boolean);
    const other = text(a?.other, 2000);
    const said = [...picked, ...(other ? [`Other: ${other}`] : [])].join('; ') || '(no answer)';
    lines.push(`${q ? q.question : `Question ${text(a?.id, 40)}`}\n-> ${said}`);
  }
  return lines.join('\n\n') || '(no answers)';
}

/** Validate and tidy an ask's questions. -> { ok, questions } | { ok: false, error } */
export function normalizeQuestions(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (qs.length < 1 || qs.length > 3) return { ok: false, error: 'Ask 1 to 3 questions.' };
  const out = [];
  for (const [i, q] of qs.entries()) {
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map(o => ({ label: text(o?.label, 120), ...(text(o?.description, 300) ? { description: text(o.description, 300) } : {}) }))
      .filter(o => o.label);
    if (!text(q?.question, 500)) return { ok: false, error: `Question ${i + 1} has no text.` };
    if (options.length < 2 || options.length > 5) return { ok: false, error: `Question ${i + 1} needs 2 to 5 options.` };
    out.push({ id: text(q.id, 40) || `q${i + 1}`, header: text(q.header, 12) || `Question ${i + 1}`.slice(0, 12), question: text(q.question, 500), multi: q.multi === true, options });
  }
  return { ok: true, questions: out };
}

/** The proposal as the contract shapes it, defaults filled. Structure only; validate() does the rest. */
export function normalizeProposal(p) {
  return {
    name: text(p?.name, 120),
    summary: text(p?.summary, 600),
    trigger: p?.trigger && typeof p.trigger === 'object' ? { ...(text(p.trigger.signal_key, 120) ? { signal_key: text(p.trigger.signal_key, 120) } : {}), ...(Array.isArray(p.trigger.signal_keys) && p.trigger.signal_keys.length ? { signal_keys: p.trigger.signal_keys.slice(0, 21).map(k => text(k, 120)) } : {}), kind: String(p.trigger.kind ?? ''), config: p.trigger.config && typeof p.trigger.config === 'object' ? p.trigger.config : {}, ...(p.trigger.timezone ? { timezone: String(p.trigger.timezone) } : {}), label: text(p.trigger.label, 120) } : null,
    steps: Array.isArray(p?.steps) ? p.steps : [],
    display: Array.isArray(p?.display) ? p.display : [],
    uses_box_delivery: p?.uses_box_delivery === true,
    // The Slack layout the box's Slack destinations get (GET-872); only with box delivery.
    ...(p?.uses_box_delivery === true && typeof p?.box_delivery_format === 'string' && p.box_delivery_format ? { box_delivery_format: String(p.box_delivery_format).trim().toLowerCase() } : {}),
    warnings: Array.isArray(p?.warnings) ? p.warnings.slice(0, 10) : [],
    assumptions: Array.isArray(p?.assumptions) ? p.assumptions.map(a => text(a, 300)).filter(Boolean).slice(0, 10) : [],
    estimated_credits_per_run: Number.isFinite(Number(p?.estimated_credits_per_run)) ? Number(p.estimated_credits_per_run) : null,
    // The tables this job creates on approval, and the jobs still to set up in this chat (GET-874).
    ...(Array.isArray(p?.datasets) && p.datasets.length ? { datasets: p.datasets.slice(0, 5) } : {}),
    ...(Array.isArray(p?.next_jobs) && p.next_jobs.some(j => text(j, 120)) ? { next_jobs: p.next_jobs.map(j => text(j, 120)).filter(Boolean).slice(0, 5) } : {}),
  };
}

/**
 * Answer what the previous turn left open, then add the user's words. Returns the new user content.
 * `userText` is the rendered message or answers.
 */
export function closePending(messages, { userText, answers }) {
  const last = messages.at(-1);
  const content = [];
  let consumed = false;
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const uses = last.content.filter(b => b?.type === 'tool_use');
    const terminal = uses.find(b => TERMINAL_TOOLS.has(b.name));
    for (const u of uses) {
      let result = 'Not run: the turn ended before this tool ran. Call it again if you still need it.';
      if (u === terminal && u.name === 'ask') {
        result = answers ? `The user answered:\n\n${userText}` : `The user did not pick an option and wrote instead:\n\n${userText}`;
        consumed = true;
      } else if (u === terminal && u.name === 'propose_job') {
        result = 'The proposal was shown to the user. They did not approve it; their reply follows.';
      }
      content.push({ type: 'tool_result', tool_use_id: u.id, content: result });
    }
  }
  if (!consumed) content.push({ type: 'text', text: userText });
  return content;
}

const HINT_HEADER = "[Context from the composer, not the user's words]";
/** The user's own words in a text block: the composer's hint preamble removed. */
const ownWords = (t) => { const s = String(t ?? ''); if (!s.startsWith(HINT_HEADER)) return s.trim(); const cut = s.indexOf('\n\n'); return cut < 0 ? '' : s.slice(cut + 2).trim(); };

/**
 * The transcript with this turn's user part added (GET-889), before anything can fail, so the
 * message is saved even when the turn is not answered. A retry adds nothing (the unanswered turn is
 * already there); the same words sent again after a turn that got no answer are not added twice.
 */
export function withUserTurn(messages, { said, userText, answers = false, retry = false }) {
  const out = structuredClone(Array.isArray(messages) ? messages : []);
  if (retry) return out;
  const last = out.at(-1);
  if (!answers && last?.role === 'user' && Array.isArray(last.content)) {
    const lastText = [...last.content].reverse().find(b => b?.type === 'text');
    if (lastText && ownWords(lastText.text) === String(said ?? '').trim()) return out;
  }
  pushUser(out, closePending(out, { userText, answers }));
  return out;
}

/** Whether there is an unanswered turn to retry: the transcript ends on the user's side. */
export const canRetry = (messages) => Array.isArray(messages) && messages.at(-1)?.role === 'user' && messages.length > 0;

function pushUser(messages, content) {
  const last = messages.at(-1);
  // Two user messages in a row (a turn that failed after its tool results): merge, keep it valid.
  if (last?.role === 'user') {
    const prior = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
    last.content = [...prior, ...content];
  } else messages.push({ role: 'user', content });
}

function lastAskQuestions(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || !Array.isArray(last.content)) return [];
  const ask = last.content.find(b => b?.type === 'tool_use' && b.name === 'ask');
  return ask?.input?.questions ?? [];
}

/**
 * What an unfinished call used, as far as the stream told us: the SDK's running snapshot when it
 * has one, else what message_start/message_delta carried. null when nothing was reported (the call
 * never started), so there is nothing to meter.
 */
export function partialUsage(stream, seen = {}) {
  const u = stream?.currentMessage?.usage ?? seen.usage ?? null;
  if (!u || typeof u !== 'object') return null;
  const n = (k) => (Number.isFinite(Number(u[k])) ? Number(u[k]) : 0);
  const usage = {
    input_tokens: n('input_tokens'), output_tokens: n('output_tokens'),
    cache_creation_input_tokens: n('cache_creation_input_tokens'), cache_read_input_tokens: n('cache_read_input_tokens'),
    ...(u.cache_creation && typeof u.cache_creation === 'object' ? { cache_creation: u.cache_creation } : {}),
  };
  return usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens > 0 ? usage : null;
}

/**
 * The composer's hints as plain context at the top of the turn's user message. An attached
 * integration means the user wants that tool involved; the picked signal is the trigger unless their
 * words clearly say otherwise; no signal most likely means a scheduled run. null when there are none.
 */
export function renderHints(hints, catalog) {
  if (!hints) return null;
  const lines = [];
  const integrations = (hints.integrations ?? []).filter(Boolean);
  if (integrations.length) lines.push(`Integrations the user attached: ${integrations.join(', ')}. The user wants these tools involved in the job.`);
  const keys = hintKeys(hints);
  if (keys.length > 1) {
    // Several signals (GET-873): the job starts on any of them.
    const known = keys.filter(k => catalogTrigger(k, catalog));
    const unknown = keys.filter(k => !known.includes(k));
    if (known.length) lines.push(`Triggers the user picked: ${known.map(k => catalogLabel(k, catalog)).join(', ')} (signals ${known.map(k => `"${k}"`).join(', ')}). The job starts when any of them happens: call set_trigger with all of them as signals and use them as the job's trigger, unless the user's words clearly say otherwise.`);
    if (unknown.length) lines.push(`The user also picked ${unknown.map(k => `"${k}"`).join(', ')}, not in the signal catalog. Check signal_catalog and use the closest one, or ask.`);
  } else if (keys.length) {
    hints = { ...hints, signal: keys[0] };
    const known = catalogTrigger(hints.signal, catalog);
    lines.push(known
      ? `Trigger the user picked: ${catalogLabel(hints.signal, catalog)} (signal "${hints.signal}"). Use it as the job's trigger unless the user's words clearly say otherwise.`
      : `The user picked a trigger "${hints.signal}" that is not in the signal catalog. Check signal_catalog and use the closest one, or ask.`);
  } else {
    lines.push(NO_TRIGGER_HINT);
  }
  return `[Context from the composer, not the user's words]\n${lines.join('\n')}`;
}

/** The composer's picked signal keys: `signals`, or an older composer's single `signal`. */
export function hintKeys(hints) {
  if (Array.isArray(hints?.signals) && hints.signals.length) return hints.signals.filter(Boolean);
  return hints?.signal ? [hints.signal] : [];
}

// ── The trigger is settled with the user (GET-892) ───────────────────────────────

const NO_TRIGGER_HINT = 'Trigger the user picked: none. If their words do not say what starts the job (an event or a schedule), settle it with them before proposing: ask one question offering the 2-4 most fitting starts from signal_catalog plus "Something else". Never default to a schedule.';

/** What propose_job gets back when the user never grounded the trigger: ask, in one short instruction. */
export const TRIGGER_UNSETTLED = 'Not proposed: the user has not said what starts this job, and the trigger is never a silent default. Call ask with one question, "What should start this job?", offering the 2-4 most fitting starts from signal_catalog (e.g. "When a Granola meeting ends", "When a deal is won", "Every weekday morning"), your pick first with " (Recommended)", plus "Something else". Then set_trigger their answer and propose again.';

// How people name each start. A key must be named for the user's words to ground it.
const SIGNAL_WORDS = {
  schedule: /\b(every|each)\s+(single\s+)?(day|morning|afternoon|evening|night|week|weekday|business day|month|quarter|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b|\b(daily|weekly|monthly|quarterly|nightly|hourly|biweekly|fortnightly)\b|\bschedul(e|ed|es)\b|\bmornings?\b|\bweekdays?\b|\bat \d{1,2}(:\d{2})?\s*(am|pm)?\b|\bend of (the )?(day|week|month|quarter)\b|\bon a (clock|timer)\b/i,
  'meeting.done': /\b(meetings?|calls?|demos?|granola|fireflies|fathom|recorders?|note-?takers?|transcripts?)\b/i,
  'deal.won': /\b(won|wins?|winning|closed[- ]won|clos(e|es|ed|ing))\b/i,
  'deal.lost': /\b(lost|los(e|es|ing)|closed[- ]lost|clos(e|es|ed|ing))\b/i,
  'deal.stage_changed': /\b(stages?|moves?|moved|moving)\b/i,
  'icp.tier_changed': /\b(icp|tiers?)\b/i,
  'hubspot.field_changed': /\b(field|property|properties)\b[\s\S]*\b(chang|updat)|\b(chang|updat)\w*\b[\s\S]*\b(field|property)\b/i,
};
const loosely = (v) => ` ${String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Whether `words` name the start `key` ("after every call" names meeting.done). Pure. */
export function signalMentioned(key, words, catalog) {
  const base = String(key ?? '').split(':')[0];
  const said = String(words ?? '');
  if (!said.trim()) return false;
  if (SIGNAL_WORDS[base]) return SIGNAL_WORDS[base].test(said);
  // An account or workspace signal: its name, or every word of it, in what they said.
  const label = catalogEntry(base, catalog)?.label ?? base.split('.').slice(1).join(' ').replace(/_/g, ' ');
  const hay = loosely(said);
  if (hay.includes(loosely(label))) return true;
  const parts = loosely(label).trim().split(' ').filter(w => w.length >= 3);
  return parts.length > 0 && parts.every(w => hay.includes(` ${w}`));
}

/** The starts a question offers when it is about what starts the job (2+ options naming one, or it says so). */
export function isTriggerQuestion(q, catalog) {
  if (/\b(trigger|what should start|start (this|the) job|kick(s)? (it|this|the job) off|what starts)\b/i.test(`${q?.header ?? ''} ${q?.question ?? ''}`)) return true;
  const keys = [...catalogEntries(catalog).map(e => e.key)];
  const options = Array.isArray(q?.options) ? q.options : [];
  return options.filter(o => keys.some(k => signalMentioned(k, o?.label, catalog))).length >= 2;
}

/** The composer hints' picked keys in the transcript ('(signal "deal.won")', '(signals "a", "b")'). */
function hintedKeysIn(messages) {
  const keys = new Set();
  for (const m of messages ?? []) {
    if (m?.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'text' || !String(b.text ?? '').startsWith(HINT_HEADER)) continue;
      const head = String(b.text).split('\n\n')[0];
      for (const line of head.split('\n')) {
        if (!/^Triggers? the user picked:/.test(line)) continue;
        const inside = line.match(/\(signals? ((?:"[^"]+"(?:, )?)+)\)/);
        for (const k of inside?.[1]?.match(/"([^"]+)"/g) ?? []) keys.add(k.slice(1, -1));
      }
    }
  }
  return keys;
}

/** The user's own words in the transcript: their messages (hint preamble removed) and their answers. */
function userWordsIn(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (m?.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const b of blocks) {
      if (b?.type === 'text') out.push(ownWords(b.text));
      else if (b?.type === 'tool_result' && typeof b.content === 'string') {
        if (b.content.startsWith('The user answered:')) out.push(...b.content.split('\n').filter(l => l.startsWith('-> ')).map(l => l.slice(3)));
        else if (b.content.startsWith('The user did not pick an option and wrote instead:')) out.push(b.content.slice('The user did not pick an option and wrote instead:'.length));
      }
    }
  }
  return out.join('\n');
}

/** Whether a trigger question was asked and then answered in the transcript. */
function triggerQuestionAnswered(messages, catalog) {
  const asked = new Set();
  for (const m of messages ?? []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (m.role === 'assistant' && b?.type === 'tool_use' && b.name === 'ask' && (b.input?.questions ?? []).some(q => isTriggerQuestion(q, catalog))) asked.add(b.id);
      if (m.role === 'user' && b?.type === 'tool_result' && asked.has(b.tool_use_id) && /^The user (answered|did not pick)/.test(String(b.content ?? ''))) return true;
    }
  }
  return false;
}

const keysOf = (t) => (Array.isArray(t?.signal_keys) && t.signal_keys.length ? t.signal_keys : t?.signal_key ? [t.signal_key] : t?.kind === 'clock' ? ['schedule'] : []).map(String);
const sameKeys = (a, b) => a.length === b.length && a.every(k => b.includes(k));

/**
 * Whether the user grounded a proposal's trigger (GET-892) -> { ok, by } | { ok: false }. Grounded by:
 * the composer's picked signals, the user's own words naming every key, their answer to a question
 * about what starts the job, the job being edited keeping its trigger kind, or the trigger of the
 * proposal they were last shown. Anything else is a default nobody chose. Pure.
 */
export function triggerGrounding({ keys, kind, messages, catalog, job = null, priorProposal = null }) {
  const ks = (keys ?? []).map(String).filter(Boolean);
  if (!ks.length) return { ok: false };
  const hinted = hintedKeysIn(messages);
  if (hinted.size && ks.every(k => hinted.has(k) || hinted.has(k.split(':')[0]))) return { ok: true, by: 'hint' };
  const words = userWordsIn(messages);
  if (ks.every(k => signalMentioned(k, words, catalog))) return { ok: true, by: 'words' };
  if (triggerQuestionAnswered(messages, catalog)) return { ok: true, by: 'answer' };
  if (job?.trigger?.kind && job.trigger.kind === kind) return { ok: true, by: 'job' };
  if (priorProposal?.trigger && sameKeys(keysOf(priorProposal.trigger), ks)) return { ok: true, by: 'proposal' };
  return { ok: false };
}

/** A signal key checked against the catalog -> { ok, key, label, trigger } | { ok: false, error }. */
export function settleSignal(key, catalog) {
  const k = text(key, 120);
  const trigger = k ? catalogTrigger(k, catalog) : null;
  if (!trigger) return { ok: false, error: `"${k || '(none)'}" is not a trigger in the signal catalog. Call signal_catalog and use one of its keys (a meeting recorder as "meeting.done:<provider>").` };
  return { ok: true, key: k, label: catalogLabel(k, catalog), trigger };
}

/**
 * One or several signal keys checked against the catalog (GET-873) -> { ok, key (the first), keys,
 * label, trigger: { kind, config } } | { ok: false, error }. Several keys become one trigger: the
 * first kind is the primary and the others go into config.also (core triggersForSignals); a
 * schedule never combines with signals.
 */
export function settleSignals(keys, catalog) {
  const ks = [...new Set((Array.isArray(keys) ? keys : [keys]).map(k => text(k, 120)).filter(Boolean))];
  if (ks.length <= 1) { const s = settleSignal(ks[0], catalog); return s.ok ? { ...s, keys: [s.key] } : s; }
  for (const k of ks) { const one = settleSignal(k, catalog); if (!one.ok) return one; }
  const problem = signalKeysProblem(ks, catalog);
  const t = problem ? null : triggersForSignals(ks, catalog);
  if (!t) return { ok: false, error: problem ?? 'Those signals cannot start one job together.' };
  const { signal_keys: _keys, ...config } = t.trigger_config;
  return { ok: true, key: ks[0], keys: ks, label: signalsLabel(ks, catalog), trigger: { kind: t.trigger_kind, config } };
}

/**
 * The proposal's trigger made to be the catalog's mapping for its signal_key ("schedule" for a clock;
 * else the key set_trigger committed to this turn). The kind must match; the catalog's config keys win
 * over the model's (a clock keeps its own frequency/time). -> { ok, trigger, key, label } | { ok: false, error }
 */
export function catalogProposalTrigger(trigger, catalog, committed = null) {
  const ownKey = text(trigger?.signal_key, 120);
  const listed = Array.isArray(trigger?.signal_keys) ? trigger.signal_keys.map(k => text(k, 120)).filter(Boolean) : [];
  // Several signals (GET-873): trigger.signal_keys, or the ones set_trigger committed to when the
  // proposal names none or only the first of them.
  const many = listed.length > 1 ? listed : (!listed.length && committed?.keys?.length > 1 && (!ownKey || ownKey === committed.key)) ? committed.keys : null;
  if (many) return multiProposalTrigger(trigger, catalog, many);
  const key = listed[0] || ownKey || committed?.key || (trigger?.kind === 'clock' ? 'schedule' : '');
  if (!key) return { ok: false, error: 'trigger.signal_key is required: the signal_catalog key of the trigger (call set_trigger or signal_catalog).' };
  const s = settleSignal(key, catalog);
  if (!s.ok) return { ok: false, error: `trigger.signal_key: ${s.error}` };
  if (s.trigger.kind !== trigger?.kind) return { ok: false, error: `Signal "${s.key}" runs on trigger kind "${s.trigger.kind}" with config ${JSON.stringify(s.trigger.config ?? {})}, not "${trigger?.kind}". Use exactly that trigger.` };
  const own = trigger.config && typeof trigger.config === 'object' ? trigger.config : {};
  const config = s.trigger.kind === 'clock' ? { ...(s.trigger.config ?? {}), ...own } : { ...own, ...(s.trigger.config ?? {}) };
  const { signal_keys: _keys, ...single } = trigger;
  return { ok: true, key: s.key, keys: [s.key], label: s.trigger.kind === 'clock' ? (text(trigger.label, 120) || s.label) : s.label, trigger: { ...single, signal_key: s.key, kind: s.trigger.kind, config } };
}

/**
 * catalogProposalTrigger for several keys: the primary kind must match, the catalog's configs win
 * (the model's own keys kept, e.g. a HubSpot field's object and property), config.also is the
 * catalog's, and the label says every signal.
 */
function multiProposalTrigger(trigger, catalog, keys) {
  const s = settleSignals(keys, catalog);
  if (!s.ok) return { ok: false, error: `trigger.signal_keys: ${s.error}` };
  if (s.trigger.kind !== trigger?.kind) return { ok: false, error: `Signals ${s.keys.map(k => `"${k}"`).join(', ')} run on trigger kind "${s.trigger.kind}" with config ${JSON.stringify(s.trigger.config ?? {})}, not "${trigger?.kind}". Use exactly that trigger.` };
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const { also: ownAlso, signal_keys: _k, ...own } = isObj(trigger.config) ? trigger.config : {};
  const { also = [], ...primary } = s.trigger.config;
  const mine = (kind) => (Array.isArray(ownAlso) ? ownAlso.find(x => x?.kind === kind && isObj(x.config))?.config : null) ?? {};
  const config = { ...own, ...primary, ...(also.length ? { also: also.map(x => ({ kind: x.kind, config: { ...mine(x.kind), ...x.config } })) } : {}) };
  return { ok: true, key: s.key, keys: s.keys, label: s.label, trigger: { ...trigger, signal_key: s.key, signal_keys: s.keys, kind: s.trigger.kind, config, label: s.label } };
}

/**
 * Whether an ask question is about timing (a time of day, a frequency, a schedule). An event job runs
 * as soon as its event happens, so it never asks one (product owner, GET-858). Pure.
 */
const TIME_WORDS = /\b(time|times|timing|schedule|scheduled|frequency|how often|what hour|which day|time ?zone|when should (it|this|the (job|report|summary|message|email|draft)) (run|go out|arrive|be sent|post|send))\b/i;
const TIME_OPTION = /^\s*(\d{1,2}(:\d{2})?\s*(am|pm)?|daily|weekly|monthly|quarterly|every (day|morning|evening|week|weekday|month|monday|tuesday|wednesday|thursday|friday))\b/i;
export function isTimeQuestion(q) {
  if (TIME_WORDS.test(`${q?.header ?? ''} ${q?.question ?? ''}`)) return true;
  const options = Array.isArray(q?.options) ? q.options : [];
  return options.length > 0 && options.filter(o => TIME_OPTION.test(String(o?.label ?? ''))).length >= Math.ceil(options.length / 2);
}
const TIME_DROPPED = 'Not asked: this job starts on an event, so it runs as soon as the event happens. Never ask an event-triggered job for a time, frequency or schedule, and never put one in the proposal.';

// The connection slug each step type and trigger needs (workspace_connections slugs).
const STEP_SLUG = { hubspot: 'hubspot', slack: 'slack' };
const RECORDERS = ['granola', 'fireflies', 'fathom'];
/**
 * The integrations a job uses: the trigger's provider (a meeting recorder, HubSpot for a HubSpot field
 * change), then each step's tool in order (a gmail step is Gmail, or SMTP when it sends from an SMTP
 * mailbox; an email step with a mailbox is SMTP). A plain meeting.done uses whichever recorders are
 * connected (`connected`, slugs). Pure. -> [slug]
 */
export function jobIntegrations(proposal, connected = []) {
  const out = [];
  const add = (slug) => { if (slug && !out.includes(slug)) out.push(slug); };
  const t = proposal?.trigger ?? {};
  // Every signal the job starts on (GET-873): signal_keys, else the one signal_key.
  const keys = (Array.isArray(t.signal_keys) && t.signal_keys.length ? t.signal_keys : t.signal_key ? [t.signal_key] : []).map(String);
  const kinds = [t.kind, ...(Array.isArray(t.config?.also) ? t.config.also.map(x => x?.kind) : [])];
  let anyRecorder = !keys.length && kinds.includes('call_ended');
  for (const key of keys) {
    const [base, provider] = key.split(':');
    if (base !== 'meeting.done') continue;
    if (provider && provider !== 'any') add(provider); else anyRecorder = true;
  }
  if (anyRecorder) for (const r of (connected ?? []).filter(c => RECORDERS.includes(c))) add(r);
  if (keys.some(k => k.split(':')[0] === 'hubspot.field_changed') || kinds.includes('hubspot_field_changed')) add('hubspot');
  for (const st of Array.isArray(proposal?.steps) ? proposal.steps : []) {
    if (STEP_SLUG[st?.type]) add(STEP_SLUG[st.type]);
    else if (st?.type === 'gmail') add(st.config?.send_from?.kind === 'smtp' ? 'smtp' : 'gmail');
    else if (st?.type === 'email' && st.config?.send_from?.id) add('smtp');
  }
  return out;
}

/** A Slack step's layout (GET-858) must be one the renderer has. Pure. -> error strings */
export function slackLayoutProblems(steps) {
  return (Array.isArray(steps) ? steps : []).filter(s => s?.type === 'slack' && s.config?.format != null && !SLACK_FORMATS.includes(s.config.format))
    .map(s => `Step "${s.id}": "${s.config.format}" is not a Slack layout. Use one of ${SLACK_FORMATS.join(', ')}.`);
}

/**
 * What validateBuilderProposal checks a proposal's targets against, from the workspace as it is now:
 * the real Slack channels, Slack people (for DM steps) and mailboxes, as ids (the check) and as
 * { id, name|email } (the names on the card's facts), and, when the job ends in box delivery, the
 * box's current destinations (a Slack step to one of them would post twice). Approve passes the same.
 */
export async function idsForValidation(proposal, cached) {
  const types = new Set((proposal?.steps ?? []).map(s => s?.type));
  const slackChannelIds = [], slackUserIds = [], mailboxIds = [];
  const out = { slackChannelIds, slackUserIds, mailboxIds };
  if (types.has('slack')) {
    const t = await cached.slack().catch(() => ({ channels: [], people: [] }));
    out.slackChannels = (t.channels ?? []).map(c => ({ id: c.id, name: c.name ?? null }));
    out.slackPeople = (t.people ?? []).map(p => ({ id: p.id, name: p.name ?? p.real_name ?? null }));
    for (const c of out.slackChannels) slackChannelIds.push(c.id);
    for (const p of out.slackPeople) slackUserIds.push(p.id);
  }
  if (types.has('gmail') || types.has('email')) {
    out.mailboxes = (await cached.mailboxes().catch(() => [])).map(m => ({ id: m.id, email: m.email ?? null }));
    for (const m of out.mailboxes) mailboxIds.push(m.id);
  }
  // The box's tables (GET-874), when a step reads or adds to one or the proposal creates one.
  if ((types.has('dataset_append') || types.has('dataset_read') || (Array.isArray(proposal?.datasets) && proposal.datasets.length)) && cached.datasets) {
    // A lookup that fails checks the shape only (no `datasets`); approve reads the box's tables itself.
    const got = await cached.datasets().catch(() => null);
    if (Array.isArray(got)) out.datasets = got.map(d => ({ key: d.key, name: d.name ?? null, columns: d.columns ?? [] }));
  }
  if (proposal?.uses_box_delivery === true && cached.box) {
    const box = await cached.box().catch(() => null);
    if (box) out.boxDestinations = Array.isArray(box.delivery) ? box.delivery : [];
  }
  return out;
}

/**
 * One builder turn. Yields the contract's events and always ends with { type: 'done' }.
 *
 * deps = { client, model: { modelId, thinking, effort }, helpers, gate(), meter({ response, requestId, costUsd }),
 *          costOf(model, usage), toCredits(usd), validate(proposal, ids), save({ messages, proposal }),
 *          job?, builtin? (a built-in job's chat, GET-902: helpers.builtinInfo's answer), signal?, today?,
 *          provider? ('openrouter' | 'anthropic', for the alert), alert? (providerAlert) }
 */
export async function* runBuilderTurn({ session, isNew = false, message = null, answers = null, hints = null, retry = false, ctx, deps }) {
  if (isNew) yield { type: 'session', session_id: session.id };
  if (retry && !canRetry(session.messages)) {
    yield { type: 'error', code: 'nothing_to_retry', message: 'There is nothing to try again: the last message was answered.' };
    yield { type: 'done' };
    return;
  }
  let proposal = session.proposal ?? null;
  const cached = memo(deps.helpers, ctx);
  const said = retry ? '' : answers ? renderAnswers(answers, lastAskQuestions(session.messages ?? [])) : text(message, 8000);
  // A built-in's chat (GET-902) is mostly about the built-in: the composer's "no trigger picked" note
  // is left out unless the person attached something (it would push the agent to ask what starts a job).
  const builtin = deps.builtin ?? null;
  const hinting = hints && !retry && (!builtin || hintKeys(hints).length > 0 || (hints.integrations ?? []).length > 0);
  const hintText = hinting ? renderHints(hints, await cached.catalog().catch(() => [])) : null;
  const userText = hintText ? `${hintText}\n\n${said}` : said;
  // The user's part goes in first (GET-889): whatever happens next, it is saved and shows on reopen.
  const messages = withUserTurn(session.messages ?? [], { said, userText, answers: !!answers, retry });
  // A turn writes the transcript and the proposal only. The session's state is approve's (core
  // saveBuilderSession leaves it alone, and a turn that finishes after approval changes nothing).
  const save = async () => { await deps.save({ messages: stripCache(messages), proposal }); };
  const saveOrSay = async function* () {
    try { await save(); } catch (err) {
      console.error('[job-builder] save failed', err?.message ?? err);
      yield { type: 'error', code: err?.builderCode ?? 'save_failed', message: err?.builderCode ? err.message : 'This conversation could not be saved.' };
    }
  };

  try {
    await deps.gate();
  } catch (err) {
    yield { type: 'error', code: err.status === 402 ? 'insufficient_credits' : 'unavailable', message: err.message || 'Credits are required.' };
    yield* saveOrSay();
    yield { type: 'done' };
    return;
  }

  // A built-in job's chat (GET-902): its facts in the prompt and the builtin_job tool.
  const system = buildSystemPrompt({ today: deps.today ?? new Date().toISOString().slice(0, 10), job: deps.job ?? null, builtin });
  const tools = builtin ? [...TOOL_DEFS, BUILTIN_TOOL] : TOOL_DEFS;
  let costUsd = 0;
  let ended = false;
  let committed = null;   // the trigger set_trigger settled this turn
  // An event job (set_trigger committed a non-schedule signal, or the composer picked one) never asks about time.
  const hinted = hintKeys(hints);
  const hintedEvent = hinted.length ? await cached.catalog().then(c => hinted.some(k => { const t = catalogTrigger(k, c); return !!t && t.kind !== 'clock'; })).catch(() => false) : false;
  const eventJob = () => (committed ? committed.trigger.kind !== 'clock' : hintedEvent);
  try {
    for (let round = 0; round < MAX_ROUNDS && !ended; round++) {
      if (deps.signal?.aborted) break;
      const params = {
        model: deps.model.modelId,
        max_tokens: MAX_TOKENS,
        system: [{ type: 'text', text: round === MAX_ROUNDS - 1 ? system + LAST_ROUND_NOTE : system, cache_control: CACHE_TTL }],
        tools,
        messages: markLatestForCache(messages),
      };
      if (deps.model.thinking) {
        params.output_config = { effort: deps.model.effort };
        params.thinking = { type: 'adaptive', display: 'summarized' };
      }
      const stream = deps.client.messages.stream(params, deps.signal ? { signal: deps.signal } : undefined);
      // Every call is metered exactly once, under its own request id: from the final message when
      // the stream finishes, else (aborted, errored, the reader went away) from the usage the stream
      // reported so far. Input tokens, cache writes included, are billed the moment the call starts.
      const requestId = `${FEATURE}:${session.id}:${randomUUID()}`;
      const seen = { model: null, usage: null };
      let resp = null;
      try {
        for await (const ev of stream) {
          if (ev.type === 'message_start' && ev.message) { seen.model = ev.message.model ?? null; seen.usage = { ...(ev.message.usage ?? {}) }; }
          else if (ev.type === 'message_delta' && ev.usage) seen.usage = { ...(seen.usage ?? {}), ...ev.usage };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'text', text: ev.delta.text };
        }
        resp = await stream.finalMessage();
      } finally {
        if (!resp) {
          // Never masks the error that got us here; a failure to meter is logged.
          try {
            const usage = partialUsage(stream, seen);
            if (usage) {
              const model = stream.currentMessage?.model ?? seen.model ?? deps.model.modelId;
              const partCost = deps.costOf(model, usage);
              costUsd += partCost;
              await deps.meter({ response: { model, usage, partial: true }, requestId, costUsd: partCost });
            }
          } catch (err) {
            console.error('[job-builder] metering an unfinished call failed', err?.message ?? err);
          }
        }
      }

      // Metered durably, every call, before anything else is paid for (recordRevboxUsage).
      const callCost = deps.costOf(resp.model ?? deps.model.modelId, resp.usage);
      costUsd += callCost;
      try {
        await deps.meter({ response: resp, requestId, costUsd: callCost });
      } catch (err) {
        throw Object.assign(new Error(`metering failed: ${err?.message ?? err}`), { builderCode: 'metering_failed' });
      }

      messages.push({ role: 'assistant', content: resp.content });
      if (resp.stop_reason === 'max_tokens') {
        yield { type: 'text', text: '\n\n(I ran out of room. Tell me to continue.)' };
        ended = true; break;
      }
      const uses = resp.content.filter(b => b.type === 'tool_use');
      if (!uses.length || resp.stop_reason !== 'tool_use') { ended = true; break; }

      // A terminal tool first: when it holds, the turn ends here and the other calls stay unrun
      // (closePending answers them next turn).
      const terminal = uses.find(u => TERMINAL_TOOLS.has(u.name));
      const results = [];
      let terminalError = null;
      if (terminal?.name === 'ask') {
        // An event job: a question about time is dropped (and the transcript keeps only what was asked).
        if (eventJob() && Array.isArray(terminal.input?.questions)) {
          const kept = terminal.input.questions.filter(x => !isTimeQuestion(x));
          if (kept.length !== terminal.input.questions.length) terminal.input = { ...terminal.input, questions: kept };
        }
        const q = terminal.input?.questions?.length === 0 ? { ok: false, error: TIME_DROPPED } : normalizeQuestions(terminal.input);
        if (q.ok) {
          yield { type: 'ask', questions: q.questions };
          ended = true; break;
        }
        terminalError = q.error;
        yield { type: 'tool', name: 'ask', state: 'error', summary: q.error };
      } else if (terminal?.name === 'propose_job') {
        yield { type: 'status', text: statusLabel('propose_job') };
        yield { type: 'tool', name: 'propose_job', state: 'start' };
        const p = normalizeProposal(terminal.input);
        const structural = [];
        if (!p.name) structural.push('name is required');
        if (!p.trigger?.kind) structural.push('trigger.kind is required');
        if (!p.steps.length) structural.push('steps must not be empty');
        structural.push(...slackLayoutProblems(p.steps));
        let settled = null;
        let unsettled = false;
        if (!structural.length) {
          const catalog = await cached.catalog().catch(err => { console.error('[job-builder] signal catalog', err?.message ?? err); return null; });
          if (catalog) {
            settled = catalogProposalTrigger(p.trigger, catalog, committed);
            if (settled.ok) p.trigger = settled.trigger; else structural.push(settled.error);
            // The trigger is the user's, never a default (GET-892): refused back with an instruction to ask.
            if (settled.ok && !triggerGrounding({ keys: settled.keys, kind: settled.trigger.kind, messages, catalog, job: deps.job ?? null, priorProposal: session.proposal ?? null }).ok) {
              structural.length = 0; structural.push(TRIGGER_UNSETTLED); unsettled = true;
            }
          }
        }
        const v = structural.length ? { ok: false, errors: structural } : await deps.validate(p, await idsForValidation(p, cached));
        if (v.ok) {
          // The card shows what each step really touches (validateBuilderProposal's facts, derived
          // from the steps), never only the model's own display titles, and the brief (GET-884): its
          // one sentence, built by the engine from the same facts. normalizeProposal drops a model's own.
          proposal = { ...p, ...(Array.isArray(v.facts) ? { facts: v.facts } : {}), ...(v.brief ? { brief: v.brief } : {}) };
          yield { type: 'tool', name: 'propose_job', state: 'done', summary: `Proposed "${p.name}"` };
          // The tools the job uses, settled: the composer attaches them (the user never has to).
          const plainMeeting = (p.trigger.signal_keys ?? [p.trigger.signal_key]).some(k => /^meeting\.done(:any)?$/.test(String(k ?? '')));
          const connected = plainMeeting && deps.helpers.connections ? (await Promise.resolve(deps.helpers.connections(ctx)).catch(() => [])).map(c => c.slug) : [];
          const slugs = jobIntegrations(p, connected);
          if (slugs.length) yield { type: 'integrations', slugs };
          const signal = settled?.key ?? p.trigger.signal_key ?? (p.trigger.kind === 'clock' ? 'schedule' : null);
          yield { type: 'trigger', signal, signals: settled?.keys ?? p.trigger.signal_keys ?? (signal ? [signal] : []), label: settled?.label ?? p.trigger.label ?? null };
          yield { type: 'proposal', proposal };
          ended = true; break;
        }
        const errors = (v.errors ?? []).map(e => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)));
        terminalError = unsettled ? TRIGGER_UNSETTLED : `The proposal did not validate. Fix these and call propose_job again:\n- ${errors.join('\n- ')}`;
        yield { type: 'tool', name: 'propose_job', state: 'error', summary: unsettled ? 'Asking what should start the job' : `Needs fixing: ${errors.slice(0, 2).join('; ')}` };
      }

      for (const u of uses) {
        if (u === terminal) { results.push({ type: 'tool_result', tool_use_id: u.id, content: terminalError, is_error: true }); continue; }
        if (TERMINAL_TOOLS.has(u.name)) { results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Call one of ask or propose_job at a time.', is_error: true }); continue; }
        if (u.name === 'set_trigger') {
          yield { type: 'status', text: statusLabel(u.name, u.input) };
          yield { type: 'tool', name: u.name, state: 'start' };
          const catalog = await cached.catalog().catch(() => null);
          // One signal ({ signal }) or several ({ signals }, GET-873).
          const asked = Array.isArray(u.input?.signals) && u.input.signals.length ? u.input.signals : u.input?.signal;
          let s = catalog ? settleSignals(asked, catalog) : { ok: false, error: 'The signal catalog is not available right now. Try again.' };
          // A named recorder must be connected (GET-892): the catalog offers only those.
          if (s.ok) {
            const named = s.keys.map(k => k.split(':')).filter(([base, p]) => base === 'meeting.done' && p && p !== 'any').map(([, p]) => p);
            const have = named.length ? await cached.recorders().catch(() => null) : null;
            const missing = have ? named.filter(p => !have.includes(p)) : [];
            if (missing.length) s = { ok: false, error: `${missing.join(', ')} is not connected. ${have.length ? `Connected recorders: ${have.join(', ')}; use "meeting.done:<one of them>" or plain "meeting.done".` : 'No meeting recorder is connected: ask the user to connect one, and warn with a fix to connect it.'}` };
          }
          if (!s.ok) {
            yield { type: 'tool', name: u.name, state: 'error', summary: s.error.slice(0, 300) };
            results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${s.error}`, is_error: true });
            continue;
          }
          committed = s;
          yield { type: 'tool', name: u.name, state: 'done', summary: `Trigger: ${s.label}` };
          yield { type: 'trigger', signal: s.key, signals: s.keys, label: s.label };
          const many = s.keys.length > 1;
          results.push({ type: 'tool_result', tool_use_id: u.id, content: clip({ ok: true, signal_key: s.key, ...(many ? { signal_keys: s.keys } : {}), label: s.label, trigger: s.trigger, note: many
            ? `In propose_job use trigger.signal_keys ${JSON.stringify(s.keys)}, trigger.signal_key "${s.key}" and exactly this kind and config (config.also holds the other triggers; the job runs once per event).`
            : `In propose_job use trigger.signal_key "${s.key}" with exactly this kind and config${s.trigger.kind === 'clock' ? ' (plus the frequency, time and timezone)' : ''}.` }) });
          continue;
        }
        yield { type: 'status', text: statusLabel(u.name, u.input) };
        yield { type: 'tool', name: u.name, state: 'start' };
        if (u.name === 'builtin_job') {
          try {
            const out = await runBuiltinTool(u.input, { helpers: deps.helpers, ctx, builtin });
            yield { type: 'tool', name: u.name, state: 'done', summary: out.summary };
            // The page refreshes the box (its card's On/Off, the voice file in Context).
            if (out.changed) yield { type: 'builtin', ...out.changed };
            results.push({ type: 'tool_result', tool_use_id: u.id, content: clip(out.result) });
          } catch (err) {
            const msg = String(err?.message ?? err).slice(0, 300);
            yield { type: 'tool', name: u.name, state: 'error', summary: msg };
            results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${msg}`, is_error: true });
          }
          continue;
        }
        try {
          const out = await runTool(u.name, u.input, { helpers: deps.helpers, ctx, cached });
          yield { type: 'tool', name: u.name, state: 'done', summary: out.summary };
          results.push({ type: 'tool_result', tool_use_id: u.id, content: clip(out.result) });
        } catch (err) {
          const msg = String(err?.message ?? err).slice(0, 300);
          yield { type: 'tool', name: u.name, state: 'error', summary: msg };
          results.push({ type: 'tool_result', tool_use_id: u.id, content: `Error: ${msg}`, is_error: true });
        }
      }
      pushUser(messages, results);
    }
    if (!ended && !deps.signal?.aborted) {
      yield { type: 'text', text: 'I could not finish setting this up in one go. Tell me what to look at next, or answer what I asked.' };
    }
  } catch (err) {
    if (!deps.signal?.aborted) {
      console.error('[job-builder]', err?.message ?? err);
      // A provider refusal (out of credit, key rejected, busy) says so, and ops hear about it once
      // per incident (GET-885). Our own failures (metering) keep their code and the generic words.
      const f = err?.builderCode ? null : providerFailure(err, { provider: deps.provider ?? 'anthropic', feature: FEATURE, subject: "The job builder's AI model", ...(deps.alert ? { alert: deps.alert } : {}), ...(deps.selfHosted !== undefined ? { selfHosted: deps.selfHosted } : {}) });
      yield { type: 'error', code: f?.code ?? err?.builderCode ?? 'builder_failed', message: f?.message ?? 'The job builder hit an error. Try again.' };
    }
  }
  yield* saveOrSay();
  yield { type: 'credits', credits: deps.toCredits(costUsd) };
  yield { type: 'done' };
}

/** The non-streaming view of a turn (POST /v2/revboxes/:id/jobs/builder). */
export function collectTurn(events) {
  const out = { session_id: null, events, state: 'text' };
  for (const e of events) {
    if (e.type === 'session') out.session_id = e.session_id;
    if (e.type === 'ask') { out.state = 'asking'; out.questions = e.questions; }
    if (e.type === 'trigger') out.trigger = { signal: e.signal, signals: e.signals ?? (e.signal ? [e.signal] : []), label: e.label };
    if (e.type === 'integrations') out.integrations = e.slugs;
    if (e.type === 'proposal') { out.state = 'proposed'; out.proposal = e.proposal; }
    if (e.type === 'error' && !out.error) out.error = { code: e.code, message: e.message };
  }
  return out;
}
