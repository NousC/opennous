// The deterministic half of the extraction eval (GET-1048): what a case looks like, how the
// extractor's claims are shown to the judge, and the checks that need no model.
//
// Ported in spirit from hindsight-system-evals (MIT): retain_capabilities.py runs the cheap,
// certain checks before any judge is asked, because a judge is slow, costs money and can be wrong,
// and "it wrote four claims for a scheduling email" needs none of that to be a failure.
//
// Everything here is pure: no database, no model, no network. tests/extractionEvals.test.mjs pins it.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAIM_CATEGORY_KEYS, OUR_SIDE_CATEGORY_KEYS } from '@nous/core';

export const CASE_CATEGORIES = ['selectivity', 'attribution', 'category', 'temporal', 'no_invention', 'competitor_naming'];
const CASE_KEYS = new Set(['id', 'category', 'origin', 'minimum', 'input', 'must', 'traps', 'expect']);
const EXPECT_KEYS = new Set(['maxClaims', 'categories', 'contains', 'notCategories', 'occurred', 'ours', 'links']);
// What our side said (GET-1052), checked apart from the buyer's claims: the judge never reads them.
const OURS_KEYS = new Set(['max', 'categories', 'notCategories', 'contains', 'occurred']);
const KINDS = new Set(['meeting', 'email']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/**
 * Everything wrong with one case, as sentences ([] when it is valid). A malformed case must fail
 * loudly before a run, not score as a pass because a misspelt `maxClaim` was never checked.
 */
export function validateCase(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['case is not an object'];
  const at = nonEmpty(c.id) ? c.id : '(no id)';
  for (const k of Object.keys(c)) if (!CASE_KEYS.has(k)) errs.push(`${at}: unknown key "${k}"`);
  if (!nonEmpty(c.id) || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errs.push(`${at}: id must be lowercase words joined by "-"`);
  if (!CASE_CATEGORIES.includes(c.category)) errs.push(`${at}: category must be one of ${CASE_CATEGORIES.join(', ')}`);
  if (!nonEmpty(c.origin)) errs.push(`${at}: origin (which real failure this guards) is required`);
  if (c.minimum !== undefined && typeof c.minimum !== 'boolean') errs.push(`${at}: minimum must be true or false`);

  const i = c.input;
  if (!i || typeof i !== 'object') errs.push(`${at}: input is required`);
  else {
    if (!nonEmpty(i.text) || i.text.trim().length < 20) errs.push(`${at}: input.text must be at least 20 characters (shorter text is never read)`);
    if (!DAY_RE.test(String(i.saidAt ?? '')) || Number.isNaN(Date.parse(i.saidAt))) errs.push(`${at}: input.saidAt must be a YYYY-MM-DD date`);
    if (!KINDS.has(i.kind)) errs.push(`${at}: input.kind must be "meeting" or "email"`);
    if (!nonEmpty(i.account?.name)) errs.push(`${at}: input.account.name is required`);
    if (!Array.isArray(i.people) || !i.people.length || !i.people.every(p => nonEmpty(p?.name))) errs.push(`${at}: input.people must list at least one person with a name`);
    // An email is one person's words; the meeting path is the one that reads a room.
    if (i.kind === 'email' && i.people?.length > 1) errs.push(`${at}: an email case has exactly one person (the sender)`);
    if (!nonEmpty(i.ourSide?.company) || !Array.isArray(i.ourSide?.names)) errs.push(`${at}: input.ourSide needs company and names[]`);
  }

  for (const k of ['must', 'traps']) {
    if (!Array.isArray(c[k]) || !c[k].every(nonEmpty)) errs.push(`${at}: ${k} must be an array of criterion sentences`);
  }
  const e = c.expect;
  if (!e || typeof e !== 'object') errs.push(`${at}: expect is required (use {} for none)`);
  else {
    for (const k of Object.keys(e)) if (!EXPECT_KEYS.has(k)) errs.push(`${at}: unknown expect key "${k}"`);
    if (e.maxClaims !== undefined && !(Number.isInteger(e.maxClaims) && e.maxClaims >= 0)) errs.push(`${at}: expect.maxClaims must be a whole number >= 0`);
    for (const k of ['categories', 'notCategories']) {
      if (e[k] === undefined) continue;
      if (!Array.isArray(e[k])) { errs.push(`${at}: expect.${k} must be an array`); continue; }
      for (const cat of e[k]) if (!CLAIM_CATEGORY_KEYS.includes(cat)) errs.push(`${at}: expect.${k} has unknown claim category "${cat}"`);
    }
    if (e.contains !== undefined && !(Array.isArray(e.contains)
      && e.contains.every(x => nonEmpty(x) || (Array.isArray(x) && x.length && x.every(nonEmpty))))) {
      errs.push(`${at}: expect.contains must be an array of strings (or of string arrays, any one of which counts)`);
    }
    if (e.occurred !== undefined) errs.push(...occurredExpectProblems(e.occurred).map(p => `${at}: expect.occurred ${p}`));
    if (e.ours !== undefined) errs.push(...oursExpectProblems(e.ours).map(p => `${at}: expect.ours ${p}`));
    if (e.links !== undefined) errs.push(...linksExpectProblems(e.links).map(p => `${at}: expect.links ${p}`));
    if (e.maxClaims === 0 && (e.categories?.length || e.contains?.length || e.occurred?.length)) errs.push(`${at}: expect.maxClaims 0 contradicts categories/contains`);
  }
  // A case that checks nothing passes everything.
  if (Array.isArray(c.must) && Array.isArray(c.traps) && e && !c.must.length && !c.traps.length && !Object.keys(e).length) {
    errs.push(`${at}: a case needs at least one must, trap or expect check`);
  }
  return errs;
}

/**
 * What is wrong with an `expect.occurred` list (GET-1051), as sentence fragments. Each entry picks
 * the claims whose text contains `contains` (a string, or strings any one of which counts) and says
 * when the event happens: `start` and `end` (YYYY-MM-DD), or `none: true` for a state that must
 * carry no occurred date. Pure.
 */
export function occurredExpectProblems(list) {
  if (!Array.isArray(list) || !list.length) return ['must be a non-empty array'];
  const errs = [];
  list.forEach((o, n) => {
    const at = `[${n}]`;
    if (!o || typeof o !== 'object') { errs.push(`${at} is not an object`); return; }
    for (const k of Object.keys(o)) if (!['contains', 'start', 'end', 'none'].includes(k)) errs.push(`${at} has unknown key "${k}"`);
    if (!(nonEmpty(o.contains) || (Array.isArray(o.contains) && o.contains.length && o.contains.every(nonEmpty)))) errs.push(`${at}.contains must be a string or an array of strings`);
    if (o.none !== undefined && o.none !== true) errs.push(`${at}.none must be true when given`);
    if (o.none && (o.start !== undefined || o.end !== undefined)) errs.push(`${at} has none and a date`);
    if (!o.none) {
      for (const k of ['start', 'end']) if (!DAY_RE.test(String(o[k] ?? '')) || Number.isNaN(Date.parse(o[k]))) errs.push(`${at}.${k} must be a YYYY-MM-DD date`);
      if (DAY_RE.test(String(o.start ?? '')) && DAY_RE.test(String(o.end ?? '')) && o.end < o.start) errs.push(`${at}.end is before its start`);
    }
  });
  return errs;
}

/** What is wrong with an `expect.ours` block (GET-1052), as sentence fragments. Pure.
 *  { max, categories, notCategories, contains, occurred } over OUR side's facts; categories are the
 *  stored our-side keys (our_reply, our_commitment, pitch_line). */
export function oursExpectProblems(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['must be an object'];
  const errs = [];
  for (const k of Object.keys(o)) if (!OURS_KEYS.has(k)) errs.push(`has unknown key "${k}"`);
  if (o.max !== undefined && !(Number.isInteger(o.max) && o.max >= 0)) errs.push('max must be a whole number >= 0');
  for (const k of ['categories', 'notCategories']) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k])) { errs.push(`${k} must be an array`); continue; }
    for (const cat of o[k]) if (!OUR_SIDE_CATEGORY_KEYS.includes(cat)) errs.push(`${k} has unknown our-side category "${cat}"`);
  }
  if (o.contains !== undefined && !(Array.isArray(o.contains)
    && o.contains.every(x => nonEmpty(x) || (Array.isArray(x) && x.length && x.every(nonEmpty))))) errs.push('contains must be an array of strings (or of string arrays)');
  if (o.occurred !== undefined) errs.push(...occurredExpectProblems(o.occurred).map(p => `occurred ${p}`));
  if (o.max === 0 && (o.categories?.length || o.contains?.length || o.occurred?.length)) errs.push('max 0 contradicts categories/contains');
  return errs;
}

