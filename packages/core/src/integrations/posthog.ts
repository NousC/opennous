// PostHog — product usage as a source (GET-751).
//
// ONE client for the API's connect test and webhook setup, and the worker's inbound handler and
// daily usage pull, so the two sides can never disagree about where a project lives or how a
// usage row is read. Everything here is pure or talks only to PostHog; filing onto the graph
// lives in the worker (webhooks/handlers/posthog.mjs, pollers/posthog.mjs).
//
// What a connection is: a PERSONAL API key (phx_…), the project id and the host. The project
// token (phc_…) cannot be used: it only sends events, it cannot read or set anything up.
// The key needs project:read (the connect test), query:read (the daily pull) and
// hog_function:write (the webhook destination we create on connect).
//
// Two paths in:
//   live   an "HTTP Webhook" destination in their project (template-webhook) posts the events
//          they chose (the signup event + their key events) to /inbound/posthog/:workspace.
//   daily  one HogQL query per project: per user email, last seen, active days and events over
//          the last 30 days and the 30 before, plus a count per key event. Rolled up per company
//          domain into the provider-neutral usage facts (cs.active_users_30d, cs.last_used_at…)
//          that account health and the CS lists already read.
//
// Only counts, event names and times are kept. Event properties reach an automation run as
// variables, trimmed to short scalars, and are never sent anywhere else.

import { companyDomainFromEmail } from '../utils/identity.js';

export const POSTHOG_DEFAULT_SIGNUP_EVENT = 'signed_up';
export const POSTHOG_MAX_KEY_EVENTS = 10;

// The app hosts of PostHog Cloud. The ingest hosts (us.i.posthog.com) are where the browser SDK
// sends events; the REST API answers on the app host, so a pasted ingest host is mapped to it.
const CLOUD_HOSTS: Record<string, string> = {
  'us.posthog.com': 'https://us.posthog.com',
  'us.i.posthog.com': 'https://us.posthog.com',
  'app.posthog.com': 'https://us.posthog.com',
  'eu.posthog.com': 'https://eu.posthog.com',
  'eu.i.posthog.com': 'https://eu.posthog.com',
};

/**
 * The REST base for a pasted host, or null when it cannot be one. Empty means US Cloud.
 * `us`, `eu`, `https://eu.posthog.com/project/123` and `us.i.posthog.com` all resolve. A
 * self-hosted address must be https and a real public hostname: the value becomes a host we
 * send the customer's API key to, so it may never be an IP, localhost or an internal name.
 * (The API also runs the DNS check, assertPublicUrl, before the first request.)
 */
export function posthogApiBase(input: unknown): string | null {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s || s === 'us' || s === 'us cloud') return CLOUD_HOSTS['us.posthog.com'];
  if (s === 'eu' || s === 'eu cloud') return CLOUD_HOSTS['eu.posthog.com'];
  if (/^http:\/\//.test(s)) return null;
  s = s.replace(/^https:\/\//, '').replace(/[/?#].*$/, '');
  if (CLOUD_HOSTS[s]) return CLOUD_HOSTS[s];
  if (s.includes(':')) return null;                                   // no ports, no IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;                 // no IPv4 literals
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(s)) return null;
  return `https://${s}`;
}

/** A project id as PostHog numbers them. */
export function posthogProjectId(input: unknown): string | null {
  const s = String(input ?? '').trim();
  const m = s.match(/(?:^|\/project\/)(\d{1,12})(?:$|\/)/) ?? s.match(/^(\d{1,12})$/);
  return m ? m[1] : null;
}

