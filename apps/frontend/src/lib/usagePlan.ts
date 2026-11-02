// The API plan's Usage and billing page (GET-633): the plan line, the meters and the 30-day bars,
// worked out from GET /api/billing/state and /api/usage/conversations. Pure, so
// tests/usagePlan.test.ts pins it.

import { day, num } from "./format.ts";

export type Tier = { credits: number; priceUsd: number };

/** The slice of GET /api/billing/state this page reads. */
export type PlanState = {
  plan: string;
  /** What this subscription pays a month, so a grandfathered price reads as itself. */
  priceUsd?: number | null;
  subscription?: { current_period_end?: string | null; cancel_at_period_end?: boolean } | null;
  aiCredits?: {
    used: number;
    included: number | null;
    needsPlan?: boolean;
    /** The no-card trial (GET-1087). */
    trial?: { endsAt: string; daysLeft: number; ended: boolean } | null;
    backfill?: { used: number; allowance: number | null } | null;
  } | null;
  allPlans?: { id: string; monthlyPriceUsd: number | null }[];
};

export type PlanLine = {
  /** "2,000 credits", "Trial", or "API plan" when there is no allowance. */
  name: string;
  /** "$49 a month", "From $49 a month" before a plan is chosen, null when nothing says. */
  price: string | null;
  /** "Renews 1 Nov", "Ends 1 Nov" when cancelling, null without a period end. */
  renews: string | null;
  /** The plan's monthly credits, null when there is no allowance. */
  credits: number | null;
};

/**
 * The plan line. The price is the bundle the allowance names (the Stripe price decides both, see
 * getPlanFromSubscription in the API), falling back to the plan's own number.
 */
export function planLine(state: PlanState, tiers: Tier[], now: number | Date = Date.now()): PlanLine {
  const c = state.aiCredits;
  if (c?.trial && !c.trial.ended) {
    const left = c.trial.daysLeft;
    return { name: "Trial", price: `${left} day${left === 1 ? "" : "s"} left`, renews: null, credits: c.included ?? null };
  }
  const included = c?.included != null && c.included > 0 ? c.included : null;
  const paying = state.priceUsd ?? null;
  const tier = included != null
    ? tiers.find((t) => t.credits === included && (paying == null || t.priceUsd === paying))
    : undefined;
  const listed = state.allPlans?.find((p) => p.id === state.plan)?.monthlyPriceUsd ?? null;
  let price: string | null = null;
  if (c?.needsPlan) price = tiers[0] ? `From $${tiers[0].priceUsd} a month` : null;
  else if (paying != null) price = `$${paying} a month`;
  else if (tier) price = `$${tier.priceUsd} a month`;
  else if (listed != null) price = `$${listed} a month`;
  const end = state.subscription?.current_period_end ?? null;
  const d = end && !c?.needsPlan ? day(end, now) : "";
  const renews = d ? `${state.subscription?.cancel_at_period_end ? "Ends" : "Renews"} ${d}` : null;
  // A size is its credits, on sale or not: someone on a retired price reads the same way.
  return { name: !c?.needsPlan && included != null ? `${num(included)} credits` : "API plan", price, renews, credits: c?.needsPlan ? null : included };
}

/** A meter's fill, 0–100. */
export function fillPct(used: number | null | undefined, of: number | null | undefined): number {
  if (!of || of <= 0 || !used || used <= 0) return 0;
  return Math.min(100, Math.round((used / of) * 1000) / 10);
}

export type DayCredits = {
  day: string; credits: number;
  /** The day split (GET-721): conversations read, AI work, and the automations' share of the AI work. */
  reads?: number; ai?: number; automations?: number;
};

export type Bars = {
  bars: { day: string; credits: number; pct: number; label: string }[];
  /** "Peak 31 on 24 Sep", null when nothing was used. */
  peak: string | null;
  /** First, middle and last day: the axis under the bars. */
  axis: string[];
};

/** The 30-day bars: each day's height against the busiest day. */
export function dailyBars(daily: DayCredits[], now: number | Date = Date.now()): Bars {
  const max = Math.max(0, ...daily.map((d) => d.credits || 0));
  const bars = daily.map((d) => ({
    day: d.day,
    credits: d.credits || 0,
    pct: max > 0 ? Math.round(((d.credits || 0) / max) * 100) : 0,
    label: `${day(d.day, now)}: ${num(d.credits || 0)} credits`,
  }));
  const top = max > 0 ? daily.find((d) => d.credits === max) : undefined;
  const axis = daily.length
    ? [daily[0], daily[Math.floor((daily.length - 1) / 2)], daily[daily.length - 1]].map((d) => day(d.day, now))
    : [];
  return { bars, peak: top ? `Peak ${num(max)} on ${day(top.day, now)}` : null, axis };
}

/**
 * The By key table's Credits cell (API plan E6). `credits` comes from GET /api/usage/by-key, which
 * counts what the read ledger billed to each key. Null or missing means the source cannot tell
 * (reads from before keys were stamped, or the sum failed): "—", never a 0 it does not know.
 */
export function keyCreditsCell(credits: number | null | undefined): { text: string; muted: boolean } {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return { text: "—", muted: true };
  return { text: num(credits), muted: credits === 0 };
}
