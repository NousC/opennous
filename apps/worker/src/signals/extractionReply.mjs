// Sturdier extraction (GET-1050): what the extractor's answer is, and what to do when it is not usable.
// Ported in shape from Hindsight's retain/fact_extraction.py (MIT): a lenient parse, one repair turn,
// a split when the answer overflows, and categories held to the list.
//
// THE FOUR OUTCOMES OF ONE READ, kept apart because they mean different things:
//   facts        an array with facts in it
//   empty        an explicit [] — the ONLY answer that means "nothing to record"
//   unparseable  no JSON array in the answer (prose, a fenced object, nothing at all)
//   truncated    no complete array, and the model stopped at its token limit
// Before this, an answer whose facts all used the wrong keys ("fact" instead of "content") parsed,
// every fact was filtered out for having no content, and the conversation read as "nothing worth
// recording". An unparseable answer was recorded as a failure, but a mostly-malformed one was a
// silent zero. Now both get one repair turn, and what is still unusable after it is an error.
//
// Pure, except readWithRepair (which calls the model it is handed). No database.
import { normalizeClaimCategory, CLAIM_CATEGORY_KEYS, parseJsonArray, messageText } from '@nous/core';

// More than this share of malformed facts and the answer is sent back once for repair (Hindsight's bar).
export const MALFORMED_SHARE = 0.2;
// A piece shorter than this is not split again on overflow; the read fails instead.
export const OVERFLOW_FLOOR = 500;

/**
 * A category the taxonomy knows: a key, or one of its aliases ("pain point", "churn risk"), which
 * normalizeClaimCategory maps to a key. Anything else would have been filed as `general` without
 * anyone choosing it. `general` itself is a real category. Pure.
 */
export function isKnownCategory(category) {
  const raw = String(category ?? '').trim().toLowerCase();
  if (!raw) return false;
  return raw === 'general' || normalizeClaimCategory(raw) !== 'general';
}

const isClaimHome = (f) => {
  const h = String(f?.home ?? '').trim().toLowerCase();
  return h !== 'our_product' && h !== 'market';
};

/**
 * What is wrong with one fact, or null. A claim about them needs a content sentence and a category
 * from the list; a statement about us (home our_product / market, GET-969) needs only its sentence,
 * since its kind decides where it goes. Pure.
 */
export function factProblem(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'not an object';
  if (typeof f.content !== 'string' || !f.content.trim()) return 'no "content"';
  if (!isClaimHome(f)) return null;
  if (f.category == null || String(f.category).trim() === '') return 'no "category"';
  if (!isKnownCategory(f.category)) return `category "${String(f.category).slice(0, 40)}" is not in the list`;
  return null;
}

/** A second, more forgiving look at text parseJsonArray could not read: a trailing comma, or one
 *  bare fact object instead of an array. Never invents content. Pure. */
function lenientArray(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const noTrailing = t.replace(/,\s*([\]}])/g, '$1');
  const arr = parseJsonArray(noTrailing);
  if (arr !== null) return arr;
  const s = noTrailing.indexOf('{'), e = noTrailing.lastIndexOf('}');
  if (s === -1 || e < s) return null;
  try {
    const obj = JSON.parse(noTrailing.slice(s, e + 1));
    // {"facts": [...]} or any single array value: the model wrapped the array.
    const arrays = obj && typeof obj === 'object' ? Object.values(obj).filter(Array.isArray) : [];
    if (arrays.length === 1) return arrays[0];
    // One bare fact.
    if (obj && typeof obj === 'object' && 'content' in obj && !noTrailing.includes('[')) return [obj];
  } catch { /* not JSON */ }
  return null;
}

/** Whether the model stopped at its token limit (Anthropic stop_reason, OpenRouter finish_reason). */
export function stoppedAtLimit(msg) {
  return msg?.stop_reason === 'max_tokens' || msg?.finish_reason === 'length';
}

/**
 * One answer, read. Pure.
 * @returns {{ status: 'facts'|'empty'|'unparseable'|'truncated', facts: object[], problems: string[], keys: string[] }}
 */
export function readReply(text, { truncated = false } = {}) {
  // A cut-off answer is never read leniently: a bare-object fallback would read the first complete
  // fact of a truncated array as the whole answer and lose the rest (the split re-reads it instead).
  const parsed = parseJsonArray(text) ?? (truncated ? null : lenientArray(text));
  if (parsed === null) return { status: truncated ? 'truncated' : 'unparseable', facts: [], problems: [], keys: [] };
  if (!parsed.length) return { status: 'empty', facts: [], problems: [], keys: [] };
  const problems = parsed.map(factProblem).filter(Boolean);
  const keys = [...new Set(parsed.flatMap(f => (f && typeof f === 'object' && !Array.isArray(f) ? Object.keys(f) : [])))];
  return { status: 'facts', facts: parsed, problems, keys };
}

/** An answer with facts in it, none of them usable: a failure, never "nothing to record". Pure. */
export function unusable(reply) {
  return reply.status === 'facts' && reply.problems.length === reply.facts.length;
}

