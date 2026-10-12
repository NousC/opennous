// What a backfill will cost, checked BEFORE we spend it.
//
// A history backfill is the one moment a workspace can hand us an unbounded bill: the
// window is fixed but the volume is whatever their CRM happens to hold, and none of it is
// metered until the models have already run. One customer's last 30 days is over ten thousand
// credits — more than Scale's whole monthly allowance — against plans that bill $29 to
// $249 a month. That is not a customer to refuse; it is a customer to onboard by hand.
// This module is how the two are told apart automatically.
//
// The rule is deliberately not a dollar ceiling. **The backfill has to fit inside the
// plan's own monthly credit allowance.** A workspace whose last 30 days holds more
// conversations than its plan sells in a month is not over budget, it is on the wrong
// plan — which is a sentence a customer can act on, and a number they already understand.
//
// Unit costs come from one customer's metered work; the derivation and the queries that
// reproduce it are in `docs/unit-economics.md`. Re-derive both together: a change to the
// extraction prompt, the claim schema or the model moves these numbers, and a stale
// ceiling either blocks customers we want or waves through the one that empties the
// account.

import { CREDIT_SCALE } from '@nous/core';

import { normalizePlanId } from './plans.mjs';

// ── What a conversation bills as ─────────────────────────────────────────────
//
// A meeting bills at one credit per 10 minutes. One customer's median meeting is 30 minutes
// and the mean about the same, measured across thousands of them, so three credits is the right default
// when we do not have the duration — which is most of the time at gate-check, because the
// meeting rows have not been pulled yet.
// At the same denomination the meter uses (CREDIT_SCALE in packages/core) — an estimate that
// counts in a different unit to the bill is worse than no estimate.
export const CREDITS_PER_UNIT = {
  meeting: 3 * CREDIT_SCALE,
  call: 1 * CREDIT_SCALE,
  email_thread: 1 * CREDIT_SCALE,
  note: 0, // not read — a handful of a thousand-odd a month ever reach a model
};

// What each one actually costs us, for the estimate we report alongside the decision.
export const UNIT_COST_USD = {
  meeting: 0.061, // extraction + summary + scoring + insights
  call: 0.0137, // extraction + scoring
  email_thread: 0.0048, // extraction
  note: 0,
};

/** Credits a meeting bills, given its length. Falls back to the measured median. */
export function creditsForMeeting(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return CREDITS_PER_UNIT.meeting;
  return CREDIT_SCALE * Math.max(1, Math.ceil(m / 10));
}

// ── What we will read without asking twice ───────────────────────────────────
//
// We do not cut the backfill. Some teams are more and some are less, and trimming it is
// how a customer's first day ends up half-sized. What we do instead is price it, show it
// and ask (GET-486) — so this is not a wall, it is the line between two questions:
//
//   under it   "We found 3,000 meetings and 8,000 threads across 2,000 accounts.
//               Shall we read them now?"
//   over it    "That is a bigger history than onboarding reads on its own — let's set it
//               up with you."
//
// A DOLLAR, not a credit count, because the thing being protected is the bill. Credits are
// what the customer buys; dollars are what we spend, and a backfill we absorb is spend.
//
// The ordinary customer never sees the second branch: a full month's allowance costs $11
// to backfill on API and $42.50 on Workspace, both well under. One customer's month is well over
// $100 and is over both, correctly.
// Dollars, so the denomination does not touch it.
export const BACKFILL_CEILING_USD = {
  api: 25,
  // Quoted against the account's own volume, so there is nothing to protect it from.
  custom: null,
};

// Credits per CRM record in a 30-day window, measured on a customer workspace: tens of thousands of
// credits against tens of thousands of contacts, companies and deals. That customer is the largest workspace we have,
// so this over-estimates a normal one — deliberately. An over-estimate routes someone to
// assisted onboarding; an under-estimate spends money nobody agreed to.
const CREDITS_PER_RECORD_30D = 0.19 * CREDIT_SCALE;

// THE BACKFILL ALLOWANCE, IN CREDITS (GET-515). What a plan's first backfill may read, on us:
// it is shown on the billing page as backfill credits and never counts against the month's.
// Product decision, 2026-10-01 (GET-545): 3,000 conversations on self-serve, down from 4,000. At the
// blended ~$0.0084 a conversation, 4,000 was ~$33.60 of model spend — over the $25 ceiling
// below, so the allowance we promised could never be reached without routing to support. 3,000
// is ~$25: the two guard rails now agree. Custom is quoted on its own volume.
// In credits, so it moves with the denomination: 3,000 conversations at CREDIT_SCALE = 2.
export const BACKFILL_CREDITS = {
  api: 3_000 * CREDIT_SCALE,
  custom: null,
};

