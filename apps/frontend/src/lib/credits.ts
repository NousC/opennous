// The credits meter as the sidebar shows it (GET-620): used / included, a fill, and when it resets.
//
// Read from the same /api/billing/state payload the Usage page reads, so the two never disagree.
// Pure, so tests/credits.test.ts pins it.

import { day, num } from "./format.ts";

/** The slice of GET /api/billing/state the meter needs. */
export type CreditsState = {
  aiCredits?: { used: number; included: number | null; needsPlan?: boolean; state?: string | null; periodEnd?: string | null } | null;
  subscription?: { current_period_end?: string | null } | null;
} | null | undefined;

export type CreditsMeter = {
  used: string;
  /** null when the plan has no allowance (unlimited / quoted): no "/ N", no bar. */
  included: string | null;
  /** 0–100, capped for the bar. */
  pct: number;
  /** "Resets 1 Nov", or null when there is no billing period end to read. */
  resets: string | null;
  /** At or past the allowance (GET-733): the card turns red and says an upgrade is needed. */
  over: boolean;
  /** Reading has stopped (past 120%). */
  stopped: boolean;
};

export function creditsMeter(state: CreditsState, now: number | Date = Date.now()): CreditsMeter | null {
  const c = state?.aiCredits;
  if (!c || c.needsPlan) return null;
  const used = Math.max(0, c.used ?? 0);
  const included = c.included != null && c.included > 0 ? c.included : null;
  const pct = included ? Math.min(100, Math.round((used / included) * 1000) / 10) : 0;
  const end = state?.subscription?.current_period_end ?? c.periodEnd ?? null;
  const resetDay = end ? day(end, now) : "";
  return {
    used: num(used),
    included: included != null ? num(included) : null,
    pct,
    resets: resetDay ? `Resets ${resetDay}` : null,
    over: c.state === "over" || c.state === "restricted",
    stopped: c.state === "restricted",
  };
}
