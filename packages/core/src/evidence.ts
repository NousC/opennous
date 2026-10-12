// Evidence — deciding what actually matters in a record.
//
// The substrate stores everything: every import, every sync, every stage change,
// alongside the meeting where the deal turned. For a database that's correct. For
// anything that has to REASON — a model, or a person — it's noise, and burying
// the Jun 29 call under forty routine rows costs both tokens and judgement. It's
// what makes an agent say "19 matched activity signals" instead of "he replied
// twice and booked a call".
//
// So this module answers one question: of everything we hold, what PROVES
// something? It ranks by what a record demonstrates, not by when it landed.
//
// It lives in core on purpose. Every surface that reads the graph — the web
// agent, the MCP tools your Claude Code agents call, the REST API — must rank
// evidence the same way, or they disagree about what mattered and the product
// contradicts itself.

// ─── Naming ─────────────────────────────────────────────────────────────────

/** The connected system a record came from, named the way a person would say it. */
const SYSTEM_LABELS: Record<string, string> = {
  gmail: 'Gmail', google_calendar: 'Calendar', calendar: 'Calendar',
  fireflies: 'Fireflies', fathom: 'Fathom', granola: 'Granola', fellow: 'Fellow', ringcentral: 'RingCentral',
  linkedin: 'LinkedIn', slack: 'Slack',
  hubspot: 'HubSpot', salesforce: 'Salesforce', apollo: 'Apollo', close: 'Close',
  instantly: 'Instantly', smartlead: 'Smartlead', heyreach: 'HeyReach', lemlist: 'Lemlist',
  attio: 'Attio', pipedrive: 'Pipedrive', calendly: 'Calendly', cal_com: 'Cal.com',
  notion: 'Notion', airtable: 'Airtable', rb2b: 'RB2B',
  agent: 'Agent', user: 'Manual', import: 'Import', csv: 'CSV', system: 'System',
  // The unknown-provenance markers a CRM backfill leaves behind. They are Nous's
  // own derivation, not a system a person would recognise — never surface the
  // raw 'v1_compat' string to a reader. Keep in sync with UNKNOWN_PROVENANCE_SOURCES
  // in services/crmProvenance.ts.
  v1_compat: 'Nous', v1_backfill: 'Nous',
  // Our own re-extraction pass over material already ingested. It is Nous deriving, not a
  // system a reader would recognise — "Reextract · Reextract · 6 facts" told them nothing.
  reextract: 'Nous', re_extract: 'Nous', extraction: 'Nous',
};

export function systemLabel(source?: string | null): string {
  if (!source) return 'Nous';
  return SYSTEM_LABELS[source] ?? (source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' '));
}

/** 'interaction.email_replied' → 'email replied'. Machine keys are not prose. */
export function readableProperty(p?: string | null): string {
  return String(p ?? '').replace(/^interaction\./, '').replace(/[._]/g, ' ').trim();
}

// Never hand raw JSON to a reader. A calendar event whose `summary` is null used
// to render as `{"summary":null,...}` — walk the fields that carry prose instead.
const PROSE_FIELDS = ['text', 'body', 'summary', 'description', 'content', 'title', 'name', 'message'];

