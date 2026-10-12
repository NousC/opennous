// Closed-deal import — normalising what the caller gave us.
//
// This is the one path a workspace WITHOUT a CRM has for getting real closed deals into
// Nous, so it is also the only way such a workspace ever gets an amount or a win date. It
// used to accept a bare domain and throw everything else away, stamping every imported deal
// with `now()` — so a year of history landed on today, every win read as closing this
// morning, and no money entered the system at all.
//
// Kept in its own module (rather than inline in the route) because it is pure: it can be
// tested against fixtures without a database, which is the only kind of proof available
// while the API cannot be run locally.

/** Strip scheme, path, and www. Lowercased. */
export const cleanDomain = (d) => String(d || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/^www\./i, '')
  .toLowerCase();

/**
 * When a deal actually closed. Past only.
 *
 * Returns null for anything missing or unparseable, and the caller falls back to now — the
 * import is still valid, we just cannot date it. A FUTURE date is clamped rather than
 * accepted: the funnel reconstruction reads these dates to work out how long deals take,
 * and a win dated next month produces a negative cycle time.
 */
export function normalizeClosedAt(v, nowMs = Date.now()) {
  if (!v) return null;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(t, nowMs)).toISOString();
}

/**
 * Normalise a caller's `won` / `lost` list into deal records.
 *
 * Accepts either a bare domain string — the original shape, still what the web form sends —
 * or an object carrying the deal's money and close date. Widened rather than replaced, so
 * every existing caller keeps working untouched.
 *
 * Capped at `limit` per list: 40 by default, which every automatic caller keeps. Training reads each
 * company's WEBSITE with the model, so a larger run (a client's last 12 months) is an explicit,
 * cost-approved call that passes its own limit (GET-270).
 */
export function normalizeClosedDeals(list, nowMs = Date.now(), { limit = 40 } = {}) {
  return (Array.isArray(list) ? list : [])
    .map((x) => {
      const src = typeof x === 'string' ? { domain: x } : (x || {});
      const domain = cleanDomain(src.domain ?? src.company ?? null);
      if (!domain) return null;
      // Several spellings because this is fed by an LLM as often as by a form.
      const amt = Number(src.amount ?? src.value ?? src.deal_value);
      return {
        domain,
        // A zero or negative amount is not a deal value, it is a missing one. Recording it
        // as 0 would drag any average deal size down with a number nobody entered.
        amount: Number.isFinite(amt) && amt > 0 ? amt : null,
        currency: src.currency ? String(src.currency) : null,
        closedAt: normalizeClosedAt(src.closed_at ?? src.closedAt ?? src.close_date ?? null, nowMs),
      };
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(5000, limit)));
}
