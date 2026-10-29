// Deterministic ICP scorer. Scores a lead against a dial model and returns the score
// + the exact reasons that produced it. Same input always yields the same score (no LLM,
// no churn). The model is the per-workspace YAML edited in Settings > ICP; the repo
// default (src/cloud/config/icp-model.json) is the seed/fallback.
//
//   score = base + best-matching persona + firmographics (location/size/type)
//         + observed signal boosts/cuts, clamped to 0-100.
//   A hard disqualifier caps the score at disqualifier_cap.
//   RULE: an absent signal never subtracts — only observed terms move the score.
//
// A lead is a plain object; every field optional (we score on what we know):
//   { job_title, headline, keywords:[], comment, location, employee_count, company_type }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dir, '../config/icp-model.json');

// The seed model that new workspaces start from (and the fallback when none is stored).
export const DEFAULT_MODEL = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8'));

// Parse the operator-edited YAML into a model object. Throws on malformed YAML.
export function parseModelYaml(yamlText) {
  return parseYaml(yamlText);
}

// Structural validation — cheap guardrails so a bad edit can't silently break scoring.
// Returns { ok, errors:[] }.
export function validateModel(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['model is empty or not an object'] };
  if (typeof m.base !== 'number') errors.push('base must be a number');
  if (m.disqualifier_cap != null && typeof m.disqualifier_cap !== 'number') errors.push('disqualifier_cap must be a number');
  const arr = (k) => Array.isArray(m[k]);
  if (!arr('personas')) errors.push('personas must be a list');
  else m.personas.forEach((p, i) => { if (typeof p.weight !== 'number') errors.push(`personas[${i}].weight must be a number`); });
  if (m.signals && !arr('signals')) errors.push('signals must be a list');
  (m.signals || []).forEach((s, i) => {
    if (typeof s.weight !== 'number') errors.push(`signals[${i}].weight must be a number`);
    if (!Array.isArray(s.any)) errors.push(`signals[${i}].any must be a list of terms`);
  });
  if (m.disqualifiers && !arr('disqualifiers')) errors.push('disqualifiers must be a list');
  return { ok: errors.length === 0, errors };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const hasAny = (text, terms) => (terms || []).some((t) => text.includes(String(t).toLowerCase()));

// The searchable blob a lead's persona/signals/disqualifiers match against.
function blobOf(lead) {
  const kw = Array.isArray(lead.keywords) ? lead.keywords.join(' ') : (lead.keywords || '');
  return [lead.job_title, lead.headline, kw, lead.comment, lead.company_type, lead.location]
    .filter(Boolean).join(' · ').toLowerCase();
}

export function scoreLead(lead, model = DEFAULT_MODEL) {
  const blob = blobOf(lead);
  const reasons = [];
  let score = model.base ?? 40;

  // 1. Persona — the single strongest match applies.
  let bestPersona = null;
  for (const p of model.personas || []) {
    const roleOk = !p.role_any || hasAny(blob, p.role_any);
    const domainOk = !p.domain_any || hasAny(blob, p.domain_any);
    if (roleOk && domainOk && (!bestPersona || p.weight > bestPersona.weight)) bestPersona = p;
  }
  if (bestPersona) { score += bestPersona.weight; reasons.push({ label: bestPersona.reason || bestPersona.id, weight: bestPersona.weight }); }

  // 2. Firmographics — best-matching tier per axis, only when we know the value.
  const fg = model.firmographics || {};
  const loc = (lead.location || '').toLowerCase();
  if (loc && Array.isArray(fg.location)) {
    const tier = fg.location.find((t) => hasAny(loc, t.any));
    if (tier) { score += tier.weight; reasons.push({ label: `location: ${loc}`, weight: tier.weight }); }
  }
  if (Number.isFinite(lead.employee_count) && Array.isArray(fg.size)) {
    const band = fg.size.find((b) => lead.employee_count >= b.min && lead.employee_count <= b.max);
    if (band) { score += band.weight; reasons.push({ label: `${lead.employee_count} employees`, weight: band.weight }); }
  }
  if (Array.isArray(fg.type)) {
    const typeTier = fg.type.find((t) => hasAny(blob, t.any));
    if (typeTier) { score += typeTier.weight; reasons.push({ label: 'B2B / SaaS / agency', weight: typeTier.weight }); }
  }

  // 3. Signals — every observed one applies (boost or cut). Absent = nothing.
  for (const s of model.signals || []) {
    if (hasAny(blob, s.any)) { score += s.weight; reasons.push({ label: s.reason, weight: s.weight }); }
  }

  // 4. Disqualifiers — cap the score if any fires.
  let disqualified = null;
  for (const d of model.disqualifiers || []) {
    if (hasAny(blob, d.any)) { disqualified = d.reason; break; }
  }

  score = clamp(Math.round(score), 0, 100);
  const cap = model.disqualifier_cap ?? 25;
  if (disqualified) { score = Math.min(score, cap); reasons.push({ label: `DISQUALIFIED: ${disqualified}`, weight: 0 }); }

  const t = model.tiers || { tier_1: 85, tier_2: 70, tier_3: 50 };
  const tier = score >= t.tier_1 ? 'tier_1' : score >= t.tier_2 ? 'tier_2' : score >= t.tier_3 ? 'tier_3' : 'not_icp';
  return { score, tier, fit: score >= t.tier_2, disqualified: !!disqualified, reasons };
}