export function gist(v: unknown, max = 180): string {
  if (v == null) return '';
  let s = '';
  if (typeof v === 'string') s = v;
  else if (typeof v === 'object') {
    for (const f of PROSE_FIELDS) {
      const c = (v as Record<string, unknown>)[f];
      if (typeof c === 'string' && c.trim()) { s = c; break; }
    }
  } else s = String(v);
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export const NOISE_FLOOR = 40;   // below this it's plumbing, not evidence
export const FACT_BASE   = 62;   // a written note — someone bothered to record it

// What happened, and how much it proves. First match wins.
const PROPERTY_SCORES: [RegExp, number][] = [
  [/meeting_held|call_held|transcript|meeting_summary/, 100], // they actually talked
  [/reply|replied|responded/,                            92], // they responded to us
  [/received|inbound/,                                   88], // they came to us
  [/meeting_booked|meeting_scheduled|demo/,              86], // they committed time
  [/deal|proposal|contract|pricing/,                     80],
  [/linkedin_message|dm|message_sent/,                   58], // we messaged them
  [/email_sent|sequence|campaign/,                       48],
  [/connected|connection_accepted/,                      46],
  [/opened|clicked|viewed/,                              34], // weak intent, easy to over-read
  [/job_title|seniority|company|enrich/,                 30], // firmographics, not a signal
  [/imported|created|synced|system|stage_change/,        10], // plumbing
];

// Some systems carry more human signal than others, whatever the property says.
export const SOURCE_BONUS: Record<string, number> = {
  Fireflies: 12, Fathom: 12, Granola: 12, Fellow: 12, RingCentral: 12,   // call recorders — they carry the call
  Gmail: 8, LinkedIn: 8, Slack: 6,
  HubSpot: 2, Salesforce: 2, Attio: 2, Pipedrive: 2, Close: 2,
  Agent: 2, Manual: 4,
  Calendar: -12,                        // mostly recurring placeholders
  Apollo: -10, Instantly: -6, Smartlead: -6, HeyReach: -6, Lemlist: -6,
  Import: -30, CSV: -30, System: -30,   // proves nothing to a human
};

/** Recent evidence beats old evidence — but never outranks what it proves. */
export function recencyBonus(when?: string | null): number {
  if (!when) return 0;
  const days = (Date.now() - new Date(when).getTime()) / 86_400_000;
  if (Number.isNaN(days) || days < 0) return 0;   // future-dated (a booked call) — no boost
  if (days <= 7)  return 10;
  if (days <= 30) return 6;
  if (days <= 90) return 2;
  return 0;
}

/**
 * How much does this record prove?
 *
 * Body text matters as much as the property: "You: 👍" is a real LinkedIn message
 * and evidence of nothing. What THEY said is evidence; what WE said is just us
 * talking.
 */
export function scoreEvidence(
  property?: string | null,
  source?: string | null,
  when?: string | null,
  body = '',
): number {
  const p = String(property ?? '').toLowerCase();
  let base = 50; // an unrecognised interaction still beats plumbing
  for (const [re, s] of PROPERTY_SCORES) {
    if (re.test(p)) { base = s; break; }
  }

  let score = base + (SOURCE_BONUS[systemLabel(source)] ?? 0) + recencyBonus(when);

  // The connectors prefix our own messages with "You:".
  if (/^you:/i.test(body.trim())) score -= 22;

  // "👍". "Thanks man, you too :)". Real messages, zero information.
  const meat = body.replace(/^you:\s*/i, '').trim();
  if (meat.length < 15) score -= 30;
  if (!meat) score -= 40;

  return score;
}

// ─── Compression ────────────────────────────────────────────────────────────

export interface EvidenceItem {
  what: string;
  source: string;
  when: string | null;
  detail: string | null;
}

export interface CompressedAccount {
  entity_id: string;
  name?: string | null;
  type: string;
  claims: unknown;
  claims_note: string;
  facts: unknown;
  /** The newest live fact per time-bound topic — what is true now (GET-770). */
  current_position?: unknown;
  /** The stack, one entry per tool (GET-798). */
  tech_stack?: unknown;
  /** Older claims a newer one replaced, old → new, last 60 days (GET-798). */
  recently_replaced?: unknown;
  facts_note?: string;
  documents: unknown;   // saved briefs/notes/transcripts (previews), carried through unchanged
  key_activity: EvidenceItem[];
  activity_summary: {
    total_observations: number;
    by_type: Record<string, number>;
    first_seen: string | null;
    last_seen: string | null;
    note?: string;
  };
}

/** How many raw interactions a reader can actually hold in mind at once. */
export const DEFAULT_EVIDENCE_BUDGET = 18;

/**
 * Turn a full account record into what a reader should actually read.
 *
 * Keeps every claim and fact (those are the profile — small and load-bearing),
 * ranks the interactions by what they prove, keeps the top slice, and replaces
 * the rest with a summary of their shape. Nothing is silently dropped: the
 * summary says how many were left out and why they were routine.
 */

// ─── Claims, at the size they are worth ─────────────────────────────────────
//
// A claim whose value is "harborline.example" — four tokens of information — used to be handed to
// the model inside ninety tokens of wrapper:
//
//   { value, property, entity_id, decays_at, freshness, confidence,
//     epistemic_class, last_observed_at, observation_count }
//
// `property` repeats the key it is filed under. `entity_id` is identical on every claim on
// the account and already sits at the top level. `decays_at` is bookkeeping the agent has no
// use for, and `last_observed_at` carried microseconds. Measured on real traffic, `claims`
// was roughly 3,000 tokens — over half of a whole get_account payload, and the one field the
// compressor passed through untouched while carefully trimming the ~700-token activity list
// beside it.
//
// The rule here is the one that applies to a good answer too: say it only when it matters.
// A claim that is fresh, confident and seen more than once is just its value. A claim with
// something wrong with it carries exactly what is wrong and nothing else. So the common case
// costs four tokens and the exception still tells the truth.

/** Below this a claim is worth flagging to the reader rather than stating flatly. */
const LOW_CONFIDENCE = 0.5;

function compressClaim(c: any): unknown {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return c;   // already a scalar
  if (!('value' in c)) return c;                                           // not a claim shape

  const caveats: Record<string, unknown> = {};
  const conf = typeof c.confidence === 'number' ? c.confidence : null;
  if (conf !== null && conf < LOW_CONFIDENCE) caveats.confidence = Math.round(conf * 100) / 100;
  // 'fresh' is the default and says nothing; 'stale' or 'decayed' changes how it should be used.
  if (c.freshness && c.freshness !== 'fresh') caveats.freshness = c.freshness;
  // An inferred or asserted fact is not an observed one, and the agent should hedge differently.
  if (c.epistemic_class && c.epistemic_class !== 'observed') caveats.basis = c.epistemic_class;

  // The date, not the instant. Nobody reasons in microseconds, and it is carried only when
  // something is already off — otherwise "when" is noise on a fact that is current.
  if (Object.keys(caveats).length) {
    const when = c.last_observed_at ?? c.observed_at ?? null;
    if (when) caveats.since = String(when).slice(0, 10);
    return { value: c.value, ...caveats };
  }

  return c.value;
}

/**
 * Compress the claims map. Returns the same keys, each either a bare value (the common case)
 * or a small object carrying only what is wrong with it.
 */
export function compressClaims(claims: unknown): unknown {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return claims;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(claims as Record<string, unknown>)) out[k] = compressClaim(v);
  return out;
}

