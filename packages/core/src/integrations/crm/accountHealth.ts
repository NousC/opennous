import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What the CRM already knows about a CUSTOMER, as opposed to a prospect.
//
// CLAUDE.md has carried "custom-property → claim mapping (deferred until we see a real portal's
// properties)" since the HubSpot work began. This is that mapping.
//
// WHY THIS EXISTS AT ALL
//
// The Customer Success surface used to derive everything itself: a customer was "an account with
// a won deal", at-risk was "nobody emailed them in 90 days", expansion was "they have an open
// deal". Every one of those is wrong in a way a CS rep would catch in the first minute:
//
//   · Every account with a won deal counted as a customer. A portal's own status field can say
//     many of them CANCELLED long ago, so churned accounts were being called customers.
//   · "Gone quiet" meant nobody had emailed them. A portal can hold actual product usage, and a
//     Client with ZERO active users in 30 days while still paying is the real risk; an email last
//     Tuesday hides it completely.
//   · "Expansion" meant an open deal. A portal can hold a priced, named upgrade per account that
//     nobody has discussed with the customer.
//
// None of that needed inventing. It needed reading. So Nous does not compute customer health; it
// reports the health the customer's own team maintains, and adds the one thing the CRM cannot —
// what was actually said, and when anyone last spoke to them.
//
// WHY A MAP AND NOT TWENTY NAMED FIELDS
//
// These are custom properties. `account_status` is not a HubSpot concept, it is a picklist a
// portal's ops team builds. The next customer will have the same IDEAS under different names, and
// possibly in a different CRM. So the vocabulary below is ours and provider-neutral, the map from
// provider property to that vocabulary is data, and a portal that has none of these properties
// yields no facts and no errors — HubSpot returns null for a property you ask for and it does not
// have (verified live, same as the deal `lost_reason` read).
//
// Nothing here is written back. Every one of these is the customer's field, in the customer's
// system, and Nous holding a health fact the CRM does not is exactly the line CLAUDE.md draws.

/** The canonical, provider-neutral account-health vocabulary. Claims land under these names. */
export const ACCOUNT_HEALTH_FACTS = [
  'cs.status',             // client | cancelled | prospect | other — is this still a customer?
  'cs.owner_external_id',  // the CS owner, as the provider's owner id
  'cs.owner_name',         // ...resolved through the provider's owner directory at sync time
  'cs.owner_email',
  'cs.tier',               // the customer's own account tier
  'cs.mrr',                // recurring revenue, the customer's number
  'cs.products',           // what they have today (string[])
  'cs.health_score',       // the customer's own health score
  'cs.risk_tier',          // their churn model's tier
  'cs.risk_status',        // ...and whether it is open
  'cs.risk_signals',       // ...and which signals fired (string[])
  'cs.active_users_30d',   // people who actually logged in
  'cs.total_users',        // people who could
  'cs.usage_30d',          // units of the thing they bought, last 30 days
  'cs.units_90d',          // ...and the 90-day figure
  'cs.units_prev_90d',     // ...and the quarter before, so a fall is visible
  'cs.last_used_at',       // when the product last did something for them
  'cs.upgrade_products',   // what they could buy next (string[])
  'cs.upgrade_stage',      // how far that conversation has got
  'cs.upgrade_target',     // which package
  'cs.upgrade_value',      // and what it is worth per month
  'cs.cancelled_at',       // the date, if one is set
  'cs.cancel_reason',
  'cs.goals',              // what they told us they want (string[])
  'cs.challenges',         // ...and what is in the way (string[])
  'cs.group',              // the dealer group / parent org, by name
  'cs.locations',
  // Not a company property: derived from the subscriptions the customer is billed on, after the
  // subscription pass (see renewalFromSubscriptions below). '' means "cleared".
  'cs.renewal_date',       // the end of the committed term that comes up next (YYYY-MM-DD)
  'cs.term_months',        // how long that term is; 1 = month to month, so no renewal date
] as const;

export type AccountHealthFact = typeof ACCOUNT_HEALTH_FACTS[number];

type Shape = 'string' | 'number' | 'date' | 'list' | 'status';

