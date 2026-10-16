// What a workspace used, in credits — one credit per conversation READ (GET-503).
//
// The pricing page says "one credit is one conversation read", and the Activity ledger lists
// exactly that: an email thread read is one credit, a call read is one, a meeting is one per ten
// minutes. Billing used to count something else — raw model spend at $0.02 a credit, whatever
// caused it — so the balance and the ledger disagreed (one customer over a month was billed about
// twice the conversations it read) and the page's own footnote was untrue. This is the one definition
// now: the billing page, the credit gate, the chart and the worker's backfill gate all read it.
//
// Background work — insights, topics, scoring, the agent — is included in the plan, not billed.
// Skipped and unread conversations cost nothing: only what was read counts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { cloudRequestedFeatures } from '../services/cloudRequestedFeatures.js';

export const MEETING_MINUTES_PER_CREDIT = 10;

/**
 * THE DENOMINATION. A credit is a unit of account, not a unit of work — the work is a
 * conversation read, and how many credits that costs is a choice. Two, because the number a
 * customer compares is the allowance, and at one-per-conversation ours reads small beside
 * tools that bill a credit per row.
 *
 * It applies HERE, at counting time, not where reads are written: the ledger stores
 * conversations and this turns them into credits, so the scale moves without rewriting
 * history. Change it and every allowance in plans.mjs must move with it, or the product
 * silently doubles.
 */
export const CREDIT_SCALE = 2;

/**
 * WORK A PERSON ASKS FOR is metered by what it actually cost (GET-516), at the same
 * denomination as a read: one credit per $0.01 BEFORE the scale, half a cent after it. Background work that runs on its own — extraction, the insights board, clustering,
 * scorecards, topic grouping, health — is part of the plan and never billed.
 * Nous Cloud's own features are billed the same way and named in its folder
 * (services/cloudRequestedFeatures.ts, GET-924); conversationCredits adds them.
 */
export const REQUESTED_USD_PER_CREDIT = 0.01 / CREDIT_SCALE;
export const REQUESTED_FEATURES = [
  'home-agent-turn', 'home-agent-close', 'playground-agent-turn',       // the agent, and what it drafts inline
  'studio-email-draft', 'studio-linkedin-draft', 'studio-email-brief', 'studio-campaign-brief',
  'sequence-ai-step',
  'automation-email-draft',         // a detector automation's drafted follow-up (GET-685), capped per day
  'automation-handoff',             // a canvas automation's AI steps: summaries, follow-ups, CRM fields (GET-721)
  'revenue-report',                 // a report someone asked for
  'insight-topic-recommendation',   // "what should we do about this" on an insight topic
];
/** A meeting whose provider gave no length bills at the measured median. */
export const MEETING_DEFAULT_MINUTES = 30;

const PAGE = 1000;

export interface ConversationCredits {
  /** The month's credits: every read outside a backfill window. */
  total: number;
  /** Reads made while a backfill ran (GET-515) — shown apart, never counted against the month. */
  backfill: number;
  /** Work a person asked for — the agent, drafts, reports — at one credit per $0.01 (GET-516). */
  requested: number;
  /** Of `requested`, what automations spent (GET-721). */
  automations: number;
  /** Per day, split: conversations read, AI work, and the automations' share of the AI work. */
  readsByDay: Map<string, number>;
  aiByDay: Map<string, number>;
  automationsByDay: Map<string, number>;
  email: number;
  calls: number;
  meetings: number;
  /** YYYY-MM-DD (UTC) → credits that day. */
  byDay: Map<string, number>;
}

export function meetingCredits(observedAt: string | null, endTime: string | null): number {
  let mins: number | null = null;
  if (observedAt && endTime) {
    const m = (Date.parse(endTime) - Date.parse(observedAt)) / 60000;
    if (Number.isFinite(m) && m > 0 && m < 600) mins = m;
  }
  return CREDIT_SCALE * Math.max(1, Math.ceil((mins ?? MEETING_DEFAULT_MINUTES) / MEETING_MINUTES_PER_CREDIT));
}

async function pageAll<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** When a workspace's backfill ran: reads inside it are backfill credits. */
export interface BackfillWindow { from: string; to: string }

const cache = new Map<string, { at: number; value?: ConversationCredits; pending?: Promise<ConversationCredits> }>();
const FRESH_MS = 10 * 60 * 1000;

