import Anthropic from 'useleak';
import { listSignals, seedSignals, listNotes } from '@nous/core';

// Shared scorecard-seed logic — the ICP scoring model is built by translating
// the workspace's GTM memory (ICP / Market / Product / Pricing / Competitors /
// Positioning notes) into a weighted signal list. Used by both the human web
// route (POST /api/mind/scorecard/seed) and the agent route
// (POST /v2/workspace/scoring-model), so the two never drift.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The canonical buying-signal classes signal-scan produces. Any signal.* rule
// must target one of these and be 'scaled' — otherwise it can never fire.
const SIGNAL_CLASSES = ['domain', 'friction', 'hiring', 'momentum', 'stack', 'intent'];

// Normalize an LLM-produced rule to the shape the scorer reads. Guards against
// the two ways a seed has gone wrong: (1) nested `{ feature: { op, value } }`
// instead of flat `{ feature, op, value }` (silently scored everyone a flat 50),
// and (2) signal.* features with the wrong op (exists/in never grade, so they
// don't reflect signal strength). Returns {} for unsalvageable rules.
export function normalizeScorecardRule(rule) {
  if (!rule || typeof rule !== 'object') return {};
  let r = rule;
  if (!r.feature) {
    const keys = Object.keys(r);
    if (keys.length === 1 && r[keys[0]] && typeof r[keys[0]] === 'object' && 'op' in r[keys[0]]) {
      r = { feature: keys[0], op: r[keys[0]].op, value: r[keys[0]].value };
    }
  }
  if (!r.feature || !r.op) return {};
  // Semantic exclusion feature (exclusion.<key>): a website-read disqualifier set
  // by signal-scan, for "who we are NOT" that firmographics can't isolate (e.g. a
  // cold-CALLING agency vs the cold-EMAIL agencies we want). Always exists+disqualify.
  if (String(r.feature).startsWith('exclusion.')) {
    const key = String(r.feature).slice('exclusion.'.length).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!key) return {};
    return { feature: `exclusion.${key}`, op: 'exists', disqualify: true };
  }
  // Keyword/text exclusion: match descriptive enrichment text (keywords array or
  // description string) against discriminating terms at score time — the automatic
  // layer that needs no website read. Only `contains_any` makes sense here.
  if (r.feature === 'keywords' || r.feature === 'description') {
    if (r.op !== 'contains_any') return {};
    const terms = (Array.isArray(r.value) ? r.value : [r.value])
      .map(t => String(t).trim().toLowerCase()).filter(Boolean);
    if (!terms.length) return {};
    return { feature: r.feature, op: 'contains_any', value: terms, ...(r.disqualify === true ? { disqualify: true } : {}) };
  }
  const cls = String(r.feature).replace(/^signal\./, '');
  if (String(r.feature).startsWith('signal.') || SIGNAL_CLASSES.includes(cls)) {
    if (!SIGNAL_CLASSES.includes(cls)) return {}; // unknown signal.* — would never fire
    // signal.* is always a graded positive inclusion — a buying signal can't be a
    // hard disqualifier, so the disqualify flag never rides on one.
    return { feature: `signal.${cls}`, op: 'scaled', value: typeof r.value === 'number' ? r.value : 5 };
  }
  // Exclusions fire WHEN the bad trait is present, so they must use a positive
  // match op (==, in, exists). A disqualifier on != would fire on everyone else
  // and suppress the whole list — drop the flag if the op can't express "is one".
  const disqualify = r.disqualify === true && ['==', 'in', 'exists'].includes(r.op);
  return { feature: r.feature, op: r.op, value: r.value, ...(disqualify ? { disqualify: true } : {}) };
}

