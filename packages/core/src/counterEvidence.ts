// Evidence AGAINST — the half of the record every copilot leaves out.
//
// An assistant that only ever shows you why it is right is not showing you evidence, it is
// showing you a case. The difference is invisible right up until the one time it matters,
// and by then the user has already learned that the panel underneath an answer is decoration.
//
// So: for any account, this derives the signals that argue AGAINST the optimistic reading
// alongside the ones that argue for it, from the same substrate, by the same rules, in the
// same pass. Not "supporting evidence, and separately a conflicts page" — one gathering, two
// columns, and the losing column rendered as prominently as the winning one.
//
// ── Why this is derivable and not a model call ──
//
// Every detector below reads something the graph already knows. Observations are append-only,
// so a property's whole value history is on record: a close date that moved three times left
// three observations, and nobody had to remember to log "slipped". `STAGE_RANK` orders the
// ladder, so "went backwards" is arithmetic. `field_conflicts` is already computed by the
// claim engine. Reply signals are already classified.
//
// That matters for trust in a way a smarter prompt could not buy. A model asked "what argues
// against this?" will produce something — fluent, plausible, and unfalsifiable. These signals
// each carry the observation that produced them and a `ref` that opens the original. A user
// can disagree with the weight; they cannot be told something that did not happen.
//
// ⚠️ A detector that cannot cite is not added here. If it can't point at a row, it is a
// feeling, and a feeling in the "evidence against" column is worse than an empty column —
// an empty column is a checkable claim ("we looked and found nothing"), a fabricated one is
// a lie with a confident border around it.

import type { SupabaseClient } from '@supabase/supabase-js';
import { STAGE_RANK } from './pipeline.js';
import { listConflicts } from './db/conflicts.js';
import { systemLabel, readableProperty, gist } from './evidence.js';

const DAY = 86_400_000;

/** Which way a signal cuts, relative to the OPTIMISTIC reading of an account. */
export type EvidenceSide = 'supports' | 'contradicts';

/**
 * One derived signal, with the row it came from. `ref` is what the citation panel resolves
 * into a link to the actual call or thread — the last step of "go look yourself".
 */
export interface DerivedSignal {
  key: string;
  side: EvidenceSide;
  /** What it says, in the words a rep would use. Six words, not a sentence. */
  headline: string;
  /** The specifics that make it checkable: the values, the dates, the counts. */
  detail: string;
  /** 0–1. How far this should move a reader's confidence, not how loud it is. */
  weight: number;
  when: string | null;
  source: string | null;
  ref: string | null;
}

/** Everything the gather found, both ways, plus whether it adds up to enough to say anything. */
export interface CounterEvidenceResult {
  supports: DerivedSignal[];
  contradicts: DerivedSignal[];
  /** Distinct systems the evidence came from. One source agreeing with itself is one source. */
  source_count: number;
  /** The newest thing we know. An assessment is only ever as current as this. */
  last_evidence_at: string | null;
  sufficiency: Sufficiency;
}

/**
 * Whether the evidence supports saying anything at all.
 *
 * This exists so "I don't know" can be a COMPUTED verdict rather than a model's mood. An
 * assistant that says "insufficient evidence" only when it happens to feel uncertain is
 * still guessing; one that says it whenever the record is genuinely thin is telling the
 * truth about the record. The second is the one people learn to trust.
 */
export interface Sufficiency {
  enough: boolean;
  /** Why, in one line, phrased for the reader rather than the developer. */
  reason: string;
  /**
   * What would change the answer. The point of admitting you don't know is to say what you'd
   * need — an "unclear" with no next step is just a shrug.
   */
  what_would_help: string[];
}

// ── Thresholds ───────────────────────────────────────────────────────────────
//
// Deliberately few and deliberately round. Every number here is a judgement call that will be
// wrong for somebody's sales cycle, and a dozen finely-tuned constants would only hide that
// behind apparent precision. These are the ones a person can argue with.

const QUIET_DAYS = 14;          // no inbound in two weeks is the classic slow no
const STALE_EVIDENCE_DAYS = 30; // older than a month is history, not a reading
const MIN_SOURCES = 2;          // one system agreeing with itself is not corroboration