export interface Mapping {
  /** Provider property names, best first. The first one with a value wins. */
  from: string[];
  as: Shape;
}

// HubSpot. Custom properties are named by each portal's own ops team, so the names below are
// generic defaults: a portal without them returns null for each and contributes nothing, which
// is the intended behaviour and not a failure. A deployment maps its own portal's names with
// registerAccountHealthMap. Nous Cloud's hosted portals keep their map in the Workspace layer
// (src/cloud/accountHealthMap.ts, GET-761), loaded below when that folder exists.
//
// The CS owner is usually an OWNER-referenced picklist, so it resolves through the same owner
// directory as `hubspot_owner_id`: a SECOND ownership edge, next to the AE, and the two disagree
// on purpose. `cs.owner_name` / `cs.owner_email` are absent here on purpose: they are not
// properties on the record, they are the owner directory's answer for `cs.owner_external_id`,
// filled in by `resolveOwner` during the sync run the same way `owner_name` is for the AE.
export const DEFAULT_HUBSPOT_HEALTH_MAP: Partial<Record<AccountHealthFact, Mapping>> = {
  'cs.status':            { from: ['account_status', 'subscription_status'], as: 'status' },
  'cs.owner_external_id': { from: ['customer_success_owner'], as: 'string' },
  'cs.tier':              { from: ['customer_tier'], as: 'string' },
  'cs.mrr':               { from: ['mrr', 'hs_active_contracts_mrr'], as: 'number' },
  'cs.products':          { from: ['active_products'], as: 'list' },
  'cs.health_score':      { from: ['health_score'], as: 'number' },
  'cs.active_users_30d':  { from: ['active_users_30d'], as: 'number' },
  'cs.total_users':       { from: ['total_users'], as: 'number' },
  'cs.usage_30d':         { from: ['usage_30d'], as: 'number' },
  'cs.last_used_at':      { from: ['last_active_date'], as: 'date' },
  'cs.upgrade_products':  { from: ['upgrade_products'], as: 'list' },
  'cs.upgrade_stage':     { from: ['upgrade_stage'], as: 'string' },
  'cs.upgrade_target':    { from: ['upgrade_target'], as: 'string' },
  'cs.upgrade_value':     { from: ['upgrade_value'], as: 'number' },
  'cs.cancelled_at':      { from: ['cancellation_date'], as: 'date' },
  'cs.cancel_reason':     { from: ['cancellation_reason'], as: 'string' },
  'cs.goals':             { from: ['customer_goals'], as: 'list' },
  'cs.challenges':        { from: ['customer_challenges'], as: 'list' },
  'cs.group':             { from: ['parent_group'], as: 'string' },
  'cs.locations':         { from: ['number_of_locations'], as: 'number' },
};

export type AccountHealthMap = Partial<Record<AccountHealthFact, Mapping>>;

const MAPS: Record<string, AccountHealthMap> = { hubspot: DEFAULT_HUBSPOT_HEALTH_MAP };

// The hosted portals' map (Cloud). Loaded at import, before index.ts builds its HubSpot property
// list from it, so every process and script that imports core reads the same map. The path is a
// URL, not a string literal, and the folder is checked first: the open-source build has none.
const CLOUD_HEALTH_MAP = new URL('../../cloud/accountHealthMap.js', import.meta.url);
if (existsSync(fileURLToPath(CLOUD_HEALTH_MAP))) {
  const mod = await import(CLOUD_HEALTH_MAP.href) as { HOSTED_HUBSPOT_HEALTH_MAP?: AccountHealthMap };
  if (mod.HOSTED_HUBSPOT_HEALTH_MAP) MAPS.hubspot = mod.HOSTED_HUBSPOT_HEALTH_MAP;
}

/**
 * Map a provider's own property names onto the health vocabulary (replaces that provider's map).
 * Call it before the first CRM sync: the HubSpot company read lists its properties from this map.
 */
export function registerAccountHealthMap(provider: string, map: AccountHealthMap): void {
  MAPS[provider] = map;
}

