// NOEMA — one extraction layer, measured.
//
// Nous is the mind. Noema is what it grasps. Every source — a meeting, an email, a LinkedIn thread,
// a CRM note, a website — runs through here and comes out as claims, insights and reads.
//
// A READ declares four things, and this function is what makes that a contract rather than a
// convention:
//
//   schema          what a valid answer looks like, as a parser
//   accept          a machine-checkable predicate that MUST agree with the schema
//   guards          the caller's own rules about what may be kept
//   failure record  a durable row when the answer is unusable
//
// WHY THIS EXISTS. Of roughly twenty extraction sites, two recorded a durable event when a model
// returned garbage. The rest returned `[]`, or `null`, or a bare `return` — which is
// indistinguishable from "the model read this and found nothing". A whole class of failure was
// therefore invisible: on 2026-09-17 one accept gate demanded a field its prompt never asked for,
// so every customer call was answered correctly, rejected, re-asked of the dearer model, rejected
// again, and used anyway. Nothing errored. It was found by reading a cost table by hand.
//
// So: a Read returns a RESULT, never a bare value. `ok:false` and "found nothing" are different
// answers, and the caller has to decide which it can live with.
//
// See the Linear doc "Noema — one extraction layer, measured" (GET-193, GET-320).

import { createMessage } from '../lib/llm.mjs';
import { pipelineModel } from '../lib/llm.mjs';
import { meterLLM } from '../utils/meterLLM.mjs';
import { recordPipelineEvent } from '../lib/pipelineEvents.mjs';

/** How much of a bad answer to keep on the failure row: enough to recognise it, not a transcript. */
const DETAIL_CHARS = 240;

/**
 * Run one Read.
 *
 * @param {object}   o
 * @param {object}   o.supabase
 * @param {string}   o.workspaceId
 * @param {string}   o.feature       the door feature name, e.g. 'graph-edges-extract'
 * @param {string}   o.prompt        the built prompt
 * @param {function} o.accept        (text) => boolean — REQUIRED. What a usable answer looks like.
 * @param {function} o.parse         (text) => value|null — null means "unparseable", NOT "empty"
 * @param {number}   [o.maxTokens]
 * @param {string}   [o.meterAs]     the llm_usage label, when it differs from `feature`
 * @param {string}   [o.tier]        'extraction' (default) or 'writing'
 * @param {string}   [o.system]
 *
 * @returns {Promise<{ok: true, value: any} | {ok: false, reason: 'unparseable'|'unavailable', raw?: string}>}
 */
export async function read({
  supabase, workspaceId, feature, prompt, accept, parse,
  maxTokens = 1500, meterAs = null, tier = 'extraction', system = undefined, model = undefined,
}) {
  if (typeof accept !== 'function') {
    // Not a runtime nicety: the three Reads that shipped without one are exactly the three whose
    // failures vanished without a log line.
    throw new Error(`[noema] ${feature}: a Read must declare what it accepts`);
  }

  let msg;
  try {
    msg = await createMessage({
      meter: false,
      feature,
      tier,
      model: model ?? (tier === 'extraction' ? pipelineModel() : undefined),
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
      accept,
    });
  } catch (err) {
    // An outage is not a bad answer, and must not read as one.
    await recordPipelineEvent(supabase, {
      workspaceId, kind: 'unavailable', feature,
      model: null, detail: { error: String(err?.message || err).slice(0, DETAIL_CHARS) },
    });
    return { ok: false, reason: 'unavailable' };
  }

  await meterLLM(supabase, workspaceId, meterAs || feature, msg);

  const text = (msg?.content ?? []).find(b => b.type === 'text')?.text?.trim() ?? '';
  const value = parse(text);

  if (value === null || value === undefined) {
    // The door returns the last (rejected) answer when the fallback chain is exhausted, so this is
    // where a genuinely unusable answer lands — and where it stops being invisible.
    await recordPipelineEvent(supabase, {
      workspaceId, kind: 'unparseable', feature,
      model: msg?.model ?? null,
      detail: { head: text.slice(0, DETAIL_CHARS), length: text.length },
    });
    return { ok: false, reason: 'unparseable', raw: text };
  }

  return { ok: true, value };
}

/**
 * The JSON-array parser most Reads want: `null` when the answer cannot be read, `[]` when the model
 * read it and found nothing. Keeping those apart is the entire point.
 */
export function parseArray(text) {
  const s = String(text ?? '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return null;
  try {
    const parsed = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** The object equivalent. */
export function parseObject(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  try {
    const parsed = JSON.parse(s.slice(a, b + 1));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}

/**
 * Some Reads ask for prose, not JSON — a memory summary is two sentences a person reads. There is
 * no shape to check, so the only unusable answer is no answer: `null` when nothing came back.
 *
 * Note what supplying any accept costs: the door's default also rejects an answer cut off at the
 * token limit. A JSON Read still catches that for free (a truncated array does not parse), but
 * nothing in the TEXT of a summary says it was cut off, so a short one is used rather than re-asked
 * of the fallback. Guessing at it — demanding a full stop, say — is exactly the gate-stricter-than-
 * the-question mistake that cost a run on 2026-09-17.
 */
export function parseProse(text) {
  const s = String(text ?? '').trim();
  return s || null;
}

/**
 * Some Reads ask for an array under a named key — `{"labels":[…]}`. That array IS the answer: an
 * object arriving without it says nothing about anything we asked, so it is unreadable; an empty
 * one is the real answer "I read them and matched none". Returns the parser and the accept
 * together, because the whole point is that they are one statement.
 */
export function keyedArray(key) {
  const parse = (text) => {
    const obj = parseObject(text);
    if (!obj) return null;
    return Array.isArray(obj[key]) ? obj[key] : null;
  };
  return { parse, accept: (text) => parse(text) !== null };
}

/** An accept that agrees with `parseArray` — one statement, not two that can drift apart. */
export const acceptsArray = (text) => parseArray(text) !== null;

/** An accept that agrees with `parseObject`. */
export const acceptsObject = (text) => parseObject(text) !== null;

/** An accept that agrees with `parseProse`. */
export const acceptsProse = (text) => parseProse(text) !== null;