/** Reply signals that argue against the deal, from the canonical taxonomy. */
const NEGATIVE_REPLIES = new Set(['negative', 'objection', 'unsubscribe', 'do_not_contact']);

/** Properties that name a date the deal is expected to land, across CRMs. */
const CLOSE_DATE_PROPS = new Set(['close_date', 'expected_close_date', 'closedate', 'deal_close_date']);

/** Observation properties that mean somebody on the other side did something. */
const INBOUND = /(received|reply|replied|accepted|meeting_held|meeting_booked)/;
const OUTBOUND = /(sent|invite_sent|outreach)/;

const days = (from: string | null | undefined, now: number): number | null => {
  if (!from) return null;
  const t = new Date(from).getTime();
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null;
};

const ago = (n: number | null): string =>
  n == null ? 'at an unknown time' : n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;

/**
 * A short, human rendering of an observation's value. Close dates and stage names are the
 * two we actually format; everything else falls back to the shared `gist`.
 */
function valueText(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') {
    const t = Date.parse(v);
    // An ISO date renders as a date. `Date.parse` also accepts a bare year, so require the
    // shape too — otherwise a stage called "2024 Pilot" becomes a timestamp.
    if (Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      // Rendered in UTC, deliberately. "2026-09-15" is a DATE, not an instant: parsed as UTC
      // midnight and printed in a timezone behind UTC it comes out as Sep 14, and a close
      // date shown one day early is precisely the small wrongness that teaches somebody the
      // evidence panel cannot be trusted.
      return new Date(t).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      });
    }
    return v;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'stage', 'value', 'date', 'signal']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return gist(v, 60);
}

/** Two values are "the same reading" if they render the same. Cheap, and right in practice. */
const sameValue = (a: unknown, b: unknown) => valueText(a) === valueText(b);

/** One observation, as the detectors need it. Exported so they can be tested without a DB. */
export interface EvidenceRow {
  id: string;
  property: string;
  value: unknown;
  source: string;
  observed_at: string;
  source_ref?: string | null;
}
type Row = EvidenceRow;

/**
 * Every detector, over one already-fetched history. Pure, so the interesting half of this
 * file is testable without a database — which matters more here than in most modules: a
 * detector that fires wrongly does not throw, it puts a confident false statement in the
 * "evidence against" column, and that is the exact failure this feature exists to prevent.
 *
 * Rows must be NEWEST FIRST. Several detectors read `rows[0]` as "the latest".
 */
export function detectSignals(rows: Row[], now: number = Date.now()): DerivedSignal[] {
  const out: DerivedSignal[] = [];
  for (const d of [
    closeDateSlipped(rows, now),
    stageRegressed(rows, now),
    wentQuiet(rows, now),
    negativeReply(rows, now),
    meetingCancelled(rows, now),
    recentMeeting(rows, now),
    positiveReply(rows, now),
    stageAdvanced(rows, now),
  ]) {
    if (d) out.push(d);
  }
  return out;
}

/**
 * Gather both sides of the record for one account.
 *
 * Reads the entity's observations once and runs every detector over that one array, because
 * the alternative — a query per detector — is how a panel that opens on click becomes a panel
 * that opens in two seconds, and nobody verifies anything through a two-second panel.
 */
