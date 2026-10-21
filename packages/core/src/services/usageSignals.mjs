// Product usage as account signals (GET-751). The PostHog usage pull (apps/worker/src/pollers/
// posthog.mjs) reads each account's and each person's usage once a day; this turns a day's read
// into account_signals rows, the same rows the next-step pass writes (nextStepSignals.mjs), so the
// signal pass sends them on as `signal.<kind>` events, automations and Priorities like any other.
//
//   usage_dropped     active users or events over the last 30 days at most half the 30 before,
//                     from a base worth reading (2+ users or 50+ events). Once a month per account.
//   account_inactive  nobody at the account used the product for 14+ days, after using it inside
//                     the window. Once per quiet spell: the key is the day it was last used.
//   feature_adopted   a key event used at the account for the first time in the window, in the
//                     last 8 days. Once per account and event.
//   seat_dropped      someone active in the 30 days before, not in the last 30. Once a month per
//                     person.
//
// And the buying side, for sales (Bennet, 2026-10-21):
//   product_qualified 3+ people used the product in the last 30 days, after fewer than 3 the 30
//                     before: a product-qualified account. Once per account.
//   seats_growing     active users up by 2+ and by half again against the 30 days before, from 1+.
//                     Once a month per account.
//   account_activated every key event (2 or more set) used at the account, the last of them for
//                     the first time in the last 8 days. Once per account.
//
// Pure. Each row names a claim the pull writes on the same entity (claim_property), which is what
// lets the signal pass decide the whole team may read it.

const DAY = 86_400_000;
export const INACTIVE_DAYS = 14;
export const ADOPTED_WITHIN_DAYS = 8;

