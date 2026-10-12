// What the workspace's LISTS show, and what they leave in the database.
//
// A CRM that has been running for years is mostly history. One customer's holds six: thousands of deals,
// more than half of them losses older than a year, and thousands of accounts that have never had a
// deal at all. Nobody works a deal lost three years ago, and nobody opens the account page to read one — but every
// board, every count and every page of the accounts list pays for them.
//
// The window:
//
//   open    always       work in progress, however stale its close date. More than half of one
//                        customer's open deals are already past their close date; hiding them would hide
//                        exactly the rot the board exists to show.
//   won     always       a customer is a customer whenever they bought. Only about one in six
//                        customer accounts won a deal in the last year; the rest bought earlier and most
//                        still pay. A recency rule here would delete the customer base from the
//                        workspace. Churn is a different question and needs subscription state,
//                        which we do not sync yet.
//   lost    12 months    older than that it is history, not pipeline.
//
// A lost deal with no close date is out. We cannot date it, and an undated loss is far more often
// old than recent. That customer has none — every lost deal carries a close date — so this costs
// nothing there and fails safe elsewhere.
//
// THIS IS A READ FILTER AND NOTHING ELSE. Every row stays in Supabase. The sync keeps writing all
// six years. It is opt-in per caller, so the readers that must see everything provably still do:
// the ICP model's training cohort (runClosedDeals), the funnel and win rate (dealFunnel,
// buildOutcomeLedger), the revenue report, the stage medians (pipeline_stage_stats) and the /v2
// Context API the agent reads. Only the web workspace's lists narrow.

export const DEAL_WINDOW_MONTHS = 12;

// How recently an account must have ANSWERED to earn its place without a deal.
//
// The deal rules below describe a CRM's record of what was sold. They miss what is being sold
// right now: a rep works a dealership for weeks before anyone opens a deal for it, and until they
// do, that account holds no deal in any state. Measured on a customer workspace the day this shipped, the
// deal rules alone hid thousands of accounts — and hundreds of those had been touched in the
// previous SEVEN DAYS, nearly all of them carrying real two-way contact (meetings held, calls made
// and received, and inbound emails, over a thousand in one week). Those are not enrichment exhaust. They are the top of the
// funnel, and losing them is how a rep learns not to trust the list.
//
// 45 days rather than 12 months on purpose: the point is to show live work, not to re-admit the
// history the deal window just removed.
//
// INBOUND, NOT ANY TOUCH (2026-09-21). The rule first shipped reading `last_activity_at`, which
// counts our own outbound, so it admitted every account a sequence had emailed. Of the
// never-dealt accounts it was keeping on a customer workspace, under a fifth had two-way contact,
// most were outbound only, and a few had no interaction inside the window at all. Four in five were
// on the list because we contacted THEM, which is a lead list wearing an account list's clothes. The window reads
// `last_inbound_at` now — a reply, an inbound call, or a meeting booked or held.
//
// An account whose only deal was lost longer ago than the deal window still earns its place on a
// plain touch, because working a dead account IS the re-engagement; see accountWindowFilter.
export const ACTIVITY_WINDOW_DAYS = 45;

/** The oldest activity an account may carry and still appear on a list without a deal. */
export function activityCutoff(now = new Date()) {
  return new Date(now.getTime() - ACTIVITY_WINDOW_DAYS * 86_400_000);
}

/** The oldest close date a LOST deal may carry and still appear on a list. */
export function lostCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - DEAL_WINDOW_MONTHS);
  return cutoff;
}

/** The same instant as PostgREST wants it, for a `close_date.gte.` filter. */
export function lostCutoffISO(now = new Date()) {
  return lostCutoff(now).toISOString();
}

/**
 * The window as one PostgREST `or` group.
 *
 * Spelled out rather than `status.neq.lost`, because `status <> 'lost'` is NULL — not true — for a
 * row whose status we never learned, and an unknown deal should be shown, not swallowed.
 *
 * Safe to combine with another `.or()` on the same query: PostgREST ANDs repeated `or` params
 * (verified against the live table — the country filter already uses one).
 */
export function dealWindowFilter(now = new Date()) {
  return `status.is.null,status.eq.open,status.eq.won,and(status.eq.lost,close_date.gte.${lostCutoffISO(now)})`;
}

/**
 * The same window, asked of an ACCOUNT rather than a deal: show it when it holds a deal the
 * lists would show.
 *
 * `child_deals` is the dealer-group exception. A group holds no deals of its own — Brackwater
 * Autogroup has five rooftops and nothing on the parent — and about a third of one customer's group
 * parents are in that shape. Without it the rule would hide the one record a rep needs in order to see
 * the group at all.
 *
 * An account with no deal in any state falls out UNLESS it has ANSWERED inside
 * ACTIVITY_WINDOW_DAYS — see that constant for why inbound and not any touch. Dropping the
 * never-worked remainder is right for a CRM with six years of enrichment exhaust behind it (about two
 * thirds of one customer's accounts have never had a deal) and WRONG for a young workspace whose
 * target list is exactly those rows, so it is opt-in per caller and belongs behind a workspace
 * setting before a second customer meets it.
 *
 * An account whose only deal was lost OUTSIDE the deal window is a separate case, and a plain
 * touch is enough for it. A deal lost three years ago that somebody called last week is a revival
 * attempt — the account has a history to re-open, which is exactly what a never-dealt account lacks
 * — so requiring them to answer first would hide the work while it is being done. Several hundred of
 * one customer's accounts are in that shape.
 *
 * `inbound` is false until the column exists (see hasInboundColumn in listRows.mjs), and false
 * reproduces the pre-2026-09-21 rule exactly, so an unmigrated database keeps today's lists.
 */
export function accountWindowFilter(now = new Date(), { inbound = false } = {}) {
  const touched = activityCutoff(now).toISOString();
  const base = `open_deals.gt.0,won_deals.gt.0,child_deals.gt.0,last_lost_at.gte.${lostCutoffISO(now)}`;
  if (!inbound) return `${base},last_activity_at.gte.${touched}`;
  return `${base},and(last_lost_at.not.is.null,last_activity_at.gte.${touched}),last_inbound_at.gte.${touched}`;
}

/** The same rule in memory, for the path that assembles deals from claims rather than rows. */
export function inDealWindow(deal, cutoff = lostCutoff()) {
  if (!deal) return false;
  if (deal.status !== 'lost') return true;
  if (!deal.close_date) return false;
  const closed = new Date(deal.close_date);
  return Number.isFinite(closed.getTime()) && closed >= cutoff;
}