/** An event name we can filter on and put in a query: what PostHog itself accepts, trimmed. */
function eventName(s: unknown): string | null {
  const v = String(s ?? '').trim();
  return v && v.length <= 200 && !/[\u0000-\u001f'\\]/.test(v) ? v : null;
}

/** "signed_up, report created ,  " → ['signed_up', 'report created'], de-duplicated, capped. */
export function posthogEventList(input: unknown, cap = POSTHOG_MAX_KEY_EVENTS): string[] {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(/[,\n]/);
  const out: string[] = [];
  for (const p of parts) {
    const n = eventName(p);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

export interface PostHogSettings {
  apiBase: string;
  projectId: string;
  signupEvent: string;
  keyEvents: string[];
}

/** A connection's settings from its form (or the stored plain copy), or the reason it has none. */
export function posthogSettings(creds: Record<string, unknown> | null | undefined): { ok: true; settings: PostHogSettings } | { ok: false; reason: string } {
  const apiBase = posthogApiBase(creds?.posthog_api_base ?? creds?.host);
  if (!apiBase) return { ok: false, reason: 'posthog_host_invalid' };
  const projectId = posthogProjectId(creds?.posthog_project_id ?? creds?.project_id);
  if (!projectId) return { ok: false, reason: 'posthog_project_id_missing' };
  const signupEvent = eventName(creds?.signup_event) ?? POSTHOG_DEFAULT_SIGNUP_EVENT;
  const keyEvents = posthogEventList(creds?.key_events).filter(e => e !== signupEvent);
  return { ok: true, settings: { apiBase, projectId, signupEvent, keyEvents } };
}

export class PostHogError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** One authenticated call. A non-2xx throws PostHogError with PostHog's own detail. */
export async function posthogRequest(
  apiKey: string, apiBase: string, path: string,
  { method = 'GET', body, fetchImpl = fetch as unknown as FetchLike, timeoutMs = 20_000 }: { method?: string; body?: unknown; fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<any> {
  const res = await fetchImpl(`${apiBase}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null) as any;
  if (!res.ok) throw new PostHogError(String(data?.detail ?? data?.message ?? `PostHog answered ${res.status}`).slice(0, 300), res.status);
  return data;
}

/**
 * The destination we create in their project: PostHog's own HTTP Webhook template, posting the
 * chosen events to our inbound URL with the connection's secret as a header. The body is the
 * template's default ({event} and {person}), which is everything the handler reads.
 */
export function posthogDestination(url: string, secret: string, events: string[]): Record<string, unknown> {
  return {
    type: 'destination',
    name: 'OpenNous',
    description: 'Sends your signups and key events to OpenNous, so new users land on your accounts and people.',
    template_id: 'template-webhook',
    enabled: true,
    inputs: {
      url: { value: url },
      method: { value: 'POST' },
      body: { value: { event: '{event}', person: '{person}' } },
      headers: { value: { 'Content-Type': 'application/json', 'X-Nous-Secret': secret } },
    },
    filters: { events: events.map((id, order) => ({ id, name: id, type: 'events', order })) },
  };
}

// ── Inbound: one webhook delivery ────────────────────────────────────────────────────────────

export interface PostHogInboundEvent {
  uuid: string;
  name: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  /** The company the product says they belong to, when it sets one on the person. */
  companyName: string | null;
  companyDomain: string | null;
  occurredAt: string;
  properties: Record<string, string | number | boolean>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** `https://www.acme.example/about` → `acme.example`; null for anything that is not a hostname. */
export const hostOf = (v: string | null | undefined): string | null => {
  const h = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#:].*$/, '');
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) ? h : null;
};

/**
 * The properties an automation may use as {{event.properties}}: the customer's own, not
 * PostHog's ($-prefixed), scalars only, short. Never the person's profile.
 */
export function slimProperties(props: unknown, { maxKeys = 20, maxChars = 200 } = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props || typeof props !== 'object') return out;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxKeys) break;
    if (k.startsWith('$') || k.length > 60) continue;
    if (typeof v === 'string') out[k] = v.slice(0, maxChars);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** A delivery's body as the event we file, or null when it is not one we can use. */
export function parsePostHogDelivery(body: unknown): PostHogInboundEvent | null {
  const b = (body ?? {}) as any;
  const ev = b.event && typeof b.event === 'object' ? b.event : null;
  if (!ev) return null;
  const name = eventName(ev.event);
  const uuid = str(ev.uuid);
  if (!name || !uuid) return null;
  const person = (b.person && typeof b.person === 'object' ? b.person.properties : null) ?? {};
  const props = ev.properties ?? {};
  const set = props.$set ?? {};
  const rawEmail = str(person.email) ?? str(set.email) ?? str(props.email);
  const email = rawEmail && EMAIL.test(rawEmail) ? rawEmail.toLowerCase() : null;
  const firstName = str(person.first_name) ?? str(person.firstName) ?? str(set.first_name);
  const lastName = str(person.last_name) ?? str(person.lastName) ?? str(set.last_name);
  const fullName = str(person.name) ?? str(b.person?.name) ?? str(set.name);
  const companyName = str(person.company) ?? str(person.company_name) ?? str(person.organization) ?? str(set.company) ?? str(set.company_name) ?? str(set.organization);
  const companyDomain = hostOf(str(person.company_domain) ?? str(person.website) ?? str(set.company_domain) ?? str(set.website));
  const at = Date.parse(str(ev.timestamp) ?? '');
  return {
    uuid, name, email, firstName, lastName,
    fullName: fullName && fullName.toLowerCase() !== email ? fullName : null,
    companyName: companyName && companyName.length <= 120 ? companyName : null,
    companyDomain,
    occurredAt: Number.isNaN(at) ? new Date().toISOString() : new Date(at).toISOString(),
    properties: slimProperties(props),
  };
}

// ── Daily: usage per user, rolled up per company ─────────────────────────────────────────────

/**
 * The HogQL for a project's last 60 days, one row per user email. Key events are counted in
 * their own columns (k0…k9) over the last 30 days, with the first time each was seen.
 */
export function posthogUsageQuery(keyEvents: string[], { limit = 10_000, groupIndex = null }: { limit?: number; groupIndex?: number | null } = {}): string {
  const keys = posthogEventList(keyEvents);
  const q = (s: string) => `'${s}'`;   // eventName() already refused quotes and backslashes
  const keyCols = keys.flatMap((e, i) => [
    `countIf(event = ${q(e)} AND timestamp >= now() - INTERVAL 30 DAY) AS k${i}`,
    `minIf(timestamp, event = ${q(e)}) AS f${i}`,
  ]);
  // Who they are beyond the address, after the key events: the name, the company the product
  // put on the person, and their company group when the project has one. max() skips nulls.
  const who = [
    'max(toString(person.properties.name)) AS full_name',
    "max(coalesce(nullIf(toString(person.properties.company), ''), nullIf(toString(person.properties.company_name), ''), nullIf(toString(person.properties.organization), ''))) AS company",
    ...(Number.isInteger(groupIndex) && (groupIndex as number) >= 0 && (groupIndex as number) <= 4 ? [`max($group_${groupIndex}) AS grp`] : []),
  ];
  const cols = [
    'lower(toString(person.properties.email)) AS email',
    'max(timestamp) AS last_seen',
    'uniqIf(toDate(timestamp), timestamp >= now() - INTERVAL 30 DAY) AS active_days_30d',
    'uniqIf(toDate(timestamp), timestamp >= now() - INTERVAL 7 DAY) AS active_days_7d',
    'countIf(timestamp >= now() - INTERVAL 30 DAY) AS events_30d',
    'countIf(timestamp < now() - INTERVAL 30 DAY) AS events_prev_30d',
    ...keyCols, ...who,
  ];
  return [
    'SELECT',
    cols.map(c => `  ${c}`).join(',\n'),
    'FROM events',
    "WHERE timestamp >= now() - INTERVAL 60 DAY AND notEmpty(toString(person.properties.email))",
    'GROUP BY email',
    'ORDER BY last_seen DESC',
    `LIMIT ${Math.max(1, Math.min(50_000, Math.floor(limit)))}`,
  ].join('\n');
}

export interface PostHogUserUsage {
  email: string;
  domain: string | null;
  lastSeen: string | null;
  activeDays30d: number;
  activeDays7d: number;
  events30d: number;
  eventsPrev30d: number;
  keyEvents: Record<string, { count30d: number; firstSeen: string | null }>;
  fullName: string | null;
  /** The company PostHog has on the person (company, company_name or organization). */
  companyHint: string | null;
  /** Their company group's key, when the project groups users by company. */
  groupKey: string | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
// HogQL hands times back as ISO strings, sometimes with a space and no zone (UTC). A minIf
// over no rows is the epoch, which means "never".
const isoOrNull = (v: unknown) => {
  if (v == null || v === '') return null;
  const s = String(v).trim().replace(' ', 'T');
  const t = Date.parse(/(z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) || t <= 0 ? null : new Date(t).toISOString();
};

/** The query's rows as usage per user. Rows without a usable email are dropped. */
export function parseUsageRows(results: unknown, keyEvents: string[]): PostHogUserUsage[] {
  const keys = posthogEventList(keyEvents);
  const out: PostHogUserUsage[] = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!Array.isArray(r)) continue;
    const email = str(r[0])?.toLowerCase() ?? null;
    if (!email || !EMAIL.test(email)) continue;
    const keyStats: PostHogUserUsage['keyEvents'] = {};
    keys.forEach((k, i) => { keyStats[k] = { count30d: num(r[6 + i * 2]), firstSeen: isoOrNull(r[7 + i * 2]) }; });
    const w = 6 + keys.length * 2;
    const fullName = str(r[w]);
    const companyHint = str(r[w + 1]);
    out.push({
      email, domain: companyDomainFromEmail(email),
      lastSeen: isoOrNull(r[1]),
      activeDays30d: num(r[2]), activeDays7d: num(r[3]),
      events30d: num(r[4]), eventsPrev30d: num(r[5]),
      keyEvents: keyStats,
      fullName: fullName && fullName.toLowerCase() !== email ? fullName : null,
      companyHint: companyHint && companyHint.length <= 120 ? companyHint : null,
      groupKey: str(r[w + 2]),
    });
  }
  return out;
}

export interface PostHogCompanyUsage {
  /** What the users were rolled up by: `group:<key>`, `domain:<domain>` or `name:<company>`. */
  key?: string;
  domain: string | null;
  name?: string | null;
  activeUsers30d: number;
  activeUsers7d: number;
  activeUsersPrev30d: number;
  totalUsers: number;
  usage30d: number;
  usagePrev30d: number;
  lastUsedAt: string | null;
  keyEvents: Record<string, { count30d: number; users30d: number; firstSeen: string | null }>;
  emails: string[];
}

export interface PostHogGroup { name: string | null; domain: string | null }
export interface UsageAccount { key: string; name: string | null; domain: string | null }

/**
 * Which account a user belongs to, best evidence first: their company group in PostHog, then
 * their work-email domain, then the company PostHog has on the person. A free-mail user with
 * none of the three has no account here (the pull asks enrichment instead).
 */
export function usageAccountOf(u: PostHogUserUsage, groups: Map<string, PostHogGroup> = new Map()): UsageAccount | null {
  const g = u.groupKey ? groups.get(u.groupKey) : null;
  if (u.groupKey && g && (g.domain || g.name)) return { key: `group:${u.groupKey}`, name: g.name, domain: g.domain };
  if (u.domain) return { key: `domain:${u.domain}`, name: u.companyHint, domain: u.domain };
  if (u.companyHint) return { key: `name:${u.companyHint.toLowerCase()}`, name: u.companyHint, domain: null };
  return null;
}

/** Users rolled up by account (usageAccountOf by default). Users with no account are left out. */
export function rollUpByAccount(users: PostHogUserUsage[], accountOf: (u: PostHogUserUsage) => UsageAccount | null = (u) => usageAccountOf(u)): PostHogCompanyUsage[] {
  const by = new Map<string, PostHogCompanyUsage>();
  for (const u of users) {
    const a = accountOf(u);
    if (!a) continue;
    const c = by.get(a.key) ?? {
      key: a.key, domain: a.domain, name: a.name, activeUsers30d: 0, activeUsers7d: 0, activeUsersPrev30d: 0, totalUsers: 0,
      usage30d: 0, usagePrev30d: 0, lastUsedAt: null, keyEvents: {}, emails: [],
    };
    c.totalUsers++;
    c.emails.push(u.email);
    if (u.activeDays30d > 0) c.activeUsers30d++;
    if (u.activeDays7d > 0) c.activeUsers7d++;
    if (u.eventsPrev30d > 0) c.activeUsersPrev30d++;
    c.usage30d += u.events30d;
    c.usagePrev30d += u.eventsPrev30d;
    if (u.lastSeen && (!c.lastUsedAt || u.lastSeen > c.lastUsedAt)) c.lastUsedAt = u.lastSeen;
    for (const [k, s] of Object.entries(u.keyEvents)) {
      const t = c.keyEvents[k] ?? { count30d: 0, users30d: 0, firstSeen: null };
      t.count30d += s.count30d;
      if (s.count30d > 0) t.users30d++;
      if (s.firstSeen && (!t.firstSeen || s.firstSeen < t.firstSeen)) t.firstSeen = s.firstSeen;
      c.keyEvents[k] = t;
    }
    by.set(a.key, c);
  }
  return [...by.values()];
}

/** Users rolled up by their work-email domain only. Free-mail users are left out. */
export function rollUpByDomain(users: PostHogUserUsage[]): PostHogCompanyUsage[] {
  return rollUpByAccount(users, (u) => (u.domain ? { key: u.domain, name: null, domain: u.domain } : null));
}

// ── Company groups ──────────────────────────────────────────────────────────────────────────

/** The project's company group type, if it has one: the index the events carry as $group_<n>. */
export function companyGroupIndex(types: unknown): number | null {
  const list = Array.isArray(types) ? types : [];
  const hit = list.find((t: any) => /compan|organi[sz]ation|account|workspace|\borg\b|team|customer/i.test(String(t?.group_type ?? '')));
  const i = Number(hit?.group_type_index);
  return Number.isInteger(i) && i >= 0 && i <= 4 ? i : null;
}

/** The HogQL for a group type's groups: key, name, and a domain from domain or website. */
export function posthogGroupsQuery(index: number, { limit = 20_000 } = {}): string {
  return [
    "SELECT key, toString(properties.name) AS name, coalesce(nullIf(toString(properties.domain), ''), nullIf(toString(properties.website), ''), toString(properties.url)) AS site",
    `FROM groups WHERE index = ${Math.floor(index)}`,
    `LIMIT ${Math.max(1, Math.min(50_000, Math.floor(limit)))}`,
  ].join('\n');
}

/** The groups query's rows as key → { name, domain }. A free-mail "domain" is no domain. */
export function parseGroupRows(results: unknown): Map<string, PostHogGroup> {
  const out = new Map<string, PostHogGroup>();
  for (const r of Array.isArray(results) ? results : []) {
    if (!Array.isArray(r) || !str(r[0])) continue;
    const site = hostOf(str(r[2]));
    out.set(String(r[0]), { name: str(r[1]), domain: site && companyDomainFromEmail(`x@${site}`) ? site : null });
  }
  return out;
}

/** The account-health facts a PostHog pull may also write, unless a CRM already holds them. */
export const POSTHOG_CS_FACTS = ['cs.active_users_30d', 'cs.total_users', 'cs.usage_30d', 'cs.last_used_at'] as const;

/**
 * A company's usage as the state facts we record. product.* is PostHog's own copy, always
 * written, and what the account page's usage card reads. The cs.* names are the provider-neutral
 * account-health vocabulary (integrations/crm/accountHealth.ts) that the health score's adoption
 * factor and the CS lists already read; the pull drops them for an account whose CRM writes them,
 * because claims are newest-wins and the two would overwrite each other every day.
 */
export function companyUsageFacts(c: PostHogCompanyUsage): Array<[string, unknown]> {
  return [
    ['cs.active_users_30d', c.activeUsers30d],
    ['cs.total_users', c.totalUsers],
    ['cs.usage_30d', c.usage30d],
    ['cs.last_used_at', c.lastUsedAt],
    ['product.active_users_30d', c.activeUsers30d],
    ['product.total_users', c.totalUsers],
    ['product.usage_30d', c.usage30d],
    ['product.last_used_at', c.lastUsedAt],
    ['product.active_users_7d', c.activeUsers7d],
    ['product.active_users_prev_30d', c.activeUsersPrev30d],
    ['product.usage_prev_30d', c.usagePrev30d],
    ['product.key_events', Object.keys(c.keyEvents).length ? c.keyEvents : null],
  ];
}

/**
 * An account whose users all went quiet: nobody in the 60-day window. Every count is zero and
 * the key events are cleared, so the card never shows last month's numbers as today's. Total
 * users and last used stay: they are still true.
 */
export const QUIET_COMPANY_FACTS: Array<[string, unknown]> = [
  ['cs.active_users_30d', 0], ['cs.usage_30d', 0],
  ['product.active_users_30d', 0], ['product.usage_30d', 0], ['product.active_users_7d', 0],
  ['product.active_users_prev_30d', 0], ['product.usage_prev_30d', 0], ['product.key_events', {}],
];

/**
 * One user's usage as the state facts we record on the person. `product.user` is the one an
 * agent or a page asks "is this a user of the product?": true while they used it in the last
 * 30 days, false once they stopped.
 */
export function personUsageFacts(u: PostHogUserUsage): Array<[string, unknown]> {
  return [
    ['product.user', u.activeDays30d > 0],
    ['product.last_seen_at', u.lastSeen],
    ['product.active_days_30d', u.activeDays30d],
    ['product.events_30d', u.events30d],
    ['product.key_events', Object.keys(u.keyEvents).length ? u.keyEvents : null],
  ];
}

// ── The events a project sends, to pick from (GET-751) ────────────────────────────────────────

/**
 * The project's own events of the last 30 days, most frequent first, with how many people sent
 * each: what the Edit events dialog offers as checkboxes. PostHog's own ($pageview, $autocapture…)
 * are left out; they are not product milestones.
 */
export function posthogEventNamesQuery({ limit = 40 } = {}): string {
  return [
    'SELECT event, count() AS n, uniq(person_id) AS people',
    "FROM events WHERE timestamp >= now() - INTERVAL 30 DAY AND NOT startsWith(event, '$')",
    'GROUP BY event ORDER BY n DESC',
    `LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}`,
  ].join('\n');
}

/** The names query's rows: [{ name, count, people }], only names we can filter on. */
export function parseEventNames(results: unknown): Array<{ name: string; count: number; people: number }> {
  const out: Array<{ name: string; count: number; people: number }> = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!Array.isArray(r)) continue;
    const name = eventName(r[0]);
    if (name) out.push({ name, count: num(r[1]), people: num(r[2]) });
  }
  return out;
}

// ── Errors and friction: product issues per account, for the Product team (GET-751) ──────────
//
// Once a day, next to the usage pull: the last 7 days of `$exception` (an error in the product),
// `$rageclick` (clicked over and over) and `$dead_click` (clicked, nothing happened), per user
// email, grouped by what went wrong and where. Rolled up per account, each issue worth reading
// becomes one insight on the Insights board's Product lane, where the nightly sort files it next
// to what customers said on calls about the same thing.

export const ISSUE_WINDOW_DAYS = 7;

/** The HogQL for the issues of the last 7 days. Reads both exception shapes the SDKs send. */
export function posthogIssuesQuery({ limit = 5000 } = {}): string {
  return [
    'SELECT',
    '  lower(toString(person.properties.email)) AS email,',
    '  event,',
    "  if(event = '$exception', coalesce(nullIf(toString(properties.$exception_type), ''), JSONExtractString(toString(properties.$exception_types), 1)), '') AS kind,",
    "  if(event = '$exception', substring(coalesce(nullIf(toString(properties.$exception_message), ''), JSONExtractString(toString(properties.$exception_values), 1)), 1, 300), '') AS message,",
    '  toString(properties.$pathname) AS path,',
    '  count() AS n,',
    '  max(timestamp) AS last_at',
    'FROM events',
    `WHERE timestamp >= now() - INTERVAL ${ISSUE_WINDOW_DAYS} DAY AND event IN ('$exception', '$rageclick', '$dead_click') AND notEmpty(toString(person.properties.email))`,
    'GROUP BY email, event, kind, message, path',
    'ORDER BY n DESC',
    `LIMIT ${Math.max(1, Math.min(50_000, Math.floor(limit)))}`,
  ].join('\n');
}

export type IssueEvent = '$exception' | '$rageclick' | '$dead_click';
export interface PostHogIssueRow { email: string; domain: string | null; event: IssueEvent; kind: string | null; message: string | null; path: string | null; n: number; lastAt: string | null }

/**
 * A page path as a place, not a record: ids and numbers become `:id`, so `/accounts/ba15…` at
 * two customers is the same page. Query strings and fragments are dropped.
 */
export function normalizePath(p: unknown): string | null {
  const s = String(p ?? '').trim().replace(/[?#].*$/, '');
  if (!s) return null;
  return s.split('/').map(seg =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) || /^[0-9a-z]{20,}$/i.test(seg) ? ':id' : seg,
  ).join('/').slice(0, 120) || '/';
}

/** An error message without what may identify someone: addresses, ids, long numbers, links. */
export function sanitizeIssueMessage(m: unknown): string | null {
  const s = String(m ?? '').replace(/\s+/g, ' ').trim()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .replace(/https?:\/\/\S+/g, '<url>');
  return s ? s.slice(0, 160) : null;
}

/** The issues query's rows, with places normalised and messages cleaned. Rows without an email are dropped. */
export function parseIssueRows(results: unknown): PostHogIssueRow[] {
  const out: PostHogIssueRow[] = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!Array.isArray(r)) continue;
    const email = str(r[0])?.toLowerCase() ?? null;
    const event = r[1] as IssueEvent;
    if (!email || !EMAIL.test(email) || !['$exception', '$rageclick', '$dead_click'].includes(event)) continue;
    out.push({
      email, domain: companyDomainFromEmail(email), event,
      kind: str(r[2]), message: sanitizeIssueMessage(r[3]), path: normalizePath(r[4]),
      n: num(r[5]), lastAt: isoOrNull(r[6]),
    });
  }
  return out;
}

export interface PostHogIssue {
  key: string;
  event: IssueEvent;
  kind: string | null;
  message: string | null;
  path: string | null;
  count: number;
  emails: string[];
  lastAt: string | null;
}

/** What makes two rows the same issue: the event, the error and the page. */
export function issueKey(r: Pick<PostHogIssueRow, 'event' | 'kind' | 'message' | 'path'>): string {
  const msg = String(r.message ?? '').toLowerCase().replace(/<[a-z]+>/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  return [r.event, String(r.kind ?? '').toLowerCase(), msg, r.path ?? ''].join('|');
}

/** One account's issues worth reading: an error 3+ times or by 2+ people, 5+ rage clicks, 10+ dead clicks. */
export function issuesFor(rows: PostHogIssueRow[]): PostHogIssue[] {
  const by = new Map<string, PostHogIssue>();
  for (const r of rows) {
    const key = issueKey(r);
    const it = by.get(key) ?? { key, event: r.event, kind: r.kind, message: r.message, path: r.path, count: 0, emails: [], lastAt: null };
    it.count += r.n;
    if (!it.emails.includes(r.email)) it.emails.push(r.email);
    if (r.lastAt && (!it.lastAt || r.lastAt > it.lastAt)) it.lastAt = r.lastAt;
    by.set(key, it);
  }
  const worth = (i: PostHogIssue) =>
    i.event === '$exception' ? i.count >= 3 || i.emails.length >= 2
    : i.event === '$rageclick' ? i.count >= 5
    : i.count >= 10;
  return [...by.values()].filter(worth).sort((a, b) => b.emails.length - a.emails.length || b.count - a.count);
}

const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

/** The sentence the board shows for an issue: what happened, where, how often, by how many. */
export function issueStatement(i: PostHogIssue): string {
  const where = i.path ? ` on ${i.path}` : '';
  const often = `${times(i.count)} by ${people(i.emails.length)} in the last ${ISSUE_WINDOW_DAYS} days`;
  if (i.event === '$exception') {
    const what = [i.kind, i.message].filter(Boolean).join(': ') || 'An error';
    return `Error in the product${where}: ${what}. ${often[0].toUpperCase()}${often.slice(1)} (PostHog).`;
  }
  if (i.event === '$rageclick') return `People clicked over and over${where}, ${often} (PostHog).`;
  return `Clicks that did nothing${where}, ${often} (PostHog).`;
}
