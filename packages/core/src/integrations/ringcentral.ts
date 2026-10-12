// RingCentral — the phone system a company sells on (GET-289).
//
// ONE client for the API's connect test and the worker's poller, so the two can never disagree
// about how a call is read. Everything here is pure or talks only to RingCentral; the pipeline
// that files a call onto the graph lives in the worker (handlers/ringcentral.mjs).
//
// Auth is the JWT bearer grant (developers.ringcentral.com/guide/authentication/jwt-flow). We
// register one RingCentral app (RINGCENTRAL_CLIENT_ID / _SECRET) and the customer pastes a JWT
// created for a service user and restricted to our client id. A customer who built their own
// private app can paste its client id and secret instead. Access tokens last about an hour and
// the token endpoint is in the Auth rate group (5 requests/min), so a token is cached until just
// before it expires rather than fetched per request.
//
// Rate limits are per user + app, per group. The company call log, recording metadata and
// RingSense insights are all Heavy: 10 requests a minute. A 429 carries Retry-After, and ANY
// request during the penalty restarts it — so a caller that sees `rateLimited` stops for the run.

export const RINGCENTRAL_SERVER = 'https://platform.ringcentral.com';

export interface RingCentralCredentials {
  jwt?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
}

export interface RingCentralAuth {
  jwt: string;
  clientId: string;
  clientSecret: string;
}

export class RingCentralError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The app a JWT is exchanged through: the customer's own when they gave one, else ours. Null when
 * neither exists — a server with no RingCentral app configured cannot connect anyone.
 */
export function ringCentralAuth(creds: RingCentralCredentials | null | undefined): RingCentralAuth | null {
  const jwt = String(creds?.jwt ?? '').trim();
  if (!jwt) return null;
  const ownId = String(creds?.client_id ?? '').trim();
  const ownSecret = String(creds?.client_secret ?? '').trim();
  const clientId = ownId || process.env.RINGCENTRAL_CLIENT_ID || '';
  const clientSecret = ownId ? ownSecret : (process.env.RINGCENTRAL_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) return null;
  return { jwt, clientId, clientSecret };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (a: RingCentralAuth) => `${a.clientId}:${a.jwt.slice(-32)}`;

/** An access token for this JWT, from the cache while it has more than 5 minutes left. */
export async function ringCentralToken(auth: RingCentralAuth, { fresh = false } = {}): Promise<string> {
  const key = cacheKey(auth);
  const hit = tokenCache.get(key);
  if (!fresh && hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;

  const res = await fetch(`${RINGCENTRAL_SERVER}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: auth.jwt }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== 'string') {
    tokenCache.delete(key);
    const code = typeof body.error === 'string' ? body.error : null;
    const msg = typeof body.error_description === 'string' ? body.error_description : `token_${res.status}`;
    throw new RingCentralError(msg, res.status, code);
  }
  const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 3600_000;
  tokenCache.set(key, { token: body.access_token, expiresAt: Date.now() + ttl });
  return body.access_token;
}

export type RingCentralResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; rateLimited: boolean; retryAfterSec: number | null; message: string };

/**
 * GET a RingCentral path (or a full `navigation.nextPage.uri`). Never throws for an HTTP answer:
 * 404/403/429 are things a caller decides about. A 401 retries once with a fresh token, because a
 * cached token can be revoked before it expires.
 */
export async function ringCentralGet<T = Record<string, unknown>>(
  auth: RingCentralAuth,
  pathOrUrl: string,
  query: Record<string, string | number | boolean | null | undefined> = {},
): Promise<RingCentralResult<T>> {
  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${RINGCENTRAL_SERVER}${pathOrUrl}`);
  // Only ever send the token to RingCentral, whatever a pagination link says.
  if (!/(^|\.)ringcentral\.com$/.test(url.hostname)) {
    return { ok: false, status: 400, rateLimited: false, retryAfterSec: null, message: 'not_a_ringcentral_url' };
  }
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ringCentralToken(auth, { fresh: attempt > 0 });
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 401 && attempt === 0) continue;
    if (res.ok) return { ok: true, data: await res.json().catch(() => ({})) as T };
    const text = await res.text().catch(() => '');
    let message = `ringcentral_${res.status}`;
    try {
      const j = JSON.parse(text);
      message = j.message || j.errors?.[0]?.message || j.error_description || message;
    } catch { /* not JSON */ }
    const ra = Number(res.headers.get('retry-after'));
    return { ok: false, status: res.status, rateLimited: res.status === 429, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null, message };
  }
  return { ok: false, status: 401, rateLimited: false, retryAfterSec: null, message: 'unauthorized' };
}