/**
 * conversationCredits, remembered for ten minutes per (workspaces, window). Past that the last
 * answer is returned at once and a fresh one computed behind it — the billing page and the credit
 * gate never wait on a recount of a large workspace. Only the very first call waits.
 */
export async function cachedConversationCredits(
  supabase: SupabaseClient, workspaceIds: string[], since: string, backfillWindows: BackfillWindow[] = [],
): Promise<ConversationCredits> {
  const key = `${[...workspaceIds].sort().join(',')}|${since}|${backfillWindows.map(w => `${w.from}>${w.to}`).join(';')}`;
  const hit = cache.get(key);
  const refresh = () => {
    const pending = conversationCredits(supabase, workspaceIds, since, null, backfillWindows)
      .then((value) => { cache.set(key, { at: Date.now(), value }); return value; })
      .catch((err) => { const e = cache.get(key); if (e) e.pending = undefined; throw err; });
    cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
    return pending;
  };
  if (hit?.value) {
    if (Date.now() - hit.at > FRESH_MS && !hit.pending) refresh().catch(() => {});
    return hit.value;
  }
  return hit?.pending ?? refresh();
}

/**
 * Credits used by these workspaces from `since` (inclusive) to `until` (exclusive, default now),
 * counted WHEN EACH CONVERSATION WAS READ: one `noema.read` record per conversation. Email threads
 * are written by the email reader (one credit each, moved to the latest read); meetings and calls
 * by the read ledger (apps/worker/src/workers/readLedger.mjs) the first time a claim cites them,
 * carrying their credits. A sum over one indexed property — no scan of claims.
 */
export async function conversationCredits(
  supabase: SupabaseClient, workspaceIds: string[], since: string, until: string | null = null,
  backfillWindows: BackfillWindow[] = [],
): Promise<ConversationCredits> {
  const out: ConversationCredits = { total: 0, backfill: 0, requested: 0, email: 0, calls: 0, meetings: 0, byDay: new Map(), readsByDay: new Map(), aiByDay: new Map(), automationsByDay: new Map(), automations: 0 };
  let automationsUsd = 0;
  let requestedUsd = 0;
  const windows = backfillWindows.map(w => [Date.parse(w.from), Date.parse(w.to)] as const);
  const inBackfill = (iso: string) => { const t = Date.parse(iso); return windows.some(([a, b]) => t >= a && t <= b); };
  for (const ws of workspaceIds) {
    const reads = await pageAll<{ source: string; observed_at: string; value: { kind?: string; credits?: number } | null }>((a, b) => {
      let q = supabase.from('observations').select('source, observed_at, value')
        .eq('workspace_id', ws).eq('property', 'noema.read').gte('observed_at', since);
      if (until) q = q.lt('observed_at', until);
      return q.order('observed_at').range(a, b);
    });
    for (const r of reads) {
      const kind = r.source === 'gmail' ? 'email' : (r.value?.kind ?? 'meeting');
      // The ledger stores CONVERSATIONS; the scale turns them into credits here, so a
      // redenomination never has to rewrite what was already read.
      const n = CREDIT_SCALE * (r.source === 'gmail' ? 1 : Math.max(0, Number(r.value?.credits ?? 1)));
      if (windows.length && inBackfill(r.observed_at)) { out.backfill += n; continue; }
      if (kind === 'email') out.email += n; else if (kind === 'call') out.calls += n; else out.meetings += n;
      const day = String(r.observed_at ?? '').slice(0, 10);
      if (day) { out.byDay.set(day, (out.byDay.get(day) ?? 0) + n); out.readsByDay.set(day, (out.readsByDay.get(day) ?? 0) + n); }
    }
  }
  // What people asked for, metered by its cost. A Cloud build adds its own features (GET-924).
  const cloud = await cloudRequestedFeatures();
  const requestedFeatures = [...REQUESTED_FEATURES, ...cloud.requested];
  const cloudAutomations = new Set(cloud.automations);
  for (const ws of workspaceIds) {
    const rows = await pageAll<{ cost_usd: number | null; occurred_at: string; feature?: string | null }>((a, b) => {
      let q = supabase.from('llm_usage').select('cost_usd, occurred_at, feature')
        .eq('workspace_id', ws).in('feature', requestedFeatures).gte('occurred_at', since);
      if (until) q = q.lt('occurred_at', until);
      return q.order('occurred_at').range(a, b);
    });
    for (const r of rows) {
      const usd = Number(r.cost_usd) || 0;
      requestedUsd += usd;
      const day = String(r.occurred_at ?? '').slice(0, 10);
      const auto = String(r.feature ?? '').startsWith('automation-') || cloudAutomations.has(String(r.feature));
      if (auto) automationsUsd += usd;
      if (day) {
        out.byDay.set(day, (out.byDay.get(day) ?? 0) + usd / REQUESTED_USD_PER_CREDIT);
        out.aiByDay.set(day, (out.aiByDay.get(day) ?? 0) + usd / REQUESTED_USD_PER_CREDIT);
        if (auto) out.automationsByDay.set(day, (out.automationsByDay.get(day) ?? 0) + usd / REQUESTED_USD_PER_CREDIT);
      }
    }
  }
  out.requested = Math.ceil(requestedUsd / REQUESTED_USD_PER_CREDIT - 1e-9);
  out.automations = Math.ceil(automationsUsd / REQUESTED_USD_PER_CREDIT - 1e-9);
  for (const m of [out.byDay, out.readsByDay, out.aiByDay, out.automationsByDay]) for (const [d, v] of m) m.set(d, Math.round(v));
  out.total = out.email + out.calls + out.meetings + out.requested;
  return out;
}

