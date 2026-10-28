// When a claim was said, how long it stays worth acting on, and what reads first (GET-770).
//
// A claim used to be dated when WE wrote it and stamped 'fresh' forever: a backfill of June dated
// June's facts today, and a buying signal from two months ago read exactly as fresh as this
// morning's. On Acme that let "needs this turnaround for another couple of months" (Sep 29)
// outrank "now I want to present it to the other stakeholders" (Oct 7) in the advice a rep got.
//
// Three rules live here, all pure, so the writer, every reader and the tests share one clock:
//   1. A claim's date is when it was SAID (the source's occurred-at), not when it was written.
//   2. It ages by WHAT it is: a buying signal is stale in weeks, a firmographic in a year.
//   3. Readers lead with the current position — the newest live claim per time-bound topic —
//      and keep the rest as history, never deleting it.

import { normalizeClaimCategory, normalizeToolName } from './claimCategories.js';
import type { Freshness } from './claims.js';

const DAY = 86_400_000;

/**
 * Days until a claim is no longer fresh. Twice this and it is `suspect`; four times, `expired`.
 * A position (what they intend, want, object to, plan) moves in weeks; who they are moves in years.
 */
const HALF_LIFE_DAYS: Record<string, number> = {
  buying_signal: 14,
  blocker: 30,
  timeline: 30,
  objection: 30,
  risk_signal: 30,
  adoption: 30,
  budget: 45,
  goal: 45,
  expansion_signal: 45,
  competitor: 60,
  pain: 60,
  performance: 60,
  general: 60,
  requirement: 90,
  status_quo: 90,
  authority: 120,
  staff_change: 120,
  preference: 180,
  proficiency: 180,
  tech_stack: 180,
  seasonality: 365,
  firmographic: 365,
  relationship: 365,
  discovery: 365,
};

/**
 * The categories a later statement can REPLACE: a stance, a plan, a constraint, a state of the
 * deal. "Found us on Hacker News" is never contradicted by a later call; "needs a couple of
 * months" is, and when it is, the older one must stop reading as current.
 */
export const TIME_BOUND_CATEGORIES: readonly string[] = [
  'buying_signal', 'timeline', 'budget', 'objection', 'goal', 'competitor', 'risk_signal',
  'expansion_signal', 'adoption', 'authority', 'staff_change', 'performance', 'pain', 'status_quo',
  'blocker', 'requirement', 'tech_stack',
];
const TIME_BOUND = new Set(TIME_BOUND_CATEGORIES);

export function halfLifeDays(category?: string | null): number {
  return HALF_LIFE_DAYS[normalizeClaimCategory(category)] ?? HALF_LIFE_DAYS.general;
}

export function isTimeBound(category?: string | null): boolean {
  return TIME_BOUND.has(normalizeClaimCategory(category));
}

/** How fresh a claim is NOW, from what it is and when it was said. No date reads as unknown age. */
export function noteFreshness(category: string | null | undefined, saidAt: string | null | undefined, now: number = Date.now()): Freshness {
  const t = saidAt ? Date.parse(saidAt) : NaN;
  if (!Number.isFinite(t)) return 'suspect';
  const age = (now - t) / DAY;
  const hl = halfLifeDays(category);
  if (age < hl) return 'fresh';
  if (age < 2 * hl) return 'aging';
  if (age < 4 * hl) return 'suspect';
  return 'expired';
}

/** When a claim stops being something to act on: the end of `aging`. */
export function noteDecaysAt(category: string | null | undefined, saidAt: string): string {
  return new Date(Date.parse(saidAt) + 2 * halfLifeDays(category) * DAY).toISOString();
}

// A source clock a few minutes ahead of ours is skew, not the future.
const SKEW_MS = 10 * 60_000;