/** The backfill allowance for a plan, in credits, or null when there is no limit. */
export function backfillAllowanceForPlan(planId) {
  const id = normalizePlanId(planId);
  return Object.hasOwn(BACKFILL_CREDITS, id) ? BACKFILL_CREDITS[id] : BACKFILL_CREDITS.api;
}

/**
 * The ceiling for a plan, or null when the plan is ungated.
 *
 * An unknown plan id normalizes to `free` and lands on the strictest ceiling we have,
 * which is the right way round: a plan we cannot identify is not a plan we should spend
 * someone's money on.
 */
export function ceilingUsdForPlan(planId) {
  const id = normalizePlanId(planId);
  // `null` is a value here, not an absence: it means no limit. `??` would quietly give
  // Custom a $25 ceiling, the opposite of what it says.
  return Object.hasOwn(BACKFILL_CEILING_USD, id) ? BACKFILL_CEILING_USD[id] : BACKFILL_CEILING_USD.api;
}

/**
 * Price a known set of conversations, in credits and in dollars. `counts` is keyed by the
 * types in CREDITS_PER_UNIT; anything else is ignored rather than guessed at, because a
 * type we cannot price is a type we should not be charging for.
 */
export function estimateBackfill(counts = {}) {
  let credits = 0;
  let usd = 0;
  const byType = {};
  for (const [type, perUnit] of Object.entries(CREDITS_PER_UNIT)) {
    const n = Number(counts[type] ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const c = n * perUnit;
    const d = n * (UNIT_COST_USD[type] ?? 0);
    byType[type] = { conversations: n, credits: c, usd: round(d) };
    credits += c;
    usd += d;
  }
  return { credits, usd: round(usd), byType };
}

/**
 * Project credits from CRM record volume, for a workspace whose activities have not been
 * pulled yet — which is every workspace at first onboarding, since the records sync first
 * and the conversations arrive with the backfill itself.
 */
export function projectCreditsFromRecords(recordCount, { windowDays = 30 } = {}) {
  const n = Number(recordCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * CREDITS_PER_RECORD_30D * (windowDays / 30));
}

/**
 * The gate. Returns what the backfill would consume, what the plan allows, and whether to
 * run it.
 *
 * Pass `counts` when the activities are already in the graph — that is an exact answer.
 * Pass `recordCount` when they are not, and the answer is a projection, flagged as such so
 * the caller can say so rather than quoting a number it cannot stand behind.
 */
export function checkBackfillBudget({ planId, counts = null, recordCount = 0, windowDays = 30, used = 0 } = {}) {
  const ceilingUsd = ceilingUsdForPlan(planId);

  let credits;
  let estimateUsd;
  let byType = {};
  let basis;
  if (counts && Object.values(counts).some(n => Number(n) > 0)) {
    const e = estimateBackfill(counts);
    credits = e.credits;
    estimateUsd = e.usd;
    byType = e.byType;
    basis = 'counted';
  } else {
    credits = projectCreditsFromRecords(recordCount, { windowDays });
    // Priced at the blended rate, which is what a mixed month costs per credit.
    estimateUsd = round(credits * 0.0084);
    basis = 'projected';
  }

  // ONE POOL PER WORKSPACE (GET-571). The allowance is what is LEFT of the plan's backfill credits
  // after earlier backfills — the founder's, then each member's — not a fresh allowance per job.
  const pool = backfillAllowanceForPlan(planId);
  const allowance = pool === null ? null : Math.max(0, pool - (Number(used) || 0));
  const base = { credits, estimateUsd, ceilingUsd, allowance, pool, poolUsed: Number(used) || 0, byType, basis, windowDays, planId: normalizePlanId(planId) };

  // No limit still gets an estimate — the preview screen shows it either way, and a Custom
  // onboarding wants the number even though nothing stops it.
  if (allowance === null) return { ...base, ok: true, needsSupport: false };

  // The gate is the plan's backfill CREDITS now (GET-515), the unit the customer sees on the
  // page; the dollar figure stays as our own estimate beside it.
  const needsSupport = credits > allowance;
  return { ...base, ok: !needsSupport, needsSupport, ...(needsSupport && { reason: 'over_allowance' }) };
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