// ── Phones ──────────────────────────────────────────────────────────────────

/**
 * The key two phone numbers are compared on: the last 10 digits. "+1 (555) 123-4567",
 * "555.123.4567" and "15551234567" are one number. Null for anything shorter than 10 digits — an
 * extension or a short code is not something to match a person on.
 */
export function phoneKey(input: string | null | undefined): string | null {
  const digits = String(input ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// ── Calls ───────────────────────────────────────────────────────────────────

export interface RingCentralParty {
  phoneNumber?: string;
  extensionNumber?: string;
  extensionId?: string;
  name?: string;
}

export interface RingCentralCallLogRecord {
  id: string;
  sessionId?: string;
  telephonySessionId?: string;
  startTime: string;
  duration?: number;
  type?: string;
  direction?: 'Inbound' | 'Outbound';
  result?: string;
  from?: RingCentralParty;
  to?: RingCentralParty;
  extension?: { id?: string | number };
  recording?: { id?: string; contentUri?: string; type?: string };
  legs?: Array<{
    direction?: string; result?: string; legType?: string; master?: boolean;
    from?: RingCentralParty; to?: RingCentralParty; extension?: { id?: string | number };
    recording?: { id?: string };
  }>;
}

export interface RingCentralCall {
  id: string;
  telephonySessionId: string | null;
  startTime: string;
  durationSec: number;
  direction: 'Inbound' | 'Outbound';
  result: string | null;
  /** Our side: the extension that took or placed the call. */
  repExtensionId: string | null;
  repName: string | null;
  /** The other side: who the rep was talking to. */
  otherPhone: string | null;
  otherName: string | null;
  recordingId: string | null;
  /** Both ends are extensions on this account: a colleague, not a buyer. */
  internal: boolean;
}

/** Results that mean two people actually spoke. Everything else (Missed, Voicemail, Busy…) did not. */
const CONNECTED = new Set(['accepted', 'call connected', 'received']);
export const MIN_CALL_SECONDS = 30;

const idOf = (v: unknown) => (v == null || v === '' ? null : String(v));

/** A call-log record (view=Detailed) → the one call shape the pipeline reads. */
export function callFromCallLog(r: RingCentralCallLogRecord): RingCentralCall {
  const direction = r.direction === 'Inbound' ? 'Inbound' : 'Outbound';
  const ours = direction === 'Outbound' ? r.from : r.to;
  const theirs = direction === 'Outbound' ? r.to : r.from;

  // Inbound calls ring a number, a queue or an IVR before a person picks up. The leg that was
  // ACCEPTED by an extension is the rep who took it; the record's own `to` is often the queue.
  const acceptedLeg = direction === 'Inbound'
    ? (r.legs ?? []).find(l => l.extension?.id != null && CONNECTED.has(String(l.result ?? '').toLowerCase()))
    : null;
  const repExtensionId = idOf(acceptedLeg?.extension?.id) ?? idOf(ours?.extensionId) ?? idOf(r.extension?.id)
    ?? idOf((r.legs ?? []).find(l => l.master)?.extension?.id);
  const repName = (acceptedLeg ? acceptedLeg.to?.name : null) ?? ours?.name ?? null;

  const recordingId = idOf(r.recording?.id) ?? idOf((r.legs ?? []).find(l => l.recording?.id)?.recording?.id);

  return {
    id: String(r.id),
    telephonySessionId: idOf(r.telephonySessionId),
    startTime: r.startTime,
    durationSec: Number(r.duration) || 0,
    direction,
    result: r.result ?? null,
    repExtensionId,
    repName: repName ? String(repName).trim() : null,
    otherPhone: theirs?.phoneNumber ?? null,
    otherName: theirs?.name ? String(theirs.name).trim() : null,
    recordingId,
    internal: !!theirs?.extensionId,
  };
}

/** A conversation worth filing: a connected voice call with someone outside, long enough to be one. */
export function isConversation(r: RingCentralCallLogRecord, minSeconds = MIN_CALL_SECONDS): boolean {
  if (r.type && r.type !== 'Voice') return false;
  if (!CONNECTED.has(String(r.result ?? '').toLowerCase())) return false;
  if ((Number(r.duration) || 0) < minSeconds) return false;
  const call = callFromCallLog(r);
  return !call.internal && !!phoneKey(call.otherPhone);
}

// ── RingSense (AI Conversation Expert) ──────────────────────────────────────

interface InsightItem { start?: number; end?: number; value?: string; text?: string; speakerId?: string }
export interface RingSenseRecord {
  recordingStartTime?: string;
  speakerInfo?: Array<{ speakerId?: string; name?: string; extensionId?: string | null }>;
  insights?: {
    Transcript?: InsightItem[];
    Summary?: InsightItem[];
    BulletedSummary?: InsightItem[];
    NextSteps?: InsightItem[];
    CallNotes?: InsightItem[];
  };
}

const GENERIC_SPEAKER = /^(speaker|unknown|participant|caller)\s*\d*$/i;

/**
 * RingSense insights (one record per recorded leg) → the transcript and recap the pipeline reads.
 * Lines are "Name: text" like every other note-taker, so the call scorer and the evidence excerpts
 * read a RingCentral call the same way they read a Fellow meeting.
 */
export function transcriptFromInsights(records: RingSenseRecord[] | null | undefined): {
  text: string | null; recap: string | null; speakerNames: string[];
} {
  const recs = [...(records ?? [])].sort((a, b) => String(a.recordingStartTime ?? '').localeCompare(String(b.recordingStartTime ?? '')));
  const lines: string[] = [];
  const names = new Set<string>();
  const summary: string[] = [];
  const bullets: string[] = [];
  const next: string[] = [];
  const notes: string[] = [];

  for (const rec of recs) {
    const who = new Map((rec.speakerInfo ?? []).map(s => [String(s.speakerId), String(s.name ?? '').trim()]));
    for (const seg of rec.insights?.Transcript ?? []) {
      const txt = String(seg.text ?? seg.value ?? '').trim();
      if (!txt) continue;
      const name = who.get(String(seg.speakerId)) || '';
      if (name && !GENERIC_SPEAKER.test(name)) names.add(name);
      lines.push(name ? `${name}: ${txt}` : txt);
    }
    for (const s of rec.insights?.Summary ?? []) if (s.value?.trim()) summary.push(s.value.trim());
    for (const s of rec.insights?.BulletedSummary ?? []) if (s.value?.trim()) bullets.push(s.value.trim());
    for (const s of rec.insights?.NextSteps ?? []) if (s.value?.trim()) next.push(s.value.trim());
    for (const s of rec.insights?.CallNotes ?? []) if (s.value?.trim()) notes.push(s.value.trim());
  }

  const recap = [
    summary.length ? `## Summary\n${summary.join('\n\n')}` : null,
    bullets.length ? `## Key points\n${bullets.map(b => b.startsWith('-') ? b : `- ${b}`).join('\n')}` : null,
    next.length ? `## Next steps\n${next.map(n => `- ${n}`).join('\n')}` : null,
    notes.length ? `## Call notes\n${notes.join('\n\n')}` : null,
  ].filter(Boolean).join('\n\n') || null;

  return { text: lines.join('\n').trim().slice(0, 200_000) || null, recap, speakerNames: [...names] };
}