/** The map in force for a provider (null when there is none). */
export function accountHealthMapFor(provider: string): AccountHealthMap | null {
  return MAPS[provider] ?? null;
}

/**
 * Every provider property the health read needs, deduped.
 *
 * Added to the company read wholesale rather than intersected with the portal's schema first: an
 * unknown property costs one null in the response, and a schema probe costs a round trip on every
 * sync plus a cache to keep it honest when ops adds a field.
 */
export function accountHealthProperties(provider: string): string[] {
  const map = MAPS[provider];
  if (!map) return [];
  return [...new Set(Object.values(map).flatMap(m => (m as Mapping).from))];
}

/** `Client` / `client` / `Cancelled` → the small vocabulary the app reasons over. */
/**
 * For each provider property that carries account status, the values on this portal that mean a
 * customer or a churned customer (`client` / `cancelled`). Read off the portal's own picklist so a
 * portal spelling it "Customer" or "Churned" is matched as well as one customer's "Client"/"Cancelled".
 * Used to scope the company sync to the accounts that matter (crm_sync_configs.company_scope).
 */
export function customerStatusValues(
  provider: string,
  schema: Array<{ name: string; options?: string[] }>,
): Array<{ property: string; values: string[] }> {
  if (provider !== 'hubspot') return [];
  const sources = MAPS.hubspot?.['cs.status']?.from ?? [];
  const out: Array<{ property: string; values: string[] }> = [];
  for (const property of sources) {
    const def = schema.find(p => p.name === property);
    const values = (def?.options ?? []).filter(v => {
      const s = normaliseStatus(String(v));
      return s === 'client' || s === 'cancelled';
    });
    if (values.length) out.push({ property, values });
  }
  return out;
}

function normaliseStatus(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'client' || v === 'customer' || v === 'active') return 'client';
  if (v === 'cancelled' || v === 'canceled' || v === 'churned') return 'cancelled';
  if (v === 'prospect') return 'prospect';
  return 'other';
}

