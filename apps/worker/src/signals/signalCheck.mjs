// A second read of the deal signals, in context, before they are filed (GET-1033).
//
// The extractor reads a conversation in one pass on the cheapest model, and nothing checked what it
// wrote. A signal is what reaches the Events page, the health score and the automations, so a wrong
// one costs more than a missed one: a customer's own bot filed as a competitor, "no tool is a silver
// bullet" as an objection, chips like "Asked for more" that only made sense on the call.
//
// So the deal signals of each part of a conversation (most conversations are one part) get one more
// call, on a stronger model, with the account brief and the text they came from: each is kept,
// rewritten (sentence, chip or category) or dropped. Only deal signals are checked; a part with none
// costs nothing. A failed check keeps every signal as the extractor wrote it.
import { CLAIM_CATEGORY_KEYS, insightBoardModel } from '@nous/core';
import { createMessage, parseJsonArray } from '../lib/llm.mjs';
import { accountBriefBlock } from './accountBrief.mjs';

// What reaches the Events page, the deal health and the automations.
export const CHECKED = new Set(['objection', 'competitor', 'blocker', 'buying_signal', 'expansion_signal', 'authority', 'risk_signal', 'requirement']);
// A whole extraction part (14,000 characters) fits. Longer text (a re-check of a whole call) is cut
// to windows around each signal's quote, so no signal is judged without its evidence.
const TEXT_CHARS = 16_000;
const QUOTE_WINDOW = 2_500;
const MAX_SIGNALS = 15;
// Moving a signal into one of these needs the tag that makes it readable downstream; without it the
// move is refused and the signal keeps its category.
const NEEDS = { competitor: ['entity', 'stance'], tech_stack: ['tool'], expansion_signal: ['product', 'stance'] };
const STANCES = { competitor: ['evaluating', 'incumbent', 'past_failure', 'mentioned'], expansion_signal: ['asked', 'considering', 'declined'] };
const TAGS = ['entity', 'stance', 'tool', 'status', 'hardness', 'role', 'product', 'severity'];
// Chips the code builds from the category's own tag (claimLabel): a model's chip for these is never used.
export const CODE_CHIPS = new Set(['competitor', 'tech_stack', 'budget', 'authority']);

// The fields that belong to one category only; a signal moved to another category loses them.
const FIELD_HOME = {
  entity: ['competitor'], stance: ['competitor', 'expansion_signal'], tool: ['tech_stack'], status: ['objection', 'blocker'],
  hardness: ['objection'], role: ['authority'], product: ['expansion_signal'], severity: ['risk_signal'],
};

// GET-1033. Each line was read on its own and filed as what its words looked like: "no tool is a
// silver bullet" an objection, a customer's own bot a competitor, "their bot vs our data" a competitor
// being evaluated, chips like "Asked for more" that only made sense on the call.
export const READ_IN_CONTEXT = `READ EACH STATEMENT IN CONTEXT — the quote is the evidence; the fact is what it MEANS, given the whole conversation and the ACCOUNT CONTEXT:
- Before filing a line, ask what they are actually doing and why. A line that is a step in a test, an aside, a joke, a question or someone else's view is not a position.
- Write the fact so a colleague who was not there understands it: what, about what, and why it matters for the deal. "Testing their own sales bot on their CRM's own data source against ours to see which answers better", not "Comparing data".
- An objection is THEIR pushback against buying or using US, with its reason. A general remark about AI, agents or tools ("no tool is a silver bullet", "agents get things wrong") is a market view, not an objection.
- Their OWN tools, including one they built themselves (an internal bot, agent or script), are tech_stack, never competitor, however much they rely on it.
- When they compare data sources or vendors to feed their own tool, the competitor is the OTHER source that does the job we do (stance "evaluating"), named as that vendor. Never their own tool, and never "X vs us" as a name.
- A person's name is not a signal. "Ines onboarding" says nothing; "Their head of CS is onboarding first, to roll it out to the CS team" does.
- If you cannot say what a line means for the deal, it is not a fact. Leave it out.`;

/**
 * The text the checker reads: all of it when it fits, else windows around each signal's quote (and
 * the opening, for who is who), in order, joined with "…". Pure.
 */