// ── Credits per API key (API plan E6, GET-620) ──────────────────────────────
//
// A read is billed asynchronously: the read ledger writes a meeting's or call's `noema.read` the
// first time a claim cites it, often long after the request that wrote the claim. So a key's
// credits cannot be counted on the request; they follow the data. A claim written through an API
// key carries `metadata.api_key_id` (apps/api/src/lib/recordObservations.mjs), and the ledger
// copies it onto the read it bills (`value.api_key_id`: the key's id, or null when the claim that
// first cited the conversation came from anywhere else). Email is never a key's: its reader runs
// on the mailbox's OAuth connection.
//
// A read recorded before the ledger stamped keys has no `api_key_id` field at all. That is
// "cannot tell", which is not the same as "no key", so it is counted apart as `unknown`.

/** One `noema.read` row, as the by-key sum reads it. */
export interface ReadRow {
  source: string | null;
  value: { kind?: string; credits?: number; api_key_id?: string | null } | null;
}

export interface CreditsByKey {
  /** api key id → credits its requests caused. */
  byKey: Map<string, number>;
  /** Credits on reads something else caused (an integration, the app). */
  unattributed: number;
  /** Credits on reads recorded before keys were stamped: their cause is not on record. */
  unknown: number;
}

/** A read's credits at the scale billing counts them (the same rule as conversationCredits). */
export function readRowCredits(r: ReadRow): number {
  return CREDIT_SCALE * (r.source === 'gmail' ? 1 : Math.max(0, Number(r.value?.credits ?? 1)));
}

/** Sum reads per key. Pure: the query is conversationCreditsByKey. */
export function creditsByKeyFromReads(rows: ReadRow[]): CreditsByKey {
  const out: CreditsByKey = { byKey: new Map(), unattributed: 0, unknown: 0 };
  for (const r of rows) {
    const n = readRowCredits(r);
    if (!n) continue;
    if (r.source === 'gmail') { out.unattributed += n; continue; }
    const v = r.value ?? {};
    if (!Object.prototype.hasOwnProperty.call(v, 'api_key_id')) { out.unknown += n; continue; }
    const key = typeof v.api_key_id === 'string' && v.api_key_id ? v.api_key_id : null;
    if (!key) { out.unattributed += n; continue; }
    out.byKey.set(key, (out.byKey.get(key) ?? 0) + n);
  }
  return out;
}

/**
 * Credits per API key in one workspace from `since` (inclusive), off the read ledger. Email reads
 * are left out at the query (never a key's, and by far the most rows). Throws on a read error: a
 * failed read must never pass for "this key spent nothing".
 */
export async function conversationCreditsByKey(
  supabase: SupabaseClient, workspaceId: string, since: string, until: string | null = null,
): Promise<CreditsByKey> {
  const rows = await pageAll<ReadRow>((a, b) => {
    let q = supabase.from('observations').select('source, value')
      .eq('workspace_id', workspaceId).eq('property', 'noema.read').neq('source', 'gmail')
      .gte('observed_at', since);
    if (until) q = q.lt('observed_at', until);
    return q.order('observed_at').range(a, b);
  });
  return creditsByKeyFromReads(rows);
}