function coerce(shape: Shape, values: string[]): unknown {
  const present = values.map(v => String(v ?? '').trim()).filter(Boolean);
  if (!present.length) return null;
  if (shape === 'list') {
    // HubSpot joins a checkbox property's values with a semicolon, and the multi-field facts
    // (goal 1/2/3) arrive as separate properties. Both collapse to one deduped array.
    const out = [...new Set(present.flatMap(v => v.split(';')).map(s => s.trim()).filter(Boolean))];
    return out.length ? out : null;
  }
  const first = present[0];
  if (shape === 'number') { const n = Number(first); return Number.isFinite(n) ? n : null; }
  if (shape === 'date') { const t = Date.parse(first); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
  if (shape === 'status') return normaliseStatus(first);
  return first;
}

// A fact that means "this row is about a customer". Without at least one of these the row is a
// prospect and every health field on it is null anyway — so the whole bag is dropped rather than
// writing a handful of stray observations against every company in the portal on every sync.
const CUSTOMER_EVIDENCE: AccountHealthFact[] = [
  'cs.mrr', 'cs.products', 'cs.upgrade_value', 'cs.active_users_30d', 'cs.last_used_at',
];

// A STATUS IS ONLY EVIDENCE WHEN IT SAYS CUSTOMER.
//
// `cs.status` used to sit in the list above, which looked harmless and was not: a portal can fill
// `account_status` on prospects too, so every lead in the book earned a health bag holding one
// useless word. Most accounts carrying a bag were then prospects, and the Customer Success page
// read all of them, with their jsonb, to use a small fraction of them.
//
// `client` and `cancelled` are customers, present or former, and both belong on this page — the
// churned count is the answer to "how many did we lose". `prospect` and `other` are not, and a
// row whose ONLY health fact is one of those words is dropped entirely.
const CUSTOMER_STATUSES = new Set(['client', 'cancelled']);

/**
 * Read one provider record's raw properties into canonical health facts.
 *
 * Returns `{}` for a record that shows no sign of being a customer, so a prospect costs nothing.
 */
export function readAccountHealth(provider: string, props: Record<string, unknown>): Record<string, unknown> {
  const map = MAPS[provider];
  if (!map || !props) return {};
  const out: Record<string, unknown> = {};
  for (const [fact, m] of Object.entries(map) as [AccountHealthFact, Mapping][]) {
    const raw = m.from.map(k => props[k]).filter(v => v != null && v !== '').map(String);
    const value = coerce(m.as, raw);
    if (value != null) out[fact] = value;
  }
  const status = typeof out['cs.status'] === 'string' ? out['cs.status'] as string : null;
  const isCustomer = (status != null && CUSTOMER_STATUSES.has(status))
    || CUSTOMER_EVIDENCE.some(f => out[f] != null);
  if (!isCustomer) return {};
  return out;
}

/** The health bag as the `[property, value]` pairs `writeStateFacts` takes. */
export function accountHealthFacts(health: Record<string, unknown> | null | undefined): Array<[string, unknown]> {
  if (!health) return [];
  return Object.entries(health).filter(([, v]) => v != null);
}

// ── Renewal: the end of what the customer actually committed to ─────────────────────────────
//
// WHERE A RENEWAL DATE REALLY LIVES. Measured read-only on a customer's portal:
//
//   · company `renewal_date` (custom, "Renewal Date") is set on nearly every Client, and every value
//     is inside the last few days. Its history is AUTOMATION_PLATFORM writes every few days: a
//     workflow stamps the day it ran. It is not a renewal date, and reading it would put the whole
//     book on "Renewing soon". Not read.
//   · company `hs_next_renewal_date` (HubSpot contracts) is empty on every client record.
//   · SUBSCRIPTIONS hold the real thing. Most are month to month: a one-month term HubSpot
//     re-dates every cycle (most active ones started last month and end next month). The newer packages are 12-month terms, some in phases: a 3-month intro, then a
//     scheduled 9-month term that starts the day the first one ends.
//
// So a renewal is the end of a COMMITTED term, and only that. A month-to-month customer can leave
// any month; giving them a renewal date 30 days out would put every one of them on the renewals
// list and make it the book again. They get `termMonths: 1` instead, so the page can say "Monthly"
// rather than a dash that reads as missing data.

/** One subscription, in the provider-neutral shape the renewal read takes. */
export interface SubscriptionTerm {
  status?: string | null;          // HubSpot hs_status: active | scheduled | unpaid | paused | canceled | expired
  start?: string | null;           // hs_recurring_billing_start_date
  end?: string | null;             // hs_recurring_billing_end_date (absent on an evergreen subscription)
  frequency?: string | null;       // hs_recurring_billing_frequency
  nextPaymentDue?: string | null;  // hs_next_payment_due_date
}

export interface RenewalRead {
  /** YYYY-MM-DD, the nearest end of a committed term still ahead; null when there is none. */
  renewalDate: string | null;
  /** Months in that term (phases joined); 1 when the customer is only month to month; null when nothing is live. */
  termMonths: number | null;
  /** Whether any subscription is still running. Nothing is written for an account with none. */
  live: boolean;
}

/** The subscription properties the renewal read needs, for the batch read in the sync. */
export const SUBSCRIPTION_TERM_PROPERTIES = [
  'hs_status', 'hs_recurring_billing_start_date', 'hs_recurring_billing_end_date',
  'hs_recurring_billing_frequency', 'hs_next_payment_due_date',
];

// Still a contract. `paused` and `unpaid` are a billing problem, not an ending; `scheduled` is a
// phase that has not started yet and is what joins an intro term to the year after it.
const LIVE_SUBSCRIPTION = new Set(['active', 'scheduled', 'unpaid', 'past_due', 'paused']);
// Longer than one monthly cycle. A one-month term is HubSpot re-dating a monthly subscription, not
// a commitment; a quarter or more is one.
const COMMITTED_MIN_DAYS = 45;
// A phase that starts within this of the previous one's end continues it (the intro → year case).
const PHASE_GAP_DAYS = 3;
const PERIOD_MONTHS: Record<string, number> = {
  weekly: 0.25, biweekly: 0.5, monthly: 1, quarterly: 3, per_six_months: 6, annually: 12,
  per_two_years: 24, per_three_years: 36, per_four_years: 48, per_five_years: 60,
};
const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;

/** A civil date as UTC midnight ms. HubSpot sends date properties as YYYY-MM-DD (or epoch ms). */
function civilMs(v: unknown): number | null {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  if (/^\d{11,}$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isFinite(d.getTime()) ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? t : null;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * When does this customer next decide whether to stay? Pure.
 *
 * The nearest end, still ahead of `today`, of a committed term across the subscriptions that are
 * still live, with back-to-back phases joined so an intro term that rolls into a scheduled year
 * renews at the end of the year. An evergreen subscription billed less often than monthly renews on
 * its next payment, because each payment buys the next period.
 */
export function renewalFromSubscriptions(subs: SubscriptionTerm[], today: Date = new Date()): RenewalRead {
  const day0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const live = (subs ?? []).filter(s => LIVE_SUBSCRIPTION.has(String(s?.status ?? '').trim().toLowerCase()));
  if (!live.length) return { renewalDate: null, termMonths: null, live: false };

  const terms: Array<{ start: number; end: number }> = [];
  let shortest: number | null = null;
  for (const s of live) {
    const period = PERIOD_MONTHS[String(s.frequency ?? '').trim().toLowerCase()] ?? null;
    if (period != null) shortest = shortest == null ? period : Math.min(shortest, period);
    const start = civilMs(s.start), end = civilMs(s.end);
    if (start != null && end != null && end > start) {
      if ((end - start) / DAY_MS > COMMITTED_MIN_DAYS) terms.push({ start, end });
    } else if (end == null && period != null && period > 1) {
      const due = civilMs(s.nextPaymentDue);
      if (due != null) terms.push({ start: due - Math.round(period * MONTH_DAYS) * DAY_MS, end: due });
    }
  }

  // Join phases: sorted by start, a term that begins at (about) the end of a chain extends it.
  terms.sort((a, b) => a.start - b.start || a.end - b.end);
  const chains: Array<{ start: number; end: number }> = [];
  for (const t of terms) {
    const gap = PHASE_GAP_DAYS * DAY_MS;
    const chain = chains.find(c => t.start >= c.end - gap && t.start <= c.end + gap);
    if (chain) chain.end = Math.max(chain.end, t.end);
    else chains.push({ ...t });
  }

  // An end that has passed on a subscription still marked active is HubSpot not having re-dated it
  // yet, not a renewal: only an end still ahead counts.
  const ahead = chains.filter(c => c.end >= day0).sort((a, b) => a.end - b.end);
  if (ahead.length) {
    const next = ahead[0];
    return { renewalDate: isoDay(next.end), termMonths: Math.max(1, Math.round((next.end - next.start) / DAY_MS / MONTH_DAYS)), live: true };
  }
  return { renewalDate: null, termMonths: shortest != null && shortest <= 1 ? 1 : null, live: true };
}

/**
 * The renewal facts to write for one account, given what its claims say now. Pure.
 *
 * Only what CHANGED is written: the sync runs twice a day and the observation log is append-only,
 * so restating an unchanged date on every run is noise. A date that no longer holds (the contract
 * was cancelled early, the customer went month to month) is cleared with '' because the claim
 * engine ignores a null observation, and an account with nothing live and nothing written before
 * gets nothing at all, so a prospect never acquires a health bag from this.
 */
export function renewalChanges(
  read: RenewalRead,
  current: { renewal_date?: unknown; term_months?: unknown } = {},
): Array<[string, unknown]> {
  const unwrap = (v: unknown) => (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>) ? (v as Record<string, unknown>).value : v);
  const had = (v: unknown) => { const u = unwrap(v); return u == null ? '' : String(u); };
  const out: Array<[string, unknown]> = [];
  const nextDate = read.live ? (read.renewalDate ?? '') : '';
  const nextTerm: number | '' = read.live && read.termMonths != null ? read.termMonths : '';
  if (had(current.renewal_date) !== nextDate) out.push(['cs.renewal_date', nextDate]);
  if (had(current.term_months) !== String(nextTerm)) out.push(['cs.term_months', nextTerm]);
  return out;
}