export function excerptFor(text, signals, max = TEXT_CHARS) {
  const body = String(text ?? '');
  if (body.length <= max) return body;
  const spans = [[0, Math.min(QUOTE_WINDOW, body.length)]];
  const lower = body.toLowerCase();
  for (const f of signals) {
    const q = String(f?.quote ?? '').trim().toLowerCase();
    const at = q ? lower.indexOf(q.slice(0, 80)) : -1;
    if (at >= 0) spans.push([Math.max(0, at - QUOTE_WINDOW), Math.min(body.length, at + q.length + QUOTE_WINDOW)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  let out = '';
  for (const [a, b] of merged) {
    const piece = body.slice(a, b);
    if (out.length + piece.length > max) { out += `${out ? '\n…\n' : ''}${piece.slice(0, Math.max(0, max - out.length))}`; break; }
    out += `${out ? '\n…\n' : ''}${piece}`;
  }
  return out;
}

/** The prompt. Signals are numbered in the order given. Pure. */
export function buildSignalCheckPrompt({ signals, text, brief = '', offer = '' }) {
  const lines = signals.map((f, i) => {
    const tags = TAGS.filter(k => f[k]).map(k => `${k}: ${f[k]}`);
    return `${i + 1}. [${f.category}] chip "${f.label ?? ''}" — ${f.content}${tags.length ? ` (${tags.join(', ')})` : ''}${f.quote ? `\n   quote: "${f.quote}"` : ''}`;
  }).join('\n');
  return `You check the deal signals just read from one conversation, before they are filed on the account record. A wrong signal is worse than a missing one: it reaches the deal's health, the events feed and the automations.

${offer ? `WHAT WE SELL:\n${offer}\n\n` : ''}${accountBriefBlock(brief)}CONVERSATION they were read from:
<<<
${excerptFor(text, signals)}
>>>

SIGNALS:
${lines}

${READ_IN_CONTEXT}

Categories you may move a signal to: ${CLAIM_CATEGORY_KEYS.join(', ')}. A competitor does the job WE sell. A chip is 2–5 words and at most 40 characters, that a colleague who was not there understands on its own, sentence case, never a fragment of their words, a person's name, or "X vs Y". For competitor, tech_stack, budget and authority the chip is built from the tags, so leave "label" out for those.
Moving a signal needs the tags of its new category: competitor → "entity" and "stance" (evaluating, incumbent, past_failure, mentioned); tech_stack → "tool"; expansion_signal → "product" and "stance" (asked, considering, declined); objection → "status" (open, resolved, addressed) and "hardness" (hard, soft); blocker → "status" (open, resolved); authority → "role" (economic_buyer, decision_maker, champion, blocker, technical) when it is stated; risk_signal → "severity" (stated_churn, at_risk, friction).

For each signal decide:
- "keep": right as written, in context.
- "rewrite": a real signal whose sentence, chip or category is wrong in context. Give the corrected fields; keep the person it is about named in the sentence, and state only what they said or did.
- "drop": not a deal signal once read in context (a step in a test, an aside, a general view about AI or tools, someone else's view, our own words, or nothing that matters for the deal).
Your verdict must agree with your reason: if you find it is not what its category says, move it to the category it is, or drop it. Never keep a category your own "why" rules out.

Answer with ONLY a JSON array, one item per signal:
[{"n": 1, "verdict": "keep|rewrite|drop", "content": "<rewrite only>", "label": "<rewrite only>", "category": "<rewrite only, when it changes>", "about": "<person|company, when it changes>", "entity": "", "stance": "", "tool": "", "status": "", "hardness": "", "role": "", "product": "", "severity": "", "why": "<a few words, for rewrite or drop>"}]
Give only the tags that apply.`;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A chip that reads whole: 2–5 words, at most 40 characters, never "X vs Y". A longer one was cut
 *  mid-word on the card ("Conditional pricing acceptance pending p"), so it is refused and the old
 *  chip kept. Pure. */
export function goodChip(label) {
  const t = str(label);
  if (!t || t.length > 40) return false;
  const words = t.split(/\s+/).length;
  return words >= 1 && words <= 5 && !/\bvs\.?\b|\bversus\b/i.test(t);
}

/** The signals after the verdicts, one slot each: kept, rewritten, or null when dropped. An
 *  unanswered signal is kept. Pure. */
export function applyVerdicts(signals, verdicts, { log = () => {} } = {}) {
  const byN = new Map();
  for (const v of Array.isArray(verdicts) ? verdicts : []) {
    const n = Number(v?.n);
    if (Number.isInteger(n) && n >= 1 && n <= signals.length && !byN.has(n)) byN.set(n, v);
  }
  const out = [];
  signals.forEach((f, i) => {
    const v = byN.get(i + 1);
    const verdict = String(v?.verdict ?? 'keep').toLowerCase();
    if (verdict === 'drop') { log(`drop [${f.category}] "${f.label ?? f.content}" — ${str(v.why) ?? 'not a signal in context'}`); out.push(null); return; }
    if (verdict !== 'rewrite') { out.push(f); return; }
    const next = { ...f };
    const category = str(v.category);
    const moving = category && category !== f.category && CLAIM_CATEGORY_KEYS.includes(category);
    // The tags the signal would carry in its new category: the verdict's, never the old category's.
    const tagFor = (field, cat) => {
      const val = str(v[field]);
      if (!val || !FIELD_HOME[field].includes(cat)) return null;
      if (field === 'stance' && !STANCES[cat]?.includes(val)) return null;
      return val;
    };
    if (moving && (NEEDS[category] ?? []).every(field => tagFor(field, category))) {
      next.category = category;
      for (const field of TAGS) {
        delete next[field];
        const val = tagFor(field, category);
        if (val) next[field] = val;
      }
    } else {
      for (const field of TAGS) {
        const val = tagFor(field, next.category);
        if (val) next[field] = val;
      }
    }
    if (['person', 'company'].includes(str(v.about) ?? '')) next.about = str(v.about);
    if (str(v.content)) next.content = str(v.content);
    if (goodChip(v.label) && !CODE_CHIPS.has(next.category)) next.label = str(v.label);
    next.checked = 'rewritten';
    log(`rewrite [${f.category}] "${f.label ?? ''}" → [${next.category}] "${next.label ?? ''}" — ${str(v.why) ?? ''}`);
    out.push(next);
  });
  return out;
}

/**
 * The facts of one conversation with their deal signals checked. `text` is what they were read from,
 * `brief` the account brief, `offer` what we sell. `onCall` meters the call. Never throws.
 */
export async function checkSignals(facts, { text, brief = '', offer = '', onCall = null, model = null, label = 'signal-check' } = {}) {
  const all = (facts ?? []).map((f, i) => (CHECKED.has(f?.category) ? i : -1)).filter(i => i >= 0);
  if (!all.length) return facts;
  if (all.length > MAX_SIGNALS) console.warn(`[SIGNAL_CHECK] ${label}: ${all.length} deal signals, the last ${all.length - MAX_SIGNALS} go unchecked`);
  const idx = all.slice(0, MAX_SIGNALS);
  const signals = idx.map(i => facts[i]);
  try {
    const msg = await createMessage({
      meter: false,
      feature: 'signal-check',
      model: model || insightBoardModel(),
      max_tokens: 3000,
      messages: [{ role: 'user', content: buildSignalCheckPrompt({ signals, text, brief, offer }) }],
      accept: (t) => parseJsonArray(t) !== null,
    });
    await onCall?.(msg);
    const verdicts = parseJsonArray(msg?.content?.find?.(b => b.type === 'text')?.text ?? msg?.content?.[0]?.text);
    if (verdicts === null) { console.warn(`[SIGNAL_CHECK] ${label}: unreadable answer, every signal kept`); return facts; }
    const checked = applyVerdicts(signals, verdicts, { log: (m) => console.log(`[SIGNAL_CHECK] ${label}: ${m}`) });
    const slot = new Map(idx.map((i, j) => [i, checked[j]]));
    return facts.map((f, i) => (slot.has(i) ? slot.get(i) : f)).filter(Boolean);
  } catch (err) {
    console.warn(`[SIGNAL_CHECK] ${label}: failed, every signal kept:`, err?.message ?? err);
    return facts;
  }
}