/** What is wrong with an `expect.links` list (GET-1053), as sentence fragments. Pure.
 *  Each entry is { from, to }: a cause link from a fact of category `from` (the effect) to one of
 *  category `to` (the cause), either a claim category or one of our side's (our_reply, …); "a|b"
 *  accepts either, where two categories fit the same fact (a budget freeze is budget or blocker).
 *  An empty list means the read must link nothing. */
export function linksExpectProblems(list) {
  if (!Array.isArray(list)) return ['must be an array (use [] for "no link")'];
  const known = new Set([...CLAIM_CATEGORY_KEYS, ...OUR_SIDE_CATEGORY_KEYS]);
  const errs = [];
  list.forEach((l, n) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) { errs.push(`[${n}] is not an object`); return; }
    for (const k of Object.keys(l)) if (!['from', 'to'].includes(k)) errs.push(`[${n}] has unknown key "${k}"`);
    for (const k of ['from', 'to']) for (const c of String(l[k] ?? '').split('|')) if (!known.has(c)) errs.push(`[${n}].${k} "${c}" is not a claim or our-side category`);
  });
  return errs;
}

/** Load every case under `dir` (each *.mjs default-exports an array; "_"-prefixed files are shared
 *  helpers). Throws on any invalid or duplicate case. */
export async function loadCases(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const cases = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    if (!Array.isArray(mod.default)) throw new Error(`${f}: must default-export an array of cases`);
    cases.push(...mod.default);
  }
  const errs = cases.flatMap(validateCase);
  const seen = new Set();
  for (const c of cases) { if (seen.has(c.id)) errs.push(`${c.id}: duplicate id`); seen.add(c.id); }
  if (errs.length) throw new Error(`invalid eval cases:\n- ${errs.join('\n- ')}`);
  return cases;
}

