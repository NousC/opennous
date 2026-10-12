import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// Webhook delivery log (GET-624). One row per HTTP attempt Nous makes against a customer's
// outbound webhook (a trigger_subscriptions row), retries included, so the Webhooks page can
// show recent deliveries, a 7-day success rate and a Resend button.
//
// outbound_events is the outbox: one row per (event, subscription) holding the signed body and
// the CURRENT delivery state, overwritten on every retry. This table is the history the outbox
// cannot keep. It holds no payload of its own: outbound_events.payload already is the exact
// body we sign, so a delivery points at it (outbound_event_id) and Resend replays it from there.
//
// The send itself lives here too (deliverToSubscription → sendSignedDelivery for a URL,
// sendGithubDispatch for a GitHub repo), so the worker's drain loop, the API's Resend and the test
// send go through one path, not three that drift.

export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_ERROR_MAX = 300;
export const DELIVERY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const DELIVERY_COLUMNS =
  'id, workspace_id, subscription_id, outbound_event_id, event, event_id, attempt, status_code, ok, error, duration_ms, created_at, resent_from';

export interface WebhookDelivery {
  id: string;
  workspace_id: string;
  subscription_id: string;
  outbound_event_id: string | null;
  event: string;
  event_id: string | null;
  attempt: number;
  status_code: number | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  created_at: string;
  resent_from: string | null;
}

// ── The signed send ─────────────────────────────────────────────────────────

/** HMAC-SHA256 of the raw body, hex. Sent as `X-Nous-Signature: sha256=<hex>`. */
export function signWebhookBody(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export interface SendParams {
  url: string;
  secret: string;
  eventType: string;
  eventId: string;
  payload: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  ok: boolean;
  status_code: number | null;
  /**
   * A short reason, null on success: "503 Service Unavailable" (the status line, never the
   * receiver's response body), "redirect not followed", "timeout", or the network error.
   */
  error: string | null;
  duration_ms: number;
  /** A 4xx other than 408/429: the receiver rejected it, retrying will not help. */
  permanent: boolean;
}

export const DELIVERY_REASON_MAX = 80;

/** "503 Service Unavailable", or "http_503" when the server sent no status text. */
export function statusReason(status: number, statusText?: string | null): string {
  const t = String(statusText ?? '').trim();
  return (t ? `${status} ${t}` : `http_${status}`).slice(0, DELIVERY_REASON_MAX);
}

/**
 * POST one signed event. Never throws: a network error or timeout comes back as a result.
 * Redirects are not followed (redirect: 'manual'): a 3xx is a failed delivery, so a receiver
 * cannot bounce a signed payload to a host the URL check never saw. The response body is never
 * read into the result, since the result is shown to anyone who can press Resend.
 */
export async function sendSignedDelivery(p: SendParams): Promise<SendResult> {
  const body = JSON.stringify(p.payload);
  const signature = signWebhookBody(body, p.secret);
  const doFetch = p.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DELIVERY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await doFetch(p.url, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'User-Agent':        'Nous-Triggers/1.0',
        'X-Nous-Signature':  `sha256=${signature}`,
        'X-Nous-Event-Id':   p.eventId,
        'X-Nous-Event-Type': p.eventType,
      },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const duration_ms = Date.now() - started;
    discardBody(res);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status_code: res.status, error: null, duration_ms, permanent: false };
    }
    // A manual redirect surfaces as the 3xx itself (or, in browsers, type 'opaqueredirect' / 0).
    if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') {
      return { ok: false, status_code: res.status || null, error: 'redirect not followed', duration_ms, permanent: false };
    }
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    return { ok: false, status_code: res.status, error: statusReason(res.status, res.statusText), duration_ms, permanent };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ok: false, status_code: null,
      error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? 'network_error').slice(0, DELIVERY_ERROR_MAX),
      duration_ms: Date.now() - started, permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Release the connection without reading what the receiver said. */
function discardBody(res: Response): void {
  try { void res.body?.cancel().catch(() => {}); } catch { /* already consumed or absent */ }
}

// ── The GitHub send (GET-670) ───────────────────────────────────────────────
//
// A webhook can deliver to a GitHub repo instead of a URL: the event becomes a repository_dispatch,
// so the repo's Actions run on it (the after-call automation, a customer's own ICP scorer). Same
// outbox, retries and delivery log as a URL; only the last hop differs. GitHub authenticates the
// sender by the token, so there is no signature: the workflow trusts the dispatch it was sent.

/** What a workflow listens for: `on: repository_dispatch: types: [nous.conversation.call_ended]`. */
export function githubEventType(eventType: string): string {
  return `nous.${eventType}`;
}