export const FEATURE_VOCAB =
  'job_title (string), seniority (one of: c_suite, vp, director, manager, ic), ' +
  'department (string), employee_count (number), ' +
  // industry is the ONLY extracted company-type/vertical feature — it carries
  // BOTH the vertical and the kind of company. Bind any "what kind of company"
  // rule to `industry` (values like: agency, services, software, marketplace,
  // ecommerce, media, b2b_saas, …). Do NOT emit company_type / size_band /
  // funding_stage rules — those features are not extracted, so such a rule would
  // never fire. Use employee_count (number) for size, not size_band.
  'industry (string — also the company TYPE; e.g. agency, services, software, marketplace, ecommerce, media, b2b_saas), ' +
  'country (string), company (string). ' +
  // Descriptive company text from enrichment (Apollo/Prospeo) — the keyword layer
  // for exclusions: matched with op "contains_any" (value = array of lowercase
  // terms) at score time, no website read. `keywords` is the richest (Apollo's
  // own classifier, e.g. "cold calling","telemarketing","brand strategy").
  'keywords (array of company keyword strings; use op "contains_any"), ' +
  'description (company description text; use op "contains_any"). ' +
  // Buying signals from signal-scan — the canonical 6 classes, each a 0–10
  // STRENGTH. Use op "scaled" (contributes weight × score/10) with value = the
  // floor (min score to count, typically 4–6). These are the ONLY signal.*
  // features; never invent other signal.* keys (they would never fire):
  'signal.domain (0-10, how strongly the company fits the niche/vertical), ' +
  'signal.friction (0-10, a pain the offer removes), ' +
  'signal.hiring (0-10, roles/expansion that signal the need), ' +
  'signal.momentum (0-10, funding/growth/expansion), ' +
  'signal.stack (0-10, tools/process that signal fit), ' +
  'signal.intent (0-10, expressed buying intent from their content). ' +
  // Pipeline-engagement (how the deal went), bucketed from the activity log:
  'pipe.lead_source (e.g. inbound_website, outbound_email, inbound_linkedin), ' +
  'pipe.channel (email|linkedin|meeting|website|slack|other), ' +
  'pipe.inbound (boolean), pipe.replied (boolean), ' +
  'pipe.meetings_band (0|1|2|3+), pipe.touches_band (1-2|3-5|6-10|10+). ' +
  // Semantic exclusion flags, set by a website-reading enrichment pass
  // (signal-scan), for "who we are NOT" that firmographics can't separate — e.g.
  // a cold-CALLING agency vs the cold-EMAIL agencies you want. Name one per stated
  // exclusion: exclusion.<snake_case_key>. Always op "exists" with disqualify true.
  'exclusion.<snake_case_key> (a semantic "not a fit" flag set from a website read, ' +
  'e.g. exclusion.cold_calling_agency, exclusion.branding_agency — op "exists", disqualify true).';

/**
 * Build (or rebuild) the ICP scoring model from the workspace's GTM memory.
 *
 * Returns a tagged result so callers map it to their own response shape:
 *   { status: 'exists',            signals }  — a model already exists and force was not set
 *   { status: 'no_icp_memory',     signals: [] } — no GTM context recorded yet
 *   { status: 'translation_failed',signals: [] } — the model came back empty
 *   { status: 'created',           signals }  — built and saved
 * Throws only on unexpected failures.
 */