/** The date to file a claim under: the source's, when it is a real date and not in the future; else now. */
export function resolveSaidAt(input: string | null | undefined, now: number = Date.now()): string {
  const t = input ? Date.parse(input) : NaN;
  if (!Number.isFinite(t) || t > now + SKEW_MS) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

/**
 * When a claim's event HAPPENS or happened, as a reader shows it (GET-1051), from the claim's
 * value metadata: occurred_start / occurred_end (YYYY-MM-DD), set by extraction for a fact_kind
 * "event" only. One day: "2026-03-14"; a period: "2026-03-01 to 2026-03-31"; open-ended:
 * "from 2026-03-01" / "until 2026-03-31". Undefined for a state or an undated event.
 * This is never the claim's clock: freshness and replacement still run on when it was SAID.
 */
export function occurredLabel(meta: { occurred_start?: unknown; occurred_end?: unknown; fact_kind?: unknown } | null | undefined): string | undefined {
  if (!meta || (meta.fact_kind != null && meta.fact_kind !== 'event')) return undefined;
  const iso = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const s = iso(meta.occurred_start), e = iso(meta.occurred_end);
  if (s && e) return s === e ? s : `${s} to ${e}`;
  if (s) return `from ${s}`;
  if (e) return `until ${e}`;
  return undefined;
}

const TIER: Record<Freshness, number> = { fresh: 0, aging: 1, suspect: 2, expired: 3 };

interface DatedFact {
  category: string; date?: string | null;
  /** A blocker's metadata.status: open | resolved (GET-776). Absent reads as open. */
  status?: string | null;
  /** A tech_stack fact's metadata.tool, the slot the account groups the stack by (GET-776). */
  tool?: string | null;
}

/** Fresh before stale, newest first within a tier. History stays — it just reads after. */
export function orderCurrentFirst<T extends DatedFact>(facts: T[], now: number = Date.now()): T[] {
  return [...facts]
    .map(f => ({ f, tier: TIER[noteFreshness(f.category, f.date, now)], t: Date.parse(f.date ?? '') || 0 }))
    .sort((a, b) => a.tier - b.tier || b.t - a.t)
    .map(x => x.f);
}

/**
 * The newest live claim per time-bound topic — what is true about the deal right now. Anything
 * already suspect or expired is not a current position: it is history the rep can still read.
 */
export function currentPositions<T extends DatedFact>(facts: T[], now: number = Date.now()): T[] {
  const newest = new Map<string, { f: T; t: number }>();
  for (const f of facts) {
    const cat = normalizeClaimCategory(f.category);
    if (!TIME_BOUND.has(cat)) continue;
    const fr = noteFreshness(cat, f.date, now);
    if (fr !== 'fresh' && fr !== 'aging') continue;
    const t = Date.parse(f.date ?? '') || 0;
    const cur = newest.get(cat);
    if (!cur || t > cur.t) newest.set(cat, { f, t });
  }
  return [...newest.values()].sort((a, b) => b.t - a.t).map(x => x.f);
}

/**
 * The topics an agent's CURRENT POSITION is made of: where the DEAL stands (GET-798). The other
 * time-bound categories (status quo, adoption, pain, goal...) still age and still read
 * current-first in `facts`; they are just not the deal's position, and printing them beside the
 * buying signal made "they do it by hand today" read as news on a par with "they want to sign".
 */
export const DEAL_POSITION_CATEGORIES: readonly string[] = [
  'buying_signal', 'timeline', 'blocker', 'requirement', 'objection', 'budget', 'authority', 'competitor',
];
const DEAL_POSITION = new Set(DEAL_POSITION_CATEGORIES);
/** Several of these can be true at once: every open blocker and every live requirement counts. */
export const MULTI_POSITION_CATEGORIES: readonly string[] = ['blocker', 'requirement'];
const MULTI_POSITION = new Set(MULTI_POSITION_CATEGORIES);

/**
 * Where the deal stands now: the newest live claim per deal topic, plus EVERY open blocker and
 * every live requirement (two blockers are two problems, not one replacing the other). A blocker
 * marked resolved is not a position; anything suspect or expired is history (GET-798).
 */
export function dealPosition<T extends DatedFact>(facts: T[], now: number = Date.now()): T[] {
  const newest = new Map<string, { f: T; t: number }>();
  const many: { f: T; t: number }[] = [];
  for (const f of facts) {
    const cat = normalizeClaimCategory(f.category);
    if (!DEAL_POSITION.has(cat)) continue;
    const fr = noteFreshness(cat, f.date, now);
    if (fr !== 'fresh' && fr !== 'aging') continue;
    if (cat === 'blocker' && String(f.status ?? '').toLowerCase() === 'resolved') continue;
    const t = Date.parse(f.date ?? '') || 0;
    if (MULTI_POSITION.has(cat)) { many.push({ f, t }); continue; }
    const cur = newest.get(cat);
    if (!cur || t > cur.t) newest.set(cat, { f, t });
  }
  return [...newest.values(), ...many].sort((a, b) => b.t - a.t).map(x => x.f);
}

export interface TechStackGroup<T> {
  /** The canonical tool name (normalizeToolName), or 'Other' for a fact that names none. */
  tool: string;
  /** What the newest fact about this tool says: the one line to read. */
  summary: string;
  /** Its facts, newest first. */
  facts: T[];
}

const TECH_FACTS_PER_TOOL = 5;

/**
 * The account's stack, one entry per tool (GET-798). Tech-stack facts arrived as loose sentences
 * among the rest; grouped by metadata.tool they read as a stack: "HubSpot — <newest fact>".
 */
export function techStackGroups<T extends DatedFact & { content?: string }>(facts: T[]): TechStackGroup<T>[] {
  const groups = new Map<string, { f: T; t: number }[]>();
  for (const f of facts) {
    if (normalizeClaimCategory(f.category) !== 'tech_stack') continue;
    const tool = normalizeToolName(f.tool) ?? 'Other';
    const list = groups.get(tool) ?? [];
    list.push({ f, t: Date.parse(f.date ?? '') || 0 });
    groups.set(tool, list);
  }
  return [...groups.entries()]
    .map(([tool, list]) => {
      list.sort((a, b) => b.t - a.t);
      return { tool, newest: list[0].t, facts: list.slice(0, TECH_FACTS_PER_TOOL).map(x => x.f) };
    })
    // Named tools first, newest first; the 'Other' bucket last.
    .sort((a, b) => Number(a.tool === 'Other') - Number(b.tool === 'Other') || b.newest - a.newest)
    .map(({ tool, facts }) => ({ tool, summary: String(facts[0]?.content ?? ''), facts }));
}

/** One side of a replacement: what was said, and when. */
export interface ReplacementSide { category: string; content: string; said_at: string | null }
export interface Replacement { old: ReplacementSide; new: ReplacementSide }

export interface RetiredClaim extends ReplacementSide { superseded_by: string | null; invalid_at: string | null }

/**
 * What changed (GET-798): each claim retired by a newer one, paired with its successor. Only
 * replacements inside the window (by when the old one was retired or the new one was said),
 * newest first, capped. A pair is built only when BOTH sides are passed in, so the caller decides
 * readability by what it hands over.
 */
export function pairReplacements(
  retired: RetiredClaim[],
  successors: Map<string, ReplacementSide>,
  { now = Date.now(), windowDays = 60, limit = 6 }: { now?: number; windowDays?: number; limit?: number } = {},
): Replacement[] {
  const cutoff = now - windowDays * DAY;
  const seen = new Set<string>();
  const out: { r: Replacement; tn: number; ti: number }[] = [];
  for (const old of retired) {
    if (!old.superseded_by) continue;
    const next = successors.get(old.superseded_by);
    if (!next) continue;
    const ti = Date.parse(old.invalid_at ?? '') || 0;
    const tn = Date.parse(next.said_at ?? '') || 0;
    if (ti < cutoff && tn < cutoff) continue;
    const key = `${old.category}|${old.content}|${old.superseded_by}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      r: {
        old: { category: old.category, content: old.content, said_at: old.said_at ?? null },
        new: { category: next.category, content: next.content, said_at: next.said_at ?? null },
      },
      tn, ti,
    });
  }
  return out.sort((a, b) => b.tn - a.tn || b.ti - a.ti).slice(0, limit).map(x => x.r);
}

/**
 * The facts block of a context read (GET-770, GET-798): the deal's current position first, the
 * stack grouped by tool, and then the OTHER facts: current-first, capped, and without the ones
 * already shown above, so nothing is paid for twice. `total` counts those other facts, so a
 * truncation never reads as absence (GET-371).
 */
export function shapeContextFacts<T extends DatedFact & { content?: string }>(
  facts: T[],
  { now = Date.now(), cap = 15 }: { now?: number; cap?: number } = {},
): {
  facts: (T & { freshness: Freshness })[];
  current_position: (T & { freshness: Freshness })[];
  tech_stack: TechStackGroup<T & { freshness: Freshness }>[];
  total: number;
} {
  const withFreshness = facts.map(f => ({ ...f, freshness: noteFreshness(f.category, f.date, now) }));
  const current_position = dealPosition(withFreshness, now);
  const tech_stack = techStackGroups(withFreshness);
  const shown = new Set<object>([...current_position, ...tech_stack.flatMap(g => g.facts)]);
  const rest = withFreshness.filter(f => !shown.has(f));
  return {
    facts: orderCurrentFirst(rest, now).slice(0, cap),
    current_position,
    tech_stack,
    total: rest.length,
  };
}