const month = (now) => new Date(now).toISOString().slice(0, 7);
const dayOf = (iso) => String(iso).slice(0, 10);
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? null : t; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const longDay = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The signals in one account's usage. `c` is a rolled-up company (rollUpByDomain). */
export function accountUsageSignals(accountId, c, { now = Date.now() } = {}) {
  if (!accountId || !c) return [];
  const rows = [];
  const base = { entity_id: accountId, account_id: accountId, quote: null, speaker: null, source_ref: null };
  const at = new Date(now).toISOString();

  const usersHalved = c.activeUsersPrev30d >= 2 && c.activeUsers30d * 2 <= c.activeUsersPrev30d;
  const eventsHalved = c.usagePrev30d >= 50 && c.usage30d * 2 <= c.usagePrev30d;
  if (usersHalved || eventsHalved) {
    rows.push({
      ...base, kind: 'usage_dropped', claim_property: 'product.active_users_30d',
      title: 'Product usage dropped',
      content: usersHalved
        ? `${plural(c.activeUsers30d, 'person', 'people')} used the product in the last 30 days, down from ${c.activeUsersPrev30d} the 30 days before.`
        : `${c.usage30d} product events in the last 30 days, down from ${c.usagePrev30d} the 30 days before.`,
      detail: { active_users_30d: c.activeUsers30d, active_users_prev_30d: c.activeUsersPrev30d, usage_30d: c.usage30d, usage_prev_30d: c.usagePrev30d },
      occurred_at: at, dedupe_key: `usage_dropped:${accountId}:${month(now)}`,
    });
  }

  const last = ms(c.lastUsedAt);
  if (last != null && now - last >= INACTIVE_DAYS * DAY) {
    const days = Math.floor((now - last) / DAY);
    rows.push({
      ...base, kind: 'account_inactive', claim_property: 'product.last_used_at',
      title: 'Account stopped using the product',
      content: `Nobody at the account has used the product for ${days} days. Last used ${longDay(c.lastUsedAt)}.`,
      detail: { last_used_at: c.lastUsedAt, days_inactive: days, total_users: c.totalUsers },
      occurred_at: new Date(last + INACTIVE_DAYS * DAY).toISOString(), dedupe_key: `account_inactive:${accountId}:${dayOf(c.lastUsedAt)}`,
    });
  }

  if (c.activeUsers30d >= 3 && c.activeUsersPrev30d < 3) {
    rows.push({
      ...base, kind: 'product_qualified', claim_property: 'product.active_users_30d',
      title: 'Product-qualified account',
      content: `${plural(c.activeUsers30d, 'person', 'people')} at the account used the product in the last 30 days${c.activeUsersPrev30d ? `, up from ${c.activeUsersPrev30d}` : ''}.`,
      detail: { active_users_30d: c.activeUsers30d, active_users_prev_30d: c.activeUsersPrev30d, active_users_7d: c.activeUsers7d },
      occurred_at: at, dedupe_key: `product_qualified:${accountId}`,
    });
  }

  if (c.activeUsersPrev30d >= 1 && c.activeUsers30d - c.activeUsersPrev30d >= 2 && c.activeUsers30d * 2 >= c.activeUsersPrev30d * 3) {
    rows.push({
      ...base, kind: 'seats_growing', claim_property: 'product.active_users_30d',
      title: 'More people using the product',
      content: `${plural(c.activeUsers30d, 'person', 'people')} used the product in the last 30 days, up from ${c.activeUsersPrev30d} the 30 days before.`,
      detail: { active_users_30d: c.activeUsers30d, active_users_prev_30d: c.activeUsersPrev30d },
      occurred_at: at, dedupe_key: `seats_growing:${accountId}:${month(now)}`,
    });
  }

  const keys = Object.entries(c.keyEvents ?? {});
  const lastFirst = Math.max(...keys.map(([, s]) => ms(s?.firstSeen) ?? -Infinity));
  if (keys.length >= 2 && keys.every(([, s]) => ms(s?.firstSeen) != null) && now - lastFirst <= ADOPTED_WITHIN_DAYS * DAY) {
    rows.push({
      ...base, kind: 'account_activated', claim_property: 'product.key_events',
      title: 'Account activated',
      content: `The account has now used every key part of the product (${keys.map(([k]) => k).join(', ')}), the last for the first time on ${longDay(new Date(lastFirst).toISOString())}.`,
      detail: { events: keys.map(([k]) => k), completed_at: new Date(lastFirst).toISOString() },
      occurred_at: new Date(lastFirst).toISOString(), dedupe_key: `account_activated:${accountId}`,
    });
  }

  for (const [event, s] of Object.entries(c.keyEvents ?? {})) {
    const first = ms(s?.firstSeen);
    if (first == null || now - first > ADOPTED_WITHIN_DAYS * DAY || !(s.count30d > 0)) continue;
    rows.push({
      ...base, kind: 'feature_adopted', claim_property: 'product.key_events',
      title: `Started using ${event}`,
      content: `The account used ${event} for the first time on ${longDay(s.firstSeen)}: ${plural(s.count30d, 'time')} by ${plural(s.users30d, 'person', 'people')}.`,
      detail: { event, first_seen: s.firstSeen, count_30d: s.count30d, users_30d: s.users30d },
      occurred_at: new Date(first).toISOString(), dedupe_key: `feature_adopted:${accountId}:${event}`,
    });
  }
  return rows;
}

/** A person who stopped using the product, as a signal on their account. `u` is a usage row. */
export function seatDroppedSignal(personId, accountId, u, { now = Date.now() } = {}) {
  if (!personId || !accountId || !u || u.activeDays30d > 0 || !(u.eventsPrev30d > 0)) return null;
  return {
    entity_id: personId, account_id: accountId, kind: 'seat_dropped', claim_property: 'product.user',
    title: 'Someone stopped using the product',
    // The person is the signal's entity; their address stays out of the text, which travels in events.
    content: `They used the product in the 30 days before and not in the last 30.${u.lastSeen ? ` Last used ${longDay(u.lastSeen)}.` : ''}`,
    quote: null, speaker: null, source_ref: null,
    detail: { last_seen_at: u.lastSeen, events_prev_30d: u.eventsPrev30d },
    occurred_at: new Date(now).toISOString(), dedupe_key: `seat_dropped:${personId}:${month(now)}`,
  };
}