export function compressAccount(
  acc: any,
  budget: number = DEFAULT_EVIDENCE_BUDGET,
): CompressedAccount {
  const obs: any[] = Array.isArray(acc?.recent_observations) ? acc.recent_observations : [];

  const byType: Record<string, number> = {};
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const o of obs) {
    const k = readableProperty(o.property) || 'other';
    byType[k] = (byType[k] ?? 0) + 1;
    const t = o.observed_at ?? o.occurred_at;
    if (t) {
      if (!earliest || t < earliest) earliest = t;
      if (!latest || t > latest) latest = t;
    }
  }

  const ranked = obs
    .map(o => {
      const body = gist(o.value ?? o.content);
      return { o, body, score: scoreEvidence(o.property, o.source, o.observed_at ?? o.occurred_at, body) };
    })
    .sort((a, b) =>
      b.score - a.score ||
      String(b.o.observed_at ?? '').localeCompare(String(a.o.observed_at ?? '')))
    .slice(0, budget)
    .map(({ o, body }) => ({
      what:   readableProperty(o.property),
      source: systemLabel(o.source),
      when:   o.observed_at ?? o.occurred_at ?? null,
      detail: body || null,
      // ⚠️ THE POINTER MUST SURVIVE COMPRESSION. Dropping it here cost nothing in tokens —
      // it is one short string — and cost everything downstream: extractSources reads
      // `source_ref` off whatever the tool returned, so with it stripped, EVERY citation
      // built from an account read had `ref: undefined`. The link out never resolved, the
      // rendered evidence never resolved, and the whole citation chain quietly degraded to
      // a line of text. The compressor is the right place to save tokens and the wrong
      // place to decide what is checkable.
      source_ref: o.source_ref ?? null,
    }));

  return {
    entity_id: acc.entity_id,
    type: acc.type,
    // Carried so a citation of the record can NAME it. "Account record — Harborline" is a
    // source; "Account record — this account" is a shrug with a border around it.
    name: acc.name ?? acc.display_name ?? null,
    claims: compressClaims(acc.claims),
    facts: acc.facts,
    // What is true NOW, and how to read the rest (GET-770). Without it the agent advised a short
    // pilot on a September "couple of months" after the buyer said in October they were ready.
    current_position: Array.isArray(acc.current_position) ? acc.current_position : [],
    // GET-798: the stack by tool, and what a newer claim replaced lately. Carried so the in-app
    // chat reads the same account the MCP tools print.
    tech_stack: Array.isArray(acc.tech_stack) ? acc.tech_stack : [],
    recently_replaced: Array.isArray(acc.recently_replaced) ? acc.recently_replaced : [],
    facts_note: 'Each fact is dated by when it was said. current_position is where the deal stands now: the newest live fact per deal topic (buying signal, timeline, objection, budget, authority, competitor) plus every open blocker and live requirement, across the account. Lead with it. tech_stack is their stack, one entry per tool, summary = the newest fact. recently_replaced lists older claims a newer one replaced (old → new): say what changed, and never present the old side as current. facts holds everything else, without what those sections already show. A fact marked aging, suspect or expired may no longer hold: say how old it is.',
    // Said once, here, instead of on every claim: a bare value IS the fact, current and
    // confident. Anything the agent should hedge about carries its reason with it.
    claims_note: 'A claim given as a plain value is observed, current and confident. One given as an object carries what is wrong with it — low confidence, staleness, or an inferred rather than observed basis.',
    // Carry document previews through the compressor untouched — the in-app agent
    // returns compressAccount() straight to the model, so anything dropped here is
    // invisible to it (this is why a saved brief never reached the agent).
    documents: Array.isArray(acc.documents) ? acc.documents : [],
    key_activity: ranked,
    activity_summary: {
      total_observations: obs.length,
      by_type: byType,
      first_seen: earliest,
      last_seen: latest,
      note: obs.length > ranked.length
        ? `Showing the ${ranked.length} most telling of ${obs.length} interactions. The rest are routine (imports, syncs, opens).`
        : undefined,
    },
  };
}

// ─── Intent ─────────────────────────────────────────────────────────────────
//
// A question has a shape, and the right context has that same shape. Prepping for
// a meeting needs the last conversation and what you owe them; an ICP question
// needs none of that. Handing back the same fixed blob regardless is how you burn
// tokens and blunt precision at the same time.

// The intents are already defined in context.ts, alongside their token recipes.
// Reuse them — a second, competing vocabulary of intents is exactly how two
// surfaces start disagreeing about what a question is.
import type { ContextIntent } from './context.js';

/** How much raw evidence each kind of question actually needs. */
const INTENT_BUDGETS: Record<ContextIntent, number> = {
  meeting_prep:   20,  // you need the conversation, in detail
  call_prep:      20,
  account_review: 24,  // the whole arc matters here
  follow_up:      14,  // the last exchange, and what was promised
  draft_email:     8,  // one hook is enough; more just dilutes the writing
};

export function budgetForIntent(intent?: string | null): number {
  return INTENT_BUDGETS[intent as ContextIntent] ?? DEFAULT_EVIDENCE_BUDGET;
}
