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
import { CLAIM_CATEGORY_KEYS } from '@nous/core';

export const CASE_CATEGORIES = ['selectivity', 'attribution', 'category', 'temporal', 'no_invention', 'competitor_naming'];
const CASE_KEYS = new Set(['id', 'category', 'origin', 'minimum', 'input', 'must', 'traps', 'expect']);
const EXPECT_KEYS = new Set(['maxClaims', 'categories', 'contains', 'notCategories']);
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
    if (e.maxClaims === 0 && (e.categories?.length || e.contains?.length)) errs.push(`${at}: expect.maxClaims 0 contradicts categories/contains`);
  }
  // A case that checks nothing passes everything.
  if (Array.isArray(c.must) && Array.isArray(c.traps) && e && !c.must.length && !c.traps.length && !Object.keys(e).length) {
    errs.push(`${at}: a case needs at least one must, trap or expect check`);
  }
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

/** One line per claim: `- [category] text (tags) [said date] {person: Name}`. */
export function renderClaim(claim) {
  const subject = claim.subject?.name ? `{${claim.subject.kind ?? 'person'}: ${claim.subject.name}}` : '{unattributed}';
  return `- [${claim.category ?? 'general'}] ${String(claim.content ?? '').trim()}${tagText(claim.tags)} [${claim.saidAt ?? 'undated'}] ${subject}`;
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

/**
 * The checks that need no judge, in order: claim count, categories present, categories absent,
 * text contained, placeholder years. Returns { pass, reasons } — every failing check is listed,
 * not just the first, so one run shows everything a prompt change broke.
 */
export function deterministicChecks(claims, c) {
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
  reasons.push(...placeholderYearProblems(claims, c.input));
  return { pass: reasons.length === 0, reasons };
}