const pick = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The small, flat client_payload a workflow reads. GitHub caps it at ten top-level keys, and a run
 * that needs the record reads it from the API by entity_id, so the full envelope is not copied.
 * Works for both event shapes: interaction events ({event_id, entity_id, event_data}) and record
 * events ({id, account, people, data}), whose first person is the one the event is about.
 */
export function githubClientPayload(eventType: string, payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const p = payload ?? {};
  const people = pick(p, 'people');
  const firstPerson = Array.isArray(people) ? people[0] : null;
  const account = pick(p, 'account');
  const data = pick(p, 'data') ?? pick(p, 'event_data');
  return {
    event_id:     str(pick(p, 'event_id')) ?? str(pick(p, 'id')),
    event_type:   eventType,
    occurred_at:  str(pick(p, 'occurred_at')),
    workspace_id: str(pick(p, 'workspace_id')),
    entity_id:    str(pick(p, 'entity_id')) ?? str(pick(firstPerson, 'entity_id')) ?? str(pick(account, 'entity_id')),
    account_id:   str(pick(account, 'entity_id')),
    meeting_id:   str(pick(data, 'meeting_id')),
    source:       str(pick(data, 'source')),
    // people.added: who came in, so the workflow can score exactly them (ten keys is GitHub's cap).
    person_ids:   Array.isArray(pick(data, 'person_ids')) ? (pick(data, 'person_ids') as unknown[]).slice(0, 100) : null,
    count:        typeof pick(data, 'count') === 'number' ? pick(data, 'count') : null,
  };
}