export async function seedScorecardFromMemory(supabase, workspaceId, { force = false } = {}) {
  const existing = await listSignals(supabase, workspaceId);
  if (existing.length > 0 && !force) {
    return { status: 'exists', signals: existing };
  }

  const mems = await listNotes(supabase, workspaceId, {
    categories: ['ICP', 'Market', 'Product', 'Pricing', 'Competitors', 'Positioning'],
    limit: 80,
  });
  const icpText = mems.map(m => `[${m.category}] ${m.content}`).join('\n').trim();
  if (!icpText) return { status: 'no_icp_memory', signals: [] };

  const prompt =
    `Translate this Ideal Customer Profile into a Scorecard — a list of ` +
    `weighted signals that score how well a lead fits.\n\n` +
    `ICP: """${icpText}"""\n\n` +
    `Produce 4 to 8 INCLUSION signals (who we sell to) plus an exclusion signal ` +
    `for EACH "not a fit / we don't work with / avoid / exclude" statement the ICP ` +
    `makes. Inclusions have a positive weight; the learning loop later sharpens them ` +
    `and adds soft negatives from real replies.\n\n` +
    `EXCLUSIONS — "who we are NOT". When the ICP explicitly names a kind of company ` +
    `it does not want (e.g. "not cold-calling agencies", "no pure branding/messaging ` +
    `marketing agencies"), emit a signal with a NEGATIVE weight (-6 to -10) AND ` +
    `"disqualify": true. A disqualifier hard-caps the account below Not-ICP no matter ` +
    `what else it fires — so use it only for the genuine "we will not work with them" ` +
    `cases the ICP states, never as a mild preference. It must fire WHEN the bad trait ` +
    `is present, so use op == or in (never !=). Bind it to a real EXTRACTED feature ` +
    `(industry, department, country, employee_count) — pick the value(s) ` +
    `that best capture the named kind of company.\n\n` +
    `CRITICAL — stay faithful to the ICP. A signal must be exactly as narrow as ` +
    `what the ICP states, never broader:\n` +
    `- Preserve stated numbers exactly. "1-20 employees" becomes employee_count ` +
    `<= 20 (or a 1-20 range), NOT employee_count < 50. Never loosen a threshold.\n` +
    `- Map qualitative descriptors to the tightest faithful rule. "AI service ` +
    `businesses and agencies" becomes industry in the specific terms given, NOT ` +
    `a vague "operates in the AI space".\n` +
    `- Do not invent criteria the ICP never mentions, and do not generalize a ` +
    `narrow, niche ICP into a broad one. If the ICP is narrow, the signals are narrow.\n` +
    `- Only emit an exclusion the ICP actually states. Do not invent disqualifiers.\n` +
    `- FIRMOGRAPHIC vs SEMANTIC exclusion — pick the right feature:\n` +
    `   • If a firmographic value cleanly isolates the excluded kind WITHOUT ` +
    `catching anyone you include (e.g. exclude a whole country, or an industry you ` +
    `never sell to), bind the disqualifier to that feature (country/industry/` +
    `employee_count) with == or in.\n` +
    `   • If an included kind shares the same firmographics (e.g. ICP excludes ` +
    `"cold-calling agencies" but INCLUDES "cold-email agencies" — both industry=agency; ` +
    `or excludes "pure branding agencies" while including other agencies), do NOT use ` +
    `a firmographic rule (it would nuke your real ICP). Emit TWO disqualifiers for ` +
    `that one exclusion:\n` +
    `       (a) a KEYWORD rule that fires automatically at score time: ` +
    `feature "keywords", op "contains_any", value = an array of HIGH-PRECISION ` +
    `lowercase terms that the excluded kind's enrichment keywords carry but the ` +
    `INCLUDED kind does NOT — e.g. cold-calling → ["cold calling","cold call",` +
    `"telemarketing","dialer","call center","outbound calling"] (NOT "appointment ` +
    `setting" or "lead generation", which cold-email shops also use); branding → ` +
    `["brand strategy","branding","visual identity","logo design","naming"]. ` +
    `disqualify true. Pick terms precise enough that a hard cap on them is safe.\n` +
    `       (b) a SEMANTIC backstop: feature "exclusion.<snake_case_key>", op ` +
    `"exists", disqualify true, label DESCRIBING the excluded kind precisely (a ` +
    `website read classifies the accounts the keywords miss).\n` +
    `   The keyword rule catches most automatically; the exclusion.<key> catches the ` +
    `rest. A too-broad firmographic disqualifier that nukes your real ICP is far ` +
    `worse than these — when in doubt, use keyword + semantic, never firmographic.\n\n` +
    `Each signal has:\n` +
    `- key: short snake_case id\n- label: one plain sentence that restates the ` +
    `ICP's own specifics (e.g. "1-20 employees", not "small company"; ` +
    `"cold-calling agencies — not a fit" for an exclusion)\n` +
    `- weight: integer -10..10. Positive = inclusion (higher = more predictive of ` +
    `fit). Negative = exclusion.\n` +
    `- disqualify: true ONLY on a hard exclusion (omit otherwise)\n` +
    `- rule: how it fires on a lead's features — ` +
    `{ "feature": <name>, "op": <operator>, "value": <value> }\n\n` +
    `Available features: ${FEATURE_VOCAB}\n` +
    `Operators: ==, !=, >=, <=, >, <, in, exists, scaled. For "in", value is an ` +
    `array. For any signal.* feature ALWAYS use "scaled" with value = the floor ` +
    `(min 0-10 score to count, e.g. 5); never use exists/in on a signal.* feature, ` +
    `and never put disqualify on a signal.* feature.\n\n` +
    `Respond with ONLY a JSON array, no prose.`;

  const msg = await anthropic.messages.create({
    feature: 'scorecard-seed-translate',
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });
  // Defensive parse: strip any markdown fence, pull the JSON array, and never let
  // a malformed/truncated LLM response throw — degrade to translation_failed so
  // the route returns a clean 502 instead of a 500.
  const raw = msg.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || raw);
  } catch (e) {
    console.error('[scorecardSeed] non-JSON scorecard response (stop_reason:', msg.stop_reason + '):', e.message);
    return { status: 'translation_failed', signals: [] };
  }

  const signals = (Array.isArray(parsed) ? parsed : [])
    .slice(0, 12)
    .map(s => {
      const rule = normalizeScorecardRule(s.rule);
      // Allow negatives now (exclusions). Default to a positive inclusion weight;
      // a disqualifier with a non-negative weight is forced negative so it always
      // reads as a detractor even if the model mislabels the sign.
      let weight = Math.max(-10, Math.min(10, Math.round(Number(s.weight) || 3)));
      // A negative-weight keyword/description rule IS an exclusion — force the hard
      // disqualifier (chosen policy: keyword matches cap, like a website-read flag).
      // The LLM is inconsistent about emitting the flag, so we set it deterministically.
      if ((rule.feature === 'keywords' || rule.feature === 'description') && weight < 0) {
        rule.disqualify = true;
      }
      if (rule.disqualify && weight >= 0) weight = -8;
      if (weight === 0) weight = rule.disqualify ? -8 : 1;
      return {
        key: String(s.key || '').trim().slice(0, 60),
        label: String(s.label || '').trim().slice(0, 200),
        weight,
        rule,
      };
    })
    .filter(s => s.key && s.label && s.rule.feature);

  if (signals.length === 0) return { status: 'translation_failed', signals: [] };

  const created = await seedSignals(supabase, workspaceId, signals);
  return { status: 'created', signals: created };
}