export async function gatherCounterEvidence(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  opts: { limit?: number; now?: number } = {},
): Promise<CounterEvidenceResult> {
  const now = opts.now ?? Date.now();
  // Newest first, bounded. One account's history does not approach PostgREST's 1000-row cap,
  // and where it would, the newest 600 are the ones a reading should rest on anyway — but the
  // ORDER is what makes that true, so it is not optional. See lib/pageAll.mjs for the cap.
  const { data, error } = await supabase
    .from('observations')
    .select('id, property, value, source, observed_at, source_ref')
    .eq('workspace_id', workspaceId)
    .eq('entity_id', entityId)
    .order('observed_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 600, 1000));
  if (error) throw error;

  const rows = (data ?? []) as Row[];
  const supports: DerivedSignal[] = [];
  const contradicts: DerivedSignal[] = [];
  const push = (s: DerivedSignal) => (s.side === 'supports' ? supports : contradicts).push(s);

  for (const d of detectSignals(rows, now)) push(d);

  // Cross-source disagreement the claim engine already caught. It belongs in this column by
  // definition: an open conflict is the graph saying two systems cannot both be right, which
  // is evidence against any reading that quietly picked one of them.
  for (const c of await openConflictsFor(supabase, workspaceId, entityId, now)) push(c);

  const sources = new Set(rows.map(r => systemLabel(r.source)).filter(Boolean));
  const lastAt = rows[0]?.observed_at ?? null;

  return {
    supports: supports.sort((a, b) => b.weight - a.weight),
    contradicts: contradicts.sort((a, b) => b.weight - a.weight),
    source_count: sources.size,
    last_evidence_at: lastAt,
    sufficiency: assessSufficiency({
      sourceCount: sources.size,
      lastEvidenceAt: lastAt,
      signals: supports.length + contradicts.length,
      now,
    }),
  };
}

// ── Detectors ────────────────────────────────────────────────────────────────
//
// Each returns at most ONE signal. Three observations of the same slip is one fact about the
// deal, and letting a detector emit a row per observation would let the loudest source own
// the column — which is exactly the cherry-picking this file exists to prevent.

/**
 * A close date that keeps moving. The single most honest predictor of a deal that is not
 * going to close this quarter, and one no CRM field shows you: the field holds today's date
 * and says nothing about being rewritten twice.
 */
function closeDateSlipped(rows: Row[], now: number): DerivedSignal | null {
  const hist = rows.filter(r => CLOSE_DATE_PROPS.has(r.property));
  if (hist.length < 2) return null;

  // Oldest first, collapsing repeats — a nightly sync re-observing the same date is not a move.
  const seq: Row[] = [];
  for (const r of [...hist].reverse()) {
    if (!seq.length || !sameValue(seq[seq.length - 1].value, r.value)) seq.push(r);
  }
  if (seq.length < 2) return null;

  // Only count moves that push the date OUT. Pulling a close date forward is good news, and
  // counting it as a slip would make an accelerating deal look like a stalling one.
  const first = Date.parse(valueText(seq[0].value));
  const last = Date.parse(valueText(seq[seq.length - 1].value));
  if (Number.isFinite(first) && Number.isFinite(last) && last <= first) return null;

  const moves = seq.length - 1;
  const latest = seq[seq.length - 1];
  return {
    key: 'close_date_slipped',
    side: 'contradicts',
    headline: moves === 1 ? 'Close date has moved once' : `Close date has moved ${moves} times`,
    detail: `${seq.map(s => valueText(s.value)).join(' → ')} · last changed ${ago(days(latest.observed_at, now))}`,
    weight: Math.min(0.35 + 0.2 * moves, 0.9),
    when: latest.observed_at,
    source: systemLabel(latest.source),
    ref: latest.source_ref ?? null,
  };
}

/** The deal went backwards on the ladder. Uses canonical rank, so it works on custom stages. */
function stageRegressed(rows: Row[], now: number): DerivedSignal | null {
  const hist = rows.filter(r => r.property === 'pipeline_stage');
  if (hist.length < 2) return null;
  const seq = [...hist].reverse();

  let worst: { from: Row; to: Row; drop: number } | null = null;
  for (let i = 1; i < seq.length; i++) {
    const a = STAGE_RANK[String(valueText(seq[i - 1].value)).toLowerCase()];
    const b = STAGE_RANK[String(valueText(seq[i].value)).toLowerCase()];
    if (a == null || b == null || b >= a) continue;
    if (!worst || a - b > worst.drop) worst = { from: seq[i - 1], to: seq[i], drop: a - b };
  }
  if (!worst) return null;

  return {
    key: 'stage_regressed',
    side: 'contradicts',
    headline: 'Deal moved backwards',
    detail: `${valueText(worst.from.value)} → ${valueText(worst.to.value)}, ${ago(days(worst.to.observed_at, now))}`,
    weight: 0.7,
    when: worst.to.observed_at,
    source: systemLabel(worst.to.source),
    ref: worst.to.source_ref ?? null,
  };
}

/**
 * We are still talking; they are not. Counts our outbound SINCE their last inbound, which is
 * the thing that distinguishes a quiet account from an account being chased — and it is the
 * chase that tells you where you actually stand.
 */
function wentQuiet(rows: Row[], now: number): DerivedSignal | null {
  const lastIn = rows.find(r => INBOUND.test(r.property));
  const quietFor = days(lastIn?.observed_at ?? null, now);

  // Never seen inbound at all is a different (and worse) fact, but only once we have actually
  // reached out — otherwise every freshly-imported account is "going dark".
  const outbound = rows.filter(r => OUTBOUND.test(r.property));
  if (!outbound.length) return null;
  if (lastIn && (quietFor ?? 0) < QUIET_DAYS) return null;

  const since = lastIn
    ? outbound.filter(r => r.observed_at > lastIn.observed_at).length
    : outbound.length;

  return {
    key: 'gone_quiet',
    side: 'contradicts',
    headline: lastIn ? 'They have gone quiet' : 'They have never replied',
    detail: lastIn
      ? `Last reply ${ago(quietFor)}; ${since} outbound since with no response`
      : `${outbound.length} outbound touch${outbound.length === 1 ? '' : 'es'}, no reply on record`,
    weight: lastIn ? Math.min(0.3 + (quietFor ?? 0) / 60, 0.85) : 0.6,
    when: lastIn?.observed_at ?? outbound[0]?.observed_at ?? null,
    source: systemLabel((lastIn ?? outbound[0])?.source),
    ref: (lastIn ?? outbound[0])?.source_ref ?? null,
  };
}

/** Reads the classified reply signal — the taxonomy in replySignals.ts, not our own guess. */
function replyOf(r: Row): string | null {
  const v = r.value as Record<string, unknown> | string | null;
  const s = typeof v === 'string' ? v : typeof v?.signal === 'string' ? v.signal : null;
  return s ? s.toLowerCase() : null;
}

function negativeReply(rows: Row[], now: number): DerivedSignal | null {
  const hit = rows.find(r => /reply|replied/.test(r.property) && NEGATIVE_REPLIES.has(replyOf(r) ?? ''));
  if (!hit) return null;
  const signal = replyOf(hit)!;
  return {
    key: 'negative_reply',
    side: 'contradicts',
    headline: signal === 'objection' ? 'An objection is on the record' : 'They pushed back',
    detail: `${readableProperty(hit.property)} classified "${signal}" ${ago(days(hit.observed_at, now))}`,
    // An explicit opt-out is close to decisive; a live objection is a real but workable signal.
    weight: signal === 'do_not_contact' || signal === 'unsubscribe' ? 0.95 : signal === 'objection' ? 0.5 : 0.75,
    when: hit.observed_at,
    source: systemLabel(hit.source),
    ref: hit.source_ref ?? null,
  };
}

function meetingCancelled(rows: Row[], now: number): DerivedSignal | null {
  const cancels = rows.filter(r => /meeting_cancelled/.test(r.property));
  if (!cancels.length) return null;
  // A cancellation followed by a re-book is a scheduling fact, not a deal fact.
  const rebooked = rows.some(
    r => /meeting_(booked|scheduled)/.test(r.property) && r.observed_at > cancels[0].observed_at,
  );
  if (rebooked) return null;
  return {
    key: 'meeting_cancelled',
    side: 'contradicts',
    headline: cancels.length === 1 ? 'A meeting was cancelled' : `${cancels.length} meetings cancelled`,
    detail: `Most recent ${ago(days(cancels[0].observed_at, now))}, not rebooked`,
    weight: 0.6,
    when: cancels[0].observed_at,
    source: systemLabel(cancels[0].source),
    ref: cancels[0].source_ref ?? null,
  };
}

function recentMeeting(rows: Row[], now: number): DerivedSignal | null {
  const held = rows.find(r => /meeting_held/.test(r.property));
  const n = days(held?.observed_at ?? null, now);
  if (!held || n == null || n > STALE_EVIDENCE_DAYS) return null;
  return {
    key: 'recent_meeting',
    side: 'supports',
    headline: 'They met with us recently',
    detail: `Meeting held ${ago(n)}`,
    weight: 0.6,
    when: held.observed_at,
    source: systemLabel(held.source),
    ref: held.source_ref ?? null,
  };
}

function positiveReply(rows: Row[], now: number): DerivedSignal | null {
  const hit = rows.find(r => /reply|replied/.test(r.property) && replyOf(r) === 'positive');
  if (!hit) return null;
  return {
    key: 'positive_reply',
    side: 'supports',
    headline: 'They replied positively',
    detail: `${readableProperty(hit.property)} classified "positive" ${ago(days(hit.observed_at, now))}`,
    weight: 0.65,
    when: hit.observed_at,
    source: systemLabel(hit.source),
    ref: hit.source_ref ?? null,
  };
}

function stageAdvanced(rows: Row[], now: number): DerivedSignal | null {
  const hist = rows.filter(r => r.property === 'pipeline_stage');
  if (hist.length < 2) return null;
  const [latest, previous] = hist;                       // rows are newest-first
  const a = STAGE_RANK[String(valueText(previous.value)).toLowerCase()];
  const b = STAGE_RANK[String(valueText(latest.value)).toLowerCase()];
  if (a == null || b == null || b <= a) return null;
  return {
    key: 'stage_advanced',
    side: 'supports',
    headline: 'The deal moved forward',
    detail: `${valueText(previous.value)} → ${valueText(latest.value)}, ${ago(days(latest.observed_at, now))}`,
    weight: 0.55,
    when: latest.observed_at,
    source: systemLabel(latest.source),
    ref: latest.source_ref ?? null,
  };
}

/** Open cross-source conflicts on this entity, as counter-evidence rather than a separate page. */
async function openConflictsFor(
  supabase: SupabaseClient,
  workspaceId: string,
  entityId: string,
  now: number,
): Promise<DerivedSignal[]> {
  let conflicts;
  try {
    conflicts = await listConflicts(supabase, workspaceId, { statuses: ['open'], limit: 50 });
  } catch {
    // A conflicts read that fails must not take the whole panel down with it. Missing a
    // column is a degraded answer; an error where evidence should be is no answer at all.
    return [];
  }
  return conflicts
    .filter(c => c.entity_id === entityId && c.resolution === 'pending')
    .slice(0, 3)
    .map(c => {
      const [a, b] = c.candidates ?? [];
      return {
        key: `conflict:${c.canonical_property}`,
        side: 'contradicts' as const,
        headline: `Sources disagree on ${readableProperty(c.canonical_property)}`,
        detail: a && b
          ? `${systemLabel(a.source)} says ${valueText(a.value)}; ${systemLabel(b.source)} says ${valueText(b.value)}`
          : 'Two systems hold different values and nobody has picked one',
        weight: 0.5,
        when: c.last_fired_at ?? c.created_at,
        source: a ? systemLabel(a.source) : null,
        ref: null,
      };
    });
}

// ── Sufficiency ──────────────────────────────────────────────────────────────

/**
 * Is there enough here to say anything?
 *
 * Three ways the answer is no, and each one produces a DIFFERENT next step — which is the
 * whole point. "Not enough evidence" with no follow-on is a shrug; "the last thing we heard
 * was 60 days ago, get on a call" is an answer.
 */
export function assessSufficiency(input: {
  sourceCount: number;
  lastEvidenceAt: string | null;
  signals: number;
  now?: number;
}): Sufficiency {
  const now = input.now ?? Date.now();
  const age = days(input.lastEvidenceAt, now);

  if (!input.signals || !input.lastEvidenceAt) {
    return {
      enough: false,
      reason: 'Nothing on this account has been observed yet.',
      what_would_help: [
        'Connect the CRM or mailbox that holds this relationship',
        'Log the last conversation you had with them',
      ],
    };
  }

  if (age != null && age > STALE_EVIDENCE_DAYS) {
    return {
      enough: false,
      reason: `The most recent thing we know is ${ago(age)}. That is history, not a current read.`,
      what_would_help: [
        'A conversation with someone on their side',
        'A CRM sync, in case activity landed somewhere we are not reading',
      ],
    };
  }

  if (input.sourceCount < MIN_SOURCES) {
    return {
      enough: false,
      // Stated as a limit on us, not as a fault of theirs. One system agreeing with itself
      // reads as corroboration in a UI, and it is not.
      reason: 'Everything we know came from one system, so nothing here is corroborated.',
      what_would_help: [
        'Connect a second source (calls, or the mailbox) so claims can be cross-checked',
      ],
    };
  }

  return { enough: true, reason: '', what_would_help: [] };
}