export const GITHUB_REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export interface GithubSendParams {
  repo: string;
  token: string;
  eventType: string;
  /** Send this event_type instead of nous.<event> (a webhook's github_event_type, GET-672). */
  githubEventType?: string | null;
  payload: Record<string, unknown> | null | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** POST one repository_dispatch. Never throws, and returns the same result shape as a URL send. */
export async function sendGithubDispatch(p: GithubSendParams): Promise<SendResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs ?? DELIVERY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await doFetch(`https://api.github.com/repos/${p.repo}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization':        `Bearer ${p.token}`,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':         'application/json',
        'User-Agent':           'Nous-Triggers/1.0',
      },
      body: JSON.stringify({ event_type: p.githubEventType || githubEventType(p.eventType), client_payload: githubClientPayload(p.eventType, p.payload) }),
      redirect: 'manual',
      signal: controller.signal,
    });
    const duration_ms = Date.now() - started;
    discardBody(res);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status_code: res.status, error: null, duration_ms, permanent: false };
    }
    // 401 bad token, 403 no Contents:write, 404 repo gone or invisible to the token, 422 bad body:
    // all permanent. GitHub's 403 for a rate limit is the exception worth a retry.
    const rateLimited = res.status === 429 || (res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0');
    const permanent = !rateLimited && res.status >= 400 && res.status < 500 && res.status !== 408;
    const hint = res.status === 401 ? ' (token rejected)' : res.status === 404 ? ' (repo not found for this token)' : res.status === 403 && !rateLimited ? ' (token lacks Contents: write)' : '';
    return { ok: false, status_code: res.status, error: (statusReason(res.status, res.statusText) + hint).slice(0, DELIVERY_REASON_MAX), duration_ms, permanent };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      ok: false, status_code: null,
      error: e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? 'network_error').slice(0, DELIVERY_ERROR_MAX),
      duration_ms: Date.now() - started, permanent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── One send for every path ─────────────────────────────────────────────────

/** The subscription columns a send needs. github_token_enc is read here and nowhere else. */
export const SUBSCRIPTION_SEND_COLUMNS = 'id, url, signing_secret, active, destination_type, github_repo, github_token_enc, github_event_type';

export interface SendableSubscription {
  url: string | null;
  signing_secret: string;
  destination_type?: string | null;
  github_repo?: string | null;
  github_token_enc?: string | null;
  github_event_type?: string | null;
}

/**
 * Deliver one event to one subscription, whatever its destination. The worker's drain, Resend and
 * the test send all come through here, so a GitHub webhook behaves exactly like a URL one.
 * `decryptToken` is the caller's (API or worker) decrypt for github_token_enc; core holds no key.
 */
export async function deliverToSubscription(
  sub: SendableSubscription,
  p: { eventType: string; eventId: string; payload: Record<string, unknown>; decryptToken?: (enc: string) => string | null; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<SendResult> {
  if (sub.destination_type === 'github') {
    let token: string | null = null;
    try { token = sub.github_token_enc && p.decryptToken ? p.decryptToken(sub.github_token_enc) : null; } catch { token = null; }
    // Both decrypts hand back their input when they cannot read it; never send ciphertext as a token.
    if (token === sub.github_token_enc) token = null;
    if (!token || !sub.github_repo) {
      return { ok: false, status_code: null, error: 'GitHub token missing or unreadable', duration_ms: 0, permanent: true };
    }
    return sendGithubDispatch({
      repo: sub.github_repo, token, eventType: p.eventType, githubEventType: sub.github_event_type,
      payload: p.payload, timeoutMs: p.timeoutMs, fetchImpl: p.fetchImpl,
    });
  }
  if (!sub.url) return { ok: false, status_code: null, error: 'webhook has no URL', duration_ms: 0, permanent: true };
  return sendSignedDelivery({
    url: sub.url, secret: sub.signing_secret, eventType: p.eventType, eventId: p.eventId, payload: p.payload,
    timeoutMs: p.timeoutMs, fetchImpl: p.fetchImpl,
  });
}

// ── Recording ───────────────────────────────────────────────────────────────

export interface RecordAttemptParams {
  workspaceId: string;
  subscriptionId: string;
  outboundEventId: string | null;
  event: string;
  eventId: string | null;
  attempt: number;
  result: SendResult;
  resentFrom?: string | null;
}

/**
 * Write one attempt row. Best-effort by contract: the delivery already happened, and a log that
 * is down (or a migration not yet applied) must never fail or retry it. Returns the row, or null
 * when the insert did not land.
 */
export async function recordDeliveryAttempt(
  supabase: SupabaseClient,
  p: RecordAttemptParams,
): Promise<WebhookDelivery | null> {
  try {
    const { data, error } = await supabase
      .from('webhook_deliveries')
      .insert({
        workspace_id:      p.workspaceId,
        subscription_id:   p.subscriptionId,
        outbound_event_id: p.outboundEventId,
        event:             p.event,
        event_id:          p.eventId,
        attempt:           p.attempt,
        status_code:       p.result.status_code,
        ok:                p.result.ok,
        error:             p.result.ok || !p.result.error ? null : p.result.error.slice(0, DELIVERY_ERROR_MAX),
        duration_ms:       Math.max(0, Math.round(p.result.duration_ms)),
        resent_from:       p.resentFrom ?? null,
      })
      .select(DELIVERY_COLUMNS)
      .single();
    if (error) {
      console.warn('[webhook_deliveries] insert failed:', error.message);
      return null;
    }
    return data as WebhookDelivery;
  } catch (err) {
    console.warn('[webhook_deliveries] insert threw:', (err as Error)?.message ?? err);
    return null;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The page size listDeliveryAttempts actually uses for a requested limit. */
export function deliveryPageLimit(limit: unknown): number {
  return Math.min(Math.max(Number(limit) || 50, 1), 200);
}

/**
 * One subscription's attempts, newest first, keyset-paged on (created_at, id): with `beforeId`
 * the page after that row (ties on created_at broken by id); with `before` alone, the legacy
 * timestamp-only page. `before` is passed through as given, so microseconds survive.
 */
export async function listDeliveryAttempts(
  supabase: SupabaseClient,
  workspaceId: string,
  subscriptionId: string,
  opts: { limit?: number; before?: string | null; beforeId?: string | null } = {},
): Promise<WebhookDelivery[]> {
  const limit = deliveryPageLimit(opts.limit);
  let q = supabase
    .from('webhook_deliveries')
    .select(DELIVERY_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('subscription_id', subscriptionId);
  if (opts.before && opts.beforeId) {
    q = q.or(`created_at.lt."${opts.before}",and(created_at.eq."${opts.before}",id.lt."${opts.beforeId}")`);
  } else if (opts.before) {
    q = q.lt('created_at', opts.before);
  }
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`failed to list webhook deliveries: ${error.message}`);
  return (data ?? []) as WebhookDelivery[];
}

export interface DeliveryStats {
  success_rate_7d: number | null;
  deliveries_7d: number;
  failures_7d: number;
  last_delivery_at: string | null;
}

/**
 * The stats math, kept pure. Counts ATTEMPTS, not events: an event that failed twice and then
 * landed is three deliveries and two failures, which is what a receiver's uptime looks like.
 * No deliveries → a null rate, not 0% or 100%. Rounded to four places (0.9167).
 */
export function summarizeDeliveryStats(total: number, failures: number, lastAt: string | null): DeliveryStats {
  const t = Math.max(0, total | 0);
  const f = Math.min(Math.max(0, failures | 0), t);
  return {
    success_rate_7d: t === 0 ? null : Math.round(((t - f) / t) * 10_000) / 10_000,
    deliveries_7d: t,
    failures_7d: f,
    last_delivery_at: lastAt,
  };
}

export async function deliveryStats(
  supabase: SupabaseClient,
  workspaceId: string,
  subscriptionId: string,
  now: number = Date.now(),
): Promise<DeliveryStats> {
  const since = new Date(now - 7 * DAY_MS).toISOString();
  const scoped = () => supabase.from('webhook_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('subscription_id', subscriptionId)
    .gte('created_at', since);
  const [all, failed, last] = await Promise.all([
    scoped(),
    scoped().eq('ok', false),
    supabase.from('webhook_deliveries')
      .select('created_at')
      .eq('workspace_id', workspaceId)
      .eq('subscription_id', subscriptionId)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);
  for (const r of [all, failed, last]) {
    if (r.error) throw new Error(`failed to read webhook delivery stats: ${r.error.message}`);
  }
  const lastAt = ((last.data ?? [])[0] as { created_at?: string } | undefined)?.created_at ?? null;
  return summarizeDeliveryStats(all.count ?? 0, failed.count ?? 0, lastAt);
}

// ── Resend ──────────────────────────────────────────────────────────────────

export type ResendOutcome =
  | { status: 'sent'; delivery: WebhookDelivery | null; result: SendResult }
  | { status: 'not_found' | 'payload_gone' | 'subscription_inactive' | 'rate_limited' };

export const RESEND_LIMIT_PER_MIN = 50;

/**
 * A per-subscription sliding-window limit for Resend, in memory (per API process): at most
 * `max` resends per subscription per `windowMs`. Resend fires a signed POST at a customer URL on
 * a click, so it must not become a way to hammer that URL. `allow(id)` counts the call when it
 * says yes.
 */
export function createResendLimiter(max: number = RESEND_LIMIT_PER_MIN, windowMs: number = 60_000) {
  const hits = new Map<string, number[]>();
  return {
    allow(subscriptionId: string, now: number = Date.now()): boolean {
      const recent = (hits.get(subscriptionId) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { hits.set(subscriptionId, recent); return false; }
      recent.push(now);
      hits.set(subscriptionId, recent);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

/**
 * Send a past delivery's event again, now. Same body (outbound_events.payload), same event id,
 * signed with the subscription's CURRENT secret (a rotated secret signs the resend with the new
 * one, which is what the receiver now verifies with). Records a new row with resent_from set.
 *
 * It does not touch the outbox row: a resend is an extra, manual send, so it neither revives a
 * dead-lettered event's retries nor marks it delivered.
 */
export async function resendDelivery(
  supabase: SupabaseClient,
  workspaceId: string,
  deliveryId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; allow?: (subscriptionId: string) => boolean; decryptToken?: (enc: string) => string | null } = {},
): Promise<ResendOutcome> {
  const { data: original, error: origErr } = await supabase
    .from('webhook_deliveries')
    .select(DELIVERY_COLUMNS)
    .eq('id', deliveryId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (origErr) throw new Error(`failed to read webhook delivery: ${origErr.message}`);
  if (!original) return { status: 'not_found' };
  const d = original as WebhookDelivery;
  if (!d.outbound_event_id) return { status: 'payload_gone' };
  if (opts.allow && !opts.allow(d.subscription_id)) return { status: 'rate_limited' };

  const [{ data: ev, error: evErr }, { data: sub, error: subErr }] = await Promise.all([
    supabase.from('outbound_events')
      .select('id, event_type, payload')
      .eq('id', d.outbound_event_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    supabase.from('trigger_subscriptions')
      .select(SUBSCRIPTION_SEND_COLUMNS)
      .eq('id', d.subscription_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
  ]);
  if (evErr) throw new Error(`failed to read outbound event: ${evErr.message}`);
  if (subErr) throw new Error(`failed to read webhook subscription: ${subErr.message}`);
  if (!sub) return { status: 'not_found' };
  if (!ev) return { status: 'payload_gone' };
  const s = sub as SendableSubscription & { id: string; active: boolean };
  if (!s.active) return { status: 'subscription_inactive' };

  const e = ev as { id: string; event_type: string; payload: Record<string, unknown> };
  const eventId = d.event_id ?? eventIdOf(e.payload, e.id);
  const result = await deliverToSubscription(s, {
    eventType: e.event_type, eventId, payload: e.payload,
    decryptToken: opts.decryptToken, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs,
  });
  const delivery = await recordDeliveryAttempt(supabase, {
    workspaceId, subscriptionId: s.id, outboundEventId: e.id, event: e.event_type, eventId,
    attempt: 1, result, resentFrom: d.id,
  });
  return { status: 'sent', delivery, result };
}

// ── Test send ───────────────────────────────────────────────────────────────

export const TEST_EVENT_TYPE = 'webhook.test';

export type TestSendOutcome =
  | { status: 'sent'; delivery: WebhookDelivery | null; result: SendResult; event_id: string; outbound_event_id: string }
  | { status: 'not_found' | 'subscription_inactive' | 'rate_limited' };

/**
 * Send one test event to a webhook now, and wait for the answer. The caller builds the body
 * (the same envelope a real event carries); this stores it in the outbox, sends it through
 * sendSignedDelivery (signed, redirects not followed, receiver body never read) and records the
 * attempt in webhook_deliveries, so it shows in the delivery log and Resend can replay it.
 *
 * The outbox row is written parked (next_attempt_at a day out) and settled right after the send:
 * delivered, or dead-lettered on failure. A test is one manual send, so the worker never retries
 * it, and never sends it a second time while this one is in flight.
 */
export async function sendTestDelivery(
  supabase: SupabaseClient,
  workspaceId: string,
  subscriptionId: string,
  p: {
    payload: Record<string, unknown>;
    entityId?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    allow?: (subscriptionId: string) => boolean;
    decryptToken?: (enc: string) => string | null;
    now?: number;
  },
): Promise<TestSendOutcome> {
  const { data: sub, error: subErr } = await supabase
    .from('trigger_subscriptions')
    .select(SUBSCRIPTION_SEND_COLUMNS)
    .eq('id', subscriptionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (subErr) throw new Error(`failed to read webhook subscription: ${subErr.message}`);
  if (!sub) return { status: 'not_found' };
  const s = sub as SendableSubscription & { id: string; active: boolean };
  if (!s.active) return { status: 'subscription_inactive' };
  if (p.allow && !p.allow(s.id)) return { status: 'rate_limited' };

  const now = p.now ?? Date.now();
  const occurredAt = typeof p.payload.occurred_at === 'string' ? p.payload.occurred_at : new Date(now).toISOString();
  const { data: ev, error: evErr } = await supabase
    .from('outbound_events')
    .insert({
      workspace_id: workspaceId,
      subscription_id: s.id,
      entity_id: p.entityId ?? null,
      event_type: TEST_EVENT_TYPE,
      payload: p.payload,
      occurred_at: occurredAt,
      next_attempt_at: new Date(now + DAY_MS).toISOString(),
    })
    .select('id')
    .single();
  if (evErr || !ev) throw new Error(`failed to store test event: ${evErr?.message ?? 'no row'}`);
  const outboundEventId = (ev as { id: string }).id;
  const eventId = eventIdOf(p.payload, outboundEventId);

  const result = await deliverToSubscription(s, {
    eventType: TEST_EVENT_TYPE, eventId, payload: p.payload,
    decryptToken: p.decryptToken, fetchImpl: p.fetchImpl, timeoutMs: p.timeoutMs,
  });

  const settledAt = new Date().toISOString();
  const { error: upErr } = await supabase
    .from('outbound_events')
    .update(result.ok
      ? { delivered_at: settledAt, attempts: 1, last_status_code: result.status_code }
      : { attempts: 1, last_status_code: result.status_code, last_error: (result.error ?? 'failed').slice(0, 1000), dead_lettered_at: settledAt })
    .eq('id', outboundEventId)
    .eq('workspace_id', workspaceId);
  if (upErr) console.warn('[webhook test] settling the outbox row failed:', upErr.message);

  const delivery = await recordDeliveryAttempt(supabase, {
    workspaceId, subscriptionId: s.id, outboundEventId, event: TEST_EVENT_TYPE, eventId, attempt: 1, result,
  });
  return { status: 'sent', delivery, result, event_id: eventId, outbound_event_id: outboundEventId };
}

/** Interaction events carry event_id; record events (GET-559) carry id; else the outbox id. */
export function eventIdOf(payload: Record<string, unknown> | null | undefined, fallback: string): string {
  const v = payload?.event_id ?? payload?.id;
  return v == null ? fallback : String(v);
}

// ── Retention ───────────────────────────────────────────────────────────────

/** Drop attempts older than 30 days. Daily, from the worker. Returns rows removed (or null). */
export async function pruneWebhookDeliveries(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<number | null> {
  const cutoff = new Date(now - DELIVERY_RETENTION_DAYS * DAY_MS).toISOString();
  const { error, count } = await supabase
    .from('webhook_deliveries')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);
  if (error) {
    console.warn('[webhook_deliveries] prune failed:', error.message);
    return null;
  }
  return count ?? 0;
}