/** --minimum / --case filtering. An unknown --case id is an error, not an empty run. */
export function selectCases(cases, { minimum = false, caseId = null } = {}) {
  if (caseId) {
    const hit = cases.filter(c => c.id === caseId);
    if (!hit.length) throw new Error(`no case with id "${caseId}"`);
    return hit;
  }
  return minimum ? cases.filter(c => c.minimum) : cases;
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────
//
// A claim, as the runner holds it (extract.mjs toEvalClaim):
//   { category, content, subject: { kind: 'person'|'account', name }, saidAt, tags: { entity, stance, tool, … } }
// The tags are part of what is filed (a competitor's `entity` is the name on the competitor board),
// so the judge sees them: a competitor-naming case cannot be judged from the sentence alone.

const TAG_ORDER = ['entity', 'stance', 'tool', 'status', 'hardness', 'role', 'product', 'severity', 'change'];

function tagText(tags = {}) {
  const parts = TAG_ORDER.filter(k => tags?.[k] != null && tags[k] !== '').map(k => `${k}=${tags[k]}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** When the event happens or happened (GET-1051): " [happened 2026-03-01 to 2026-03-31]", or "". */
function happenedText(o) {
  if (!o || (!o.start && !o.end)) return '';
  if (o.start && o.end) return ` [happened ${o.start === o.end ? o.start : `${o.start} to ${o.end}`}]`;
  return o.start ? ` [happened from ${o.start}]` : ` [happens by ${o.end}]`;
}

/** One line per claim: `- [category] text (tags) [said date] [happened …] {person: Name}`. */
export function renderClaim(claim) {
  const subject = claim.subject?.name ? `{${claim.subject.kind ?? 'person'}: ${claim.subject.name}}` : '{unattributed}';
  return `- [${claim.category ?? 'general'}] ${String(claim.content ?? '').trim()}${tagText(claim.tags)} [${claim.saidAt ?? 'undated'}]${happenedText(claim.occurred)} ${subject}`;
}

/** The whole set, as the judge reads it. An empty set says so in words, so "no claims" is judgeable. */
export function renderClaims(claims = []) {
  return claims.length ? claims.map(renderClaim).join('\n') : '(no claims were recorded)';
}

// ── Deterministic checks ──────────────────────────────────────────────────────────────────────

const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;
// A model filling a date it does not know writes one of these.
const PLACEHOLDER_RE = /\b(20XX|19XX|YYYY|XXXX|MM\/DD|DD\/MM)\b|\[(date|year|month|day)\]/i;

/**
 * Years a claim may name: any year the source text names, and the said year plus or minus one
 * ("last month" in January, "next quarter" in October). Anything else is a year the model brought
 * with it, the classic one being its own training year.
 */
export function allowedYears(input) {
  const said = Number(String(input?.saidAt ?? '').slice(0, 4));
  const years = new Set(String(input?.text ?? '').match(YEAR_RE) ?? []);
  if (said) for (const y of [said - 1, said, said + 1]) years.add(String(y));
  return years;
}

/** Placeholder or out-of-range years in the claims, as failure reasons. */
export function placeholderYearProblems(claims, input) {
  const ok = allowedYears(input);
  const out = [];
  for (const c of claims) {
    const text = `${c.content ?? ''}${tagText(c.tags)}`;
    if (PLACEHOLDER_RE.test(text)) out.push(`placeholder date in claim: "${c.content}"`);
    for (const y of text.match(YEAR_RE) ?? []) {
      if (!ok.has(y)) out.push(`year ${y} is neither in the text nor near the said date (${input?.saidAt}): "${c.content}"`);
    }
  }
  return out;
}

const haystack = (c) => `${c.content ?? ''} ${Object.values(c.tags ?? {}).filter(v => v != null).join(' ')}`.toLowerCase();

/** The checks over OUR side's facts (GET-1052), as failure reasons prefixed "ours". Pure. */
export function oursProblems(ours = [], o = undefined) {
  if (!o) return [];
  const out = [];
  if (o.max !== undefined && ours.length > o.max) out.push(`ours.max: ${ours.length} of our side's fact(s), at most ${o.max} expected`);
  const present = new Set(ours.map(x => x.category));
  for (const cat of o.categories ?? []) if (!present.has(cat)) out.push(`ours.categories: no [${cat}] fact of ours`);
  for (const cat of o.notCategories ?? []) {
    const hits = ours.filter(x => x.category === cat);
    if (hits.length) out.push(`ours.notCategories: ${hits.length} [${cat}] fact(s) of ours: ${hits.map(h => `"${h.content}"`).join(', ')}`);
  }
  const hay = (x) => `${x.content ?? ''} ${x.answers ?? ''}`.toLowerCase();
  for (const want of o.contains ?? []) {
    const any = (Array.isArray(want) ? want : [want]).map(s => s.toLowerCase());
    if (!ours.some(x => any.some(s => hay(x).includes(s)))) out.push(`ours.contains: no fact of ours mentions ${any.map(s => `"${s}"`).join(' or ')}`);
  }
  out.push(...occurredProblems(ours.map(x => ({ ...x, tags: {} })), o.occurred).map(r => `ours.${r}`));
  return out;
}

/**
 * The cause links (GET-1053) among a read's output, as failure reasons prefixed "links". Each fact
 * (claim or ours) carries `ref` and `causedBy` (refs of its causes, extract.mjs); a link counts only
 * when both ends are in the output, as production files it. `[]` expects none; otherwise each
 * expected { from, to } pair must be present (others may be too). Pure.
 */
export function linkProblems(claims = [], ours = [], list = undefined) {
  if (list === undefined) return [];
  const all = [...claims, ...ours];
  const byRef = new Map(all.filter(x => x?.ref).map(x => [x.ref, x]));
  const got = [];
  for (const x of all) for (const r of x?.causedBy ?? []) { const cause = byRef.get(r); if (cause && cause !== x) got.push({ from: x, to: cause }); }
  const shown = (l) => `[${l.from.category}] "${l.from.content}" caused_by [${l.to.category}] "${l.to.content}"`;
  if (!list.length) return got.length ? [`links: expected none, got ${got.length}: ${got.map(shown).join('; ')}`] : [];
  const out = [];
  for (const want of list) {
    const is = (cat, w) => String(w).split('|').includes(cat);
    if (!got.some(l => is(l.from.category, want.from) && is(l.to.category, want.to))) {
      out.push(`links: no [${want.from}] caused_by [${want.to}] link${got.length ? ` (got ${got.map(shown).join('; ')})` : ' (no links at all)'}`);
    }
  }
  return out;
}

/**
 * The checks that need no judge, in order: claim count, categories present, categories absent,
 * text contained, placeholder years, and (GET-1052) our side's facts. Returns { pass, reasons } —
 * every failing check is listed, not just the first, so one run shows everything a prompt change broke.
 */
export function deterministicChecks(claims, c, ours = []) {
  const e = c.expect ?? {};
  const reasons = [];
  if (e.maxClaims !== undefined && claims.length > e.maxClaims) {
    reasons.push(`maxClaims: ${claims.length} claim(s), at most ${e.maxClaims} expected`);
  }
  const present = new Set(claims.map(x => x.category));
  for (const cat of e.categories ?? []) if (!present.has(cat)) reasons.push(`categories: no [${cat}] claim`);
  for (const cat of e.notCategories ?? []) {
    const hits = claims.filter(x => x.category === cat);
    if (hits.length) reasons.push(`notCategories: ${hits.length} [${cat}] claim(s): ${hits.map(h => `"${h.content}"`).join(', ')}`);
  }
  for (const want of e.contains ?? []) {
    const any = (Array.isArray(want) ? want : [want]).map(s => s.toLowerCase());
    if (!claims.some(x => any.some(s => haystack(x).includes(s)))) {
      reasons.push(`contains: no claim mentions ${Array.isArray(want) ? want.map(s => `"${s}"`).join(' or ') : `"${want}"`}`);
    }
  }
  reasons.push(...occurredProblems(claims, e.occurred));
  reasons.push(...placeholderYearProblems(claims, c.input));
  reasons.push(...oursProblems(ours, e.ours));
  reasons.push(...linkProblems(claims, ours, e.links));
  return { pass: reasons.length === 0, reasons };
}

/**
 * The expected occurred ranges (GET-1051), as failure reasons. For each entry, some claim whose text
 * contains it must carry exactly that range (or, with `none`, every such claim must carry none). No
 * matching claim at all fails a range (a check that finds nothing to check has not passed), not a
 * `none`. Pure.
 */
export function occurredProblems(claims, list = []) {
  const out = [];
  for (const o of list ?? []) {
    const any = (Array.isArray(o.contains) ? o.contains : [o.contains]).map(s => s.toLowerCase());
    const label = any.map(s => `"${s}"`).join(' or ');
    const hits = claims.filter(x => any.some(s => haystack(x).includes(s)));
    // `none` checks that a state is not dated; no such claim dated nothing (whether it should have
    // been recorded at all is the case's `must`, for the judge).
    if (!hits.length) { if (!o.none) out.push(`occurred: no claim mentions ${label}`); continue; }
    const shown = (x) => (x.occurred ? `${x.occurred.start ?? '…'} to ${x.occurred.end ?? '…'}` : 'none');
    if (o.none) {
      const dated = hits.filter(x => x.occurred?.start || x.occurred?.end);
      if (dated.length) out.push(`occurred: a state mentioning ${label} carries an occurred date (${dated.map(shown).join(', ')})`);
      continue;
    }
    if (!hits.some(x => x.occurred?.start === o.start && x.occurred?.end === o.end)) {
      out.push(`occurred: no claim mentioning ${label} happens ${o.start} to ${o.end} (got ${hits.map(shown).join(', ')})`);
    }
  }
  return out;
}