/** An answer that gets one repair turn: no array at all, or more than a fifth of its facts malformed. Pure. */
export function needsRepair(reply) {
  if (reply.status === 'unparseable') return true;
  return reply.status === 'facts' && reply.problems.length / reply.facts.length > MALFORMED_SHARE;
}

/** The repair turn: what was wrong, the keys it used, the keys that are valid. Pure. */
export function repairTurn(reply) {
  const what = reply.status === 'unparseable'
    ? 'Your answer had no JSON array in it.'
    : `${reply.problems.length} of your ${reply.facts.length} facts could not be used (${[...new Set(reply.problems)].slice(0, 4).join('; ')}).`;
  const used = reply.keys.length ? ` You used the keys: ${reply.keys.slice(0, 20).join(', ')}.` : '';
  return `${what}${used}
Every fact needs "content" (one sentence) and, for home "claim", "category" set to exactly one of: ${CLAIM_CATEGORY_KEYS.join(', ')}. The other keys are the ones the instructions list ("home", "importance", "quote", "speaker", "label", "about", the category's tags, and "fact_kind" with an event's "occurred_start" / "occurred_end").
Reply exactly with a JSON array [...] of the same facts, corrected, and nothing else. Do not add facts. If there is nothing to record, reply exactly [].`;
}

/**
 * The usable facts of a read answer: malformed ones dropped, and a category outside the list
 * dropped with a log line (it used to become `general` silently). Pure apart from the log.
 */
export function usableFacts(facts, { label = 'extract', log = console.warn } = {}) {
  const out = [], dropped = [];
  for (const f of facts ?? []) {
    const problem = factProblem(f);
    if (problem) { dropped.push(problem); continue; }
    out.push(f);
  }
  if (dropped.length) log(`[EXTRACTION_ENUM] ${label}: dropped ${dropped.length} malformed fact(s): ${[...new Set(dropped)].slice(0, 5).join('; ')}`);
  return out;
}

/**
 * The model call, then one repair turn when the answer needs it (GET-1050). `ask({ system,
 * messages })` makes the call; `onCall(msg)` meters each one, the repair included.
 * @returns {Promise<{ reply, msg, calls: object[], repaired: boolean }>}
 */
export async function readWithRepair({ ask, system, user, onCall = null, label = 'extract', log = console.warn }) {
  const calls = [];
  const first = await ask({ system, messages: [{ role: 'user', content: user }] });
  calls.push(first); await onCall?.(first);
  const firstText = messageText(first);
  const reply = readReply(firstText, { truncated: stoppedAtLimit(first) });
  if (!needsRepair(reply)) return { reply, msg: first, calls, repaired: false };
  log(`[EXTRACTION_REPAIR] ${label}: ${reply.status === 'unparseable' ? 'no JSON array' : `${reply.problems.length}/${reply.facts.length} facts malformed`} — one repair turn`);
  const second = await ask({ system, messages: [
    { role: 'user', content: user },
    { role: 'assistant', content: firstText.trim() || '(no answer)' },
    { role: 'user', content: repairTurn(reply) },
  ] });
  calls.push(second); await onCall?.(second);
  const fixed = readReply(messageText(second), { truncated: stoppedAtLimit(second) });
  // Whichever answer has more usable facts wins; an explicit [] after the repair is an answer. A
  // reply with facts but none usable is not "nothing": the caller counts it as a failure (unusable()).
  const good = (r) => (r.status === 'facts' ? r.facts.length - r.problems.length : -1);
  if (fixed.status === 'empty') return { reply: fixed, msg: second, calls, repaired: true };
  if (fixed.status === 'facts' && good(fixed) >= Math.max(0, good(reply))) return { reply: fixed, msg: second, calls, repaired: true };
  if (reply.status === 'facts') return { reply, msg: first, calls, repaired: false };
  return { reply: fixed, msg: second, calls, repaired: false };
}

/**
 * A piece of text cut in two for an answer that overflowed its token limit (GET-1050): at the
 * turn boundary nearest the middle (a line that opens "Name:"), else any line break, else a
 * sentence end. Each half is at least `floor` characters; below twice that there is nothing to
 * split and the caller records the loss. No overlap: each half is read whole, and an overlap
 * would read its turn twice. Pure.
 */
export function splitOnOverflow(text, { floor = OVERFLOW_FLOOR } = {}) {
  const full = String(text ?? '');
  if (full.length < 2 * floor) return null;
  const mid = Math.floor(full.length / 2);
  const inRange = (i) => i >= floor && full.length - i >= floor;
  const nearest = (re) => {
    let best = -1;
    for (const m of full.matchAll(re)) {
      const at = m.index + m[0].length;
      if (inRange(at) && (best === -1 || Math.abs(at - mid) < Math.abs(best - mid))) best = at;
    }
    return best;
  };
  let cut = nearest(/\n(?=[A-Za-zÀ-ÿ' .-]{2,60}:\s)/g);           // a speaker turn starts after this
  if (cut === -1) cut = nearest(/\n/g);
  if (cut === -1) cut = nearest(/[.!?]["')\]]?\s+/g);
  if (cut === -1) return null;
  return [full.slice(0, cut).trim(), full.slice(cut).trim()];
}
