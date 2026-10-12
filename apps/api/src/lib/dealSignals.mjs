// Why this open deal is probably dead (GET-352).
//
// ── The rule that makes this safe ──────────────────────────────────────────
//
// We never write a deal's status. Status belongs to the CRM. The moment our revenue and win/loss
// numbers disagree with the customer's own HubSpot, they stop trusting the product — and they do
// check. What we produce here is EVIDENCE, phrased so a rep can act on it and then close the deal
// in HubSpot themselves. A rule proposes; the CRM or the human disposes.
//
// ── Why these signals, in this order ───────────────────────────────────────
//
// Measured on one customer's 400 open deals, worth $2M:
//
//   close date already passed   220   ← 55% of the pipeline
//   never any activity          100
//   quiet more than 45 days      50   ($200,000)
//   quiet more than 90 days      25
//
// A passed close date outranks silence and it is not close. The rep themselves said this would
// close by a date and the date went by: there is no threshold we invented, nothing to argue
// with, and it covers four times more pipeline than the 45-day rule everyone reaches for first.
// Silence is the softer signal, and "never worked at all" is its own thing — 100 deals sitting
// in a forecast that nobody has ever touched.
//
// Single-threading is included because it is the one behavioural finding that holds across a
// client's whole history (it comes from person↔company edges, not from captured activity):
// most of one customer's won deals had three or more contacts against about half of lost. It is a
// weaker reason than the others and ranks last, but it is the one a rep can still fix.

/** Whole days between two instants, floored. */
const daysBetween = (a, b) => Math.floor((a - b) / 86_400_000);

/** "3 days" / "2 months" / "over a year" — a duration a person would say out loud. */
export function humanDays(days) {
  const d = Math.max(0, Math.round(days));
  if (d === 0) return 'today';
  if (d === 1) return '1 day';
  if (d < 45) return `${d} days`;
  const months = Math.round(d / 30);
  if (months < 12) return `${months} months`;
  const years = Math.floor(d / 365);
  return years <= 1 ? 'over a year' : `over ${years} years`;
}

const shortDate = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Signals that an open deal has stopped being real, strongest first.
 *
 * Returns `[]` for anything that is not an open deal — a won or lost deal has already been
 * decided, and re-litigating it is exactly the overreach this module exists to avoid.
 *
 * Pure: takes a row and a clock, touches nothing.
 *
 * @param deal  { status, close_date, last_activity_at, pipeline_value, contact_count }
 * @param opts  { now, quietDays }
 */
export function dealSignals(deal, { now = Date.now(), quietDays = 45 } = {}) {
  if (!deal || String(deal.status ?? '').toLowerCase() !== 'open') return [];
  const out = [];

  const last = deal.last_activity_at ? Date.parse(deal.last_activity_at) : NaN;
  const recentlyWorked = Number.isFinite(last) && daysBetween(now, last) < quietDays;

  const close = deal.close_date ? Date.parse(deal.close_date) : NaN;
  if (Number.isFinite(close) && close < now) {
    const late = daysBetween(now, close);
    // A passed close date means two completely different things depending on whether anyone is
    // still working the deal, and saying the wrong one destroys trust in the signal.
    //
    // Found in a customer workspace's live pipeline: "Corvane Group" at Larkfield Toyota is 1,500 days
    // past its close date and was worked two days ago. That deal is not dead — its DATE is. Told
    // it looks dead, a rep learns the flag is noise; told the date needs moving, they fix it in
    // ten seconds and the forecast stops lying.
    out.push(recentlyWorked
      ? {
        kind: 'close_date_stale',
        rank: 2,
        text: `Close date ${humanDays(late)} out of date`,
        detail: `The date says ${shortDate(close)} but the deal is still being worked — it needs moving, not closing.`,
        days: late,
        at: new Date(close).toISOString(),
      }
      : {
        kind: 'close_date_passed',
        rank: 1,
        text: `Close date passed ${humanDays(late)} ago`,
        detail: `The date on the deal is ${shortDate(close)}, it is still open, and nobody has worked it since.`,
        days: late,
        at: new Date(close).toISOString(),
      });
  }

  if (!Number.isFinite(last)) {
    out.push({
      kind: 'never_worked',
      rank: 2,
      text: 'No activity ever recorded',
      detail: 'No call, email or meeting has ever been filed against this deal.',
      days: null,
      at: null,
    });
  } else {
    const quiet = daysBetween(now, last);
    if (quiet >= quietDays) {
      out.push({
        kind: 'quiet',
        rank: 3,
        text: `No activity in ${humanDays(quiet)}`,
        detail: `The last thing that happened was on ${shortDate(last)}.`,
        days: quiet,
        at: new Date(last).toISOString(),
      });
    }
  }

  // Only worth saying when something else is already wrong. On its own, a single-threaded deal
  // that someone spoke to yesterday is a live deal, and flagging it would be noise.
  const contacts = Number(deal.contact_count);
  if (out.length && Number.isFinite(contacts) && contacts < 3) {
    out.push({
      kind: 'single_threaded',
      rank: 4,
      text: contacts === 0 ? 'No contacts on the deal' : `Only ${contacts} contact${contacts === 1 ? '' : 's'}`,
      detail: 'Deals with three or more contacts win far more often here.',
      days: null,
      at: null,
    });
  }

  return out.sort((a, b) => a.rank - b.rank);
}

/**
 * The one line a pipeline row shows, or null when the deal looks alive.
 * The strongest signal wins; the rest are available on the deal itself.
 */
export function dealVerdict(deal, opts) {
  const signals = dealSignals(deal, opts);
  if (!signals.length) return null;
  return { headline: signals[0], signals, count: signals.length };
}

/**
 * What the forecast should say about stale pipeline, so a total is honest without us editing
 * anyone's CRM: "of $2M open, $X has a close date in the past".
 */
export function stalePipeline(deals, opts) {
  let openValue = 0, staleValue = 0, staleCount = 0, pastDueValue = 0, pastDueCount = 0;
  for (const d of deals ?? []) {
    if (String(d.status ?? '').toLowerCase() !== 'open') continue;
    // listDealRows maps the amount to `value`; raw entity_list_rows rows still say pipeline_value.
    const value = Number(d.value ?? d.pipeline_value) || 0;
    openValue += value;
    const signals = dealSignals(d, opts);
    if (!signals.length) continue;
    staleCount += 1;
    staleValue += value;
    // Past due means the deal went by its date with nobody working it. A date that is merely
    // out of date on a live deal is a hygiene problem, not rotten pipeline, and is not counted here.
    if (signals.some(s => s.kind === 'close_date_passed')) {
      pastDueCount += 1;
      pastDueValue += value;
    }
  }
  return { openValue, staleValue, staleCount, pastDueValue, pastDueCount };
}
