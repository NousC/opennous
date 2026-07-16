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
  fireflies: 'Fireflies', linkedin: 'LinkedIn', slack: 'Slack',
  hubspot: 'HubSpot', salesforce: 'Salesforce', apollo: 'Apollo',
  instantly: 'Instantly', smartlead: 'Smartlead', heyreach: 'HeyReach',
  attio: 'Attio', pipedrive: 'Pipedrive', calendly: 'Calendly', cal_com: 'Cal.com',
  notion: 'Notion', airtable: 'Airtable',
  agent: 'Agent', user: 'Manual', import: 'Import', csv: 'CSV', system: 'System',
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
  Fireflies: 12, Gmail: 8, LinkedIn: 8, Slack: 6,
  HubSpot: 2, Salesforce: 2, Attio: 2, Pipedrive: 2,
  Agent: 2, Manual: 4,
  Calendar: -12,                        // mostly recurring placeholders
  Apollo: -10, Instantly: -6, Smartlead: -6, HeyReach: -6,
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
  type: string;
  claims: unknown;
  facts: unknown;
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
    }));

  return {
    entity_id: acc.entity_id,
    type: acc.type,
    claims: acc.claims,
    facts: acc.facts,
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
