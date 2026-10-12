// Approved follow-ups → HubSpot (workspace redesign Phase 4).
//
// A follow-up card is a proposal until a person approves it (decision D1, 2026-10-02). With
// write-back switched on for the workspace, the same press that approves the card also writes
// what was approved into HubSpot, so the rep never re-types a call into the CRM. Nothing here runs
// on its own: one caller, POST /api/follow-ups/:id/sync, behind a human pressing "Sync to HubSpot",
// plus the Tasks page's tick, which closes the HubSpot task this file created.
//
// What is written, and nothing else (the founder's decision, 2026-10-02):
//   - each approved TASK as a HubSpot task on the deal (216), the company (192) and the people the
//     follow-up email goes to (204), owned by the approver when HubSpot knows them
//   - the approved UPDATES as ONE note on the deal (214) and the company (190)
//   - a task ticked done (or reopened) in Nous flips the status of the HubSpot task Nous created
// Never a deal's stage, amount, close date or owner: deals are born in the CRM and a stage that
// should move stays a "Deal change required" flag. WRITABLE below is the guard, not a convention:
// a write to any other path throws before it leaves the process.
//
// Idempotent by construction. The HubSpot ids land in follow_ups.verdict.sync
// ({ tasks: { <taskId>: <hubspot task id> }, note: <hubspot note id> }) one at a time, right after
// each create succeeds, and a run skips whatever already has an id. A retry after a partial
// failure therefore finishes the job without creating anything twice.
//
// Off by default: follow_up_settings.crm_writeback, flipped only after the customer grants write
// access. Automatic mirroring (registerCrmPushHandler) stays off; this is not that path.

import type { SupabaseClient } from '@supabase/supabase-js';
import { crmFetch } from './crmPush.js';
import { hubspotToken } from './hubspotVars.mjs';
import { recordObservation } from '../db/observations.js';
import { defaultTimeZone, isoDateIn, shiftIsoDate } from '../dateResolve.js';

const HS = 'https://api.hubapi.com';

// Association type ids, HUBSPOT_DEFINED. Read back live from the v4 labels endpoint (the brief's
// table, 2026-10-02): task→deal 216, task→contact 204, task→company 192; note→deal 214,
// note→contact 202, note→company 190.
export const HUBSPOT_TASK_ASSOC = { deal: 216, contact: 204, company: 192 } as const;
export const HUBSPOT_NOTE_ASSOC = { deal: 214, contact: 202, company: 190 } as const;

export const WRITEBACK_NOT_ALLOWED = 'crm_write_not_allowed';
export const WRITEBACK_NOT_ALLOWED_MESSAGE = 'Grant HubSpot write access (tasks, notes) to sync';

// A task lands on the people the email goes to. A meeting with a dozen of them is still one task,
// and HubSpot shows every associated record on the task, so the list stays short.
const MAX_CONTACTS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── The guard: the only writes this file can make ───────────────────────────

const WRITABLE: Array<[string, RegExp]> = [
  ['POST', /^\/crm\/v3\/objects\/(tasks|notes)$/],
  ['PATCH', /^\/crm\/v3\/objects\/tasks\/\d+$/],
];

/** True only for creating a task or a note, or updating a task. Deals, companies and contacts are never written. */
export function isWritableHubspotRequest(method: string, path: string): boolean {
  const m = String(method).toUpperCase();
  return WRITABLE.some(([wm, re]) => wm === m && re.test(path));
}

async function hubspotWrite(token: string, method: 'POST' | 'PATCH', path: string, body: unknown, label: string): Promise<Response> {
  if (!isWritableHubspotRequest(method, path)) throw new Error(`crmWriteback: refusing ${method} ${path}`);
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  // A PATCH sets a status: sending it twice is harmless, so it keeps crmFetch's retries.
  if (method === 'PATCH') return crmFetch(`${HS}${path}`, init, label);
  return createOnce(`${HS}${path}`, init, label);
}

/**
 * A CREATE is sent at most once, except when HubSpot answers 429: a rate-limited request was
 * refused, so nothing was created and it is safe to send again (honouring Retry-After). A 5xx or
 * a timeout is NOT retried here, unlike crmFetch: HubSpot may have created the task before the
 * error, and a blind retry would put a second copy in the customer's CRM. The caller records the
 * failure and the card offers "Retry sync", which a person decides to press.
 */
async function createOnce(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status !== 429 || attempt === 3) return res;
      const secs = parseInt(res.headers.get('retry-after') ?? '', 10);
      const wait = Number.isFinite(secs) ? Math.min(secs * 1000, 30_000) : 1000 * 2 ** attempt;
      console.warn(`[${label}] 429 — create refused, retrying in ${wait}ms (attempt ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('crmWriteback: unreachable');
}

// ─── Pure: shapes ─────────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const idStr = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
};
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface HubspotTargets {
  /** HubSpot deal ids (the `deal_hubspot` identifier). Two when the rep answered "both". */
  dealIds: string[];
  /** HubSpot company id (the `hubspot_company` identifier on the account). */
  companyId: string | null;
  /** HubSpot contact ids (the `hubspot` identifier on the people the email goes to). */
  contactIds: string[];
}

export interface WritebackTask {
  id: string; text: string; due: string | null; quote?: string | null;
  /** Approved earlier and ticked done in Nous before it synced: it lands in HubSpot completed. */
  done?: boolean;
}
export interface WritebackUpdate { id: string; label: string; value: string }
export interface WritebackMeeting { title?: string | null; kind?: string | null; at?: string | null }

export interface FollowUpSyncState {
  /** Nous card task id → HubSpot task id. */
  tasks: Record<string, string>;
  /** The one HubSpot note the approved updates became. */
  note: string | null;
  [k: string]: unknown;
}

type Association = { to: { id: string }; types: Array<{ associationCategory: 'HUBSPOT_DEFINED'; associationTypeId: number }> };

/**
 * The `associations` block of a create: every deal, the company, and (when asked) the people.
 * Pure. Blanks and duplicates are dropped; ids are sent as strings.
 */
export function hubspotAssociationsFor(
  typeIds: { deal: number; company: number; contact: number },
  targets: HubspotTargets,
  { contacts = true }: { contacts?: boolean } = {},
): Association[] {
  const out: Association[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, typeId: number) => {
    const v = idStr(id);
    if (!v) return;
    const key = `${typeId}:${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ to: { id: v }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] });
  };
  for (const d of targets.dealIds ?? []) add(d, typeIds.deal);
  add(targets.companyId, typeIds.company);
  if (contacts) for (const c of (targets.contactIds ?? []).slice(0, MAX_CONTACTS)) add(c, typeIds.contact);
  return out;
}

/** Whether a card has anywhere to land in HubSpot. A task or note on nothing is an orphan. */
export function hasHubspotTarget(t: HubspotTargets): boolean {
  return !!(t.dealIds?.length || t.companyId || t.contactIds?.length);
}

/** The offset of `timeZone` from UTC at an instant, in ms (positive east of Greenwich). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** A civil date at a wall-clock hour in a zone, as an instant. An unknown zone reads as UTC. */
export function zonedInstant(isoDate: string, hour: number, timeZone?: string): Date | null {
  const m = typeof isoDate === 'string' ? isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], hour, 0, 0);
  if (!timeZone || timeZone.toUpperCase() === 'UTC') return new Date(guess);
  try {
    // Twice: the offset that matters is the one at the answer, which differs from the guess's
    // on the night the clocks change.
    let t = guess - zoneOffsetMs(new Date(guess), timeZone);
    t = guess - zoneOffsetMs(new Date(t), timeZone);
    return new Date(t);
  } catch {
    return new Date(guess);
  }
}

/** The next weekday after `now`'s date in the zone, as YYYY-MM-DD. */
export function nextBusinessDay(now: Date, timeZone?: string): string {
  let d = shiftIsoDate(isoDateIn(now, timeZone) ?? now.toISOString().slice(0, 10), 1) as string;
  for (let i = 0; i < 3; i++) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) break;
    d = shiftIsoDate(d, 1) as string;
  }
  return d;
}

/**
 * When a HubSpot task is due (`hs_timestamp`, which HubSpot requires): the due date at 9:00 in the
 * workspace's zone, or with no date, 9:00 on the next business day. A date says the day; it never
 * said midnight, and a task due at midnight shows as overdue for the whole of its due day.
 */
export function taskDueAt(due: string | null | undefined, timeZone: string | undefined, now: Date = new Date()): Date {
  const tz = timeZone || defaultTimeZone();
  return zonedInstant(due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : nextBusinessDay(now, tz), 9, tz) ?? new Date(now.getTime() + 864e5);
}

/** "Pricing call, Oct 3, 2026": the meeting a task or note came from, as a person would name it. */
export function meetingLabel(m: WritebackMeeting | null | undefined, timeZone?: string): string {
  const name = (m?.title && String(m.title).trim()) || (m?.kind && String(m.kind).trim()) || 'the meeting';
  let when = '';
  if (m?.at) {
    const at = new Date(m.at);
    if (!Number.isNaN(at.getTime())) {
      try { when = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timeZone || defaultTimeZone() }); }
      catch { when = at.toISOString().slice(0, 10); }
    }
  }
  return when ? `${name}, ${when}` : name;
}

/** A task's properties. HubSpot returns only what is named and stores only what is sent. */
export function hubspotTaskProperties({ task, meeting, ownerId, timeZone, now = new Date() }: {
  task: WritebackTask; meeting?: WritebackMeeting | null; ownerId?: string | null; timeZone?: string; now?: Date;
}): Record<string, string> {
  const quote = typeof task.quote === 'string' && task.quote.trim() ? task.quote.trim() : null;
  const body = [
    quote ? `<p>“${escapeHtml(quote)}”</p>` : '',
    `<p>From: ${escapeHtml(meetingLabel(meeting, timeZone))} via Nous</p>`,
  ].join('');
  const props: Record<string, string> = {
    hs_task_subject: clip(String(task.text ?? '').trim() || 'Follow-up', 250),
    hs_task_body: body,
    hs_timestamp: taskDueAt(task.due, timeZone, now).toISOString(),
    hs_task_status: task.done ? 'COMPLETED' : 'NOT_STARTED',
    hs_task_type: 'TODO',
  };
  if (ownerId) props.hubspot_owner_id = String(ownerId);
  return props;
}

/** The one note the approved updates become: a short list, and where it came from. */
export function hubspotNoteProperties({ updates, meeting, approverName, timeZone, now = new Date() }: {
  updates: WritebackUpdate[]; meeting?: WritebackMeeting | null; approverName?: string | null; timeZone?: string; now?: Date;
}): Record<string, string> {
  const items = updates.map((u) => `<li>${escapeHtml(u.label || 'Note')}: ${escapeHtml(u.value)}</li>`).join('');
  return {
    hs_note_body: [
      `<p><strong>Follow-up from ${escapeHtml(meetingLabel(meeting, timeZone))}</strong></p>`,
      `<ul>${items}</ul>`,
      `<p>Approved${approverName ? ` by ${escapeHtml(approverName)}` : ''} via Nous</p>`,
    ].join(''),
    hs_timestamp: now.toISOString(),
  };
}

/** follow_ups.verdict.sync as a clean map. Anything unreadable is "not synced yet". */
export function readSyncState(verdict: unknown): FollowUpSyncState {
  const s = obj(obj(verdict)?.sync) ?? {};
  const tasks: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(s.tasks) ?? {})) { const id = idStr(v); if (id) tasks[k] = id; }
  return { ...s, tasks, note: idStr(s.note) };
}

/** The approved updates, as the card holds them, in the card's order. */
export function approvedUpdates(content: unknown, updateIds: string[]): WritebackUpdate[] {
  const want = new Set((updateIds ?? []).map(String));
  return arr(obj(content)?.updates)
    .filter((u) => obj(u) && want.has(String(u.id)) && typeof u.value === 'string' && u.value.trim())
    .map((u) => ({ id: String(u.id), label: typeof u.label === 'string' && u.label.trim() ? u.label.trim() : 'Note', value: u.value.trim() }));
}

/** The Nous deals a card is filed on: the one it names, or both options when the rep said "both". */
export function dealEntityIdsOf(card: { deal_entity_id?: string | null; content?: unknown }): string[] {
  if (card.deal_entity_id) return [card.deal_entity_id];
  const a = obj(obj(card.content)?.attribution);
  if (a?.chosen === 'both') return [...new Set(arr(a.options).map((o) => idStr(o?.id)).filter((id): id is string => !!id && UUID.test(id)))];
  return [];
}

const lastMeeting = (meetings: unknown): WritebackMeeting | null => {
  const ms = arr(meetings).filter((m) => obj(m)).slice().sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  return ms[ms.length - 1] ?? null;
};

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Is write-back on for this workspace. A missing row, or the column before its migration, reads as off. */
export async function crmWritebackEnabled(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await (supabase as any).from('follow_up_settings')
      .select('crm_writeback').eq('workspace_id', workspaceId).maybeSingle();
    if (error) return false;
    return data?.crm_writeback === true;
  } catch { return false; }
}

/** The workspace's HubSpot token, read the way the CRM sync reads it. Null when not connected. */
export async function hubspotWritebackToken(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  return hubspotToken(supabase, workspaceId);
}

/** Where a card lands in HubSpot: its deals, the account's company, and the email's people. Read only. */
export async function resolveHubspotTargets(
  supabase: SupabaseClient,
  workspaceId: string,
  card: { account_entity_id?: string | null; deal_entity_id?: string | null; content?: unknown },
): Promise<HubspotTargets> {
  const sb = supabase as any;
  const ident = async (kind: string, entityIds: string[]): Promise<Array<{ entity_id: string; value: string }>> => {
    if (!entityIds.length) return [];
    const { data, error } = await sb.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', kind).eq('status', 'active').in('entity_id', entityIds);
    if (error) throw new Error(`hubspot ids (${kind}): ${error.message}`);
    return (data ?? []) as Array<{ entity_id: string; value: string }>;
  };

  const dealEntityIds = dealEntityIdsOf(card);
  const [deals, company] = await Promise.all([
    ident('deal_hubspot', dealEntityIds),
    card.account_entity_id ? ident('hubspot_company', [card.account_entity_id]) : Promise.resolve([]),
  ]);

  // The people the follow-up is for: the email's recipients, as HubSpot contacts. A recipient
  // HubSpot does not hold is simply not associated; the task still lands on the deal and company.
  const emails = [...new Set(arr(obj(obj(card.content)?.email)?.to)
    .filter((e) => typeof e === 'string' && e.includes('@')).map((e: string) => e.trim().toLowerCase()))].slice(0, MAX_CONTACTS);
  let contactIds: string[] = [];
  if (emails.length) {
    const { data: people, error } = await sb.from('entity_identifiers').select('entity_id')
      .eq('workspace_id', workspaceId).eq('kind', 'email').eq('status', 'active').in('value', emails);
    if (error) throw new Error(`people by email: ${error.message}`);
    const ids = [...new Set(((people ?? []) as Array<{ entity_id: string }>).map((p) => p.entity_id))];
    contactIds = (await ident('hubspot', ids)).map((r) => String(r.value));
  }

  return {
    dealIds: [...new Set(deals.map((d) => String(d.value)).filter(Boolean))],
    companyId: company[0]?.value ? String(company[0].value) : null,
    contactIds: [...new Set(contactIds.filter(Boolean))],
  };
}

/**
 * A HubSpot owner id for an email, through GET /crm/v3/owners?email=. Cached per run (pass the
 * same Map). Null when HubSpot has no such user or the read fails: an unowned task is better
 * than no task.
 */
export async function hubspotOwnerIdByEmail(token: string, email: string | null | undefined, cache: Map<string, string | null> = new Map()): Promise<string | null> {
  const key = String(email ?? '').trim().toLowerCase();
  if (!key || !key.includes('@')) return null;
  if (cache.has(key)) return cache.get(key) ?? null;
  let id: string | null = null;
  try {
    const res = await crmFetch(`${HS}/crm/v3/owners?email=${encodeURIComponent(key)}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    }, 'HubSpot owners');
    if (res.ok) {
      const d: any = await res.json().catch(() => null);
      const rows = arr(d?.results);
      const hit = rows.find((o) => String(o?.email ?? '').toLowerCase() === key) ?? rows[0];
      id = idStr(hit?.id);
    }
  } catch { /* unowned, not failed */ }
  cache.set(key, id);
  return id;
}

/** The value a Nous task holds now: the claim when it is derived, else the newest observation. */
export async function currentTaskValue(supabase: SupabaseClient, workspaceId: string, entityId: string, property: string): Promise<Record<string, any> | null> {
  const sb = supabase as any;
  const { data: claim } = await sb.from('claims').select('value')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('property', property).is('invalid_at', null).maybeSingle();
  if (obj(claim?.value)) return claim.value;
  // The claim is derived from a queue, so straight after an approval it may not exist yet.
  const { data: rows } = await sb.from('observations').select('value')
    .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('property', property).eq('kind', 'state')
    .order('observed_at', { ascending: false }).limit(1);
  return obj(rows?.[0]?.value);
}

/**
 * Put the HubSpot task id on the Nous task, through an observation like every other write: the
 * task's whole current value plus `hubspot_task_id`. The external id makes a retry a no-op.
 * @returns true when it wrote.
 */
export async function stampHubspotTaskId(supabase: SupabaseClient, { workspaceId, entityId, property, hubspotTaskId, externalId, at }: {
  workspaceId: string; entityId: string; property: string; hubspotTaskId: string; externalId: string; at?: string;
}): Promise<boolean> {
  const current = await currentTaskValue(supabase, workspaceId, entityId, property);
  if (!current) return false;
  if (String(current.hubspot_task_id ?? '') === String(hubspotTaskId)) return false;
  const obs = await recordObservation(supabase, {
    workspaceId, entityId, kind: 'state', property,
    value: { ...current, hubspot_task_id: String(hubspotTaskId) },
    source: 'nous:follow_up', method: 'manual', externalId,
    observedAt: at ?? new Date().toISOString(),
  });
  return !!obs;
}

// ─── The system log ─────────────────────────────────────────────────────────

async function logWriteback(supabase: SupabaseClient | undefined, workspaceId: string, eventType: string, summary: string, metadata: Record<string, unknown> = {}, userId: string | null = null): Promise<void> {
  if (!supabase) return;
  try {
    await (supabase as any).from('workspace_system_log').insert({
      workspace_id: workspaceId, source: 'hubspot', event_type: eventType, summary,
      metadata: { via: 'follow_up_writeback', ...metadata }, ...(userId ? { user_id: userId } : {}),
    });
  } catch (err: any) {
    console.warn('[CRM_WRITEBACK] system_log write failed:', err?.message || err);
  }
}

// ─── Creating ───────────────────────────────────────────────────────────────

type CreateOutcome =
  | { kind: 'created'; id: string; droppedContacts: boolean }
  | { kind: 'denied'; status: number; message: string }
  | { kind: 'failed'; status: number | null; message: string };

async function readError(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  try { const j = JSON.parse(t); return String(j?.message ?? t).slice(0, 300); } catch { return t.slice(0, 300); }
}

/**
 * One create. A 400/404 with people attached is retried once without them: a contact merged or
 * deleted in HubSpot since the last sync must not cost the rep the task itself.
 */
async function createObject(token: string, object: 'tasks' | 'notes', properties: Record<string, string>, typeIds: { deal: number; company: number; contact: number }, targets: HubspotTargets, withContacts: boolean): Promise<CreateOutcome> {
  const attempt = async (contacts: boolean): Promise<CreateOutcome & { retryable?: boolean }> => {
    let res: Response;
    try {
      res = await hubspotWrite(token, 'POST', `/crm/v3/objects/${object}`, {
        properties, associations: hubspotAssociationsFor(typeIds, targets, { contacts }),
      }, `HubSpot writeback ${object}`);
    } catch (err: any) {
      return { kind: 'failed', status: null, message: String(err?.message || err).slice(0, 300) };
    }
    if (res.ok) {
      const d: any = await res.json().catch(() => null);
      const id = idStr(d?.id);
      return id ? { kind: 'created', id, droppedContacts: withContacts && !contacts }
        : { kind: 'failed', status: res.status, message: 'HubSpot answered without an id' };
    }
    const message = await readError(res);
    if (res.status === 401 || res.status === 403) return { kind: 'denied', status: res.status, message };
    return { kind: 'failed', status: res.status, message, retryable: res.status === 400 || res.status === 404 };
  };
  const hasContacts = withContacts && (targets.contactIds?.length ?? 0) > 0;
  const first = await attempt(hasContacts);
  if (first.kind === 'failed' && first.retryable && hasContacts) return attempt(false);
  return first;
}

// ─── The sync ───────────────────────────────────────────────────────────────

export interface WritebackFailure {
  kind: 'task' | 'note';
  id: string | null;
  error: string;
  message: string;
  status?: number | null;
}

export interface WritebackResult {
  sync: FollowUpSyncState;
  created: { tasks: string[]; note: string | null };
  failed: WritebackFailure[];
  /** Every approved task and the note (when there were updates) is in HubSpot. */
  complete: boolean;
  error?: typeof WRITEBACK_NOT_ALLOWED;
  message?: string;
  targets?: HubspotTargets;
}

export interface SyncFollowUpInput {
  supabase?: SupabaseClient;
  workspaceId: string;
  card: { id: string; account_entity_id?: string | null; deal_entity_id?: string | null; content?: unknown; meetings?: unknown; verdict?: unknown };
  /** What the rep approved: the filed tasks as filed (edited text, due date) and the update ids. */
  approved: { tasks: WritebackTask[]; updateIds: string[] };
  token: string;
  /** Who the tasks belong to, in order: the approver, then the card's reviewer. */
  ownerEmails?: Array<string | null | undefined>;
  /** Per-run owner cache (email → HubSpot owner id). */
  ownerByEmail?: Map<string, string | null>;
  /** Skip the identifier reads (tests, or a caller that already has them). */
  targets?: HubspotTargets;
  timeZone?: string;
  approverName?: string | null;
  approverId?: string | null;
  /** Called with the sync map after every successful create. Defaults to writing follow_ups.verdict. */
  persist?: (sync: FollowUpSyncState) => Promise<void>;
  now?: Date;
}

/** Write the sync map onto the card. Throws: an id HubSpot gave us that we cannot keep must stop the run. */
export async function persistFollowUpSync(supabase: SupabaseClient, workspaceId: string, cardId: string, baseVerdict: unknown, sync: FollowUpSyncState): Promise<void> {
  const { error } = await (supabase as any).from('follow_ups')
    .update({ verdict: { ...(obj(baseVerdict) ?? {}), sync }, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId).eq('id', cardId);
  if (error) throw new Error(`follow-up sync state: ${error.message}`);
}

/**
 * Sync one approved card's tasks and updates to HubSpot. Never throws on a HubSpot answer: every
 * refusal comes back in `failed` (and `error` for missing write access), with the ids of whatever
 * did land already persisted, so the next press picks up where this one stopped.
 */
export async function syncFollowUpToHubspot(input: SyncFollowUpInput): Promise<WritebackResult> {
  const { supabase, workspaceId, card, approved, token } = input;
  const now = input.now ?? new Date();
  const sync = readSyncState(card.verdict);
  const result: WritebackResult = { sync, created: { tasks: [], note: null }, failed: [], complete: false };

  const pendingTasks = (approved.tasks ?? []).filter((t) => t && t.id && !sync.tasks[t.id]);
  const updates = approvedUpdates(card.content, approved.updateIds ?? []);
  const wantNote = updates.length > 0 && !sync.note;
  if (!pendingTasks.length && !wantNote) { result.complete = true; return result; }

  const persist = input.persist ?? (supabase
    ? (s: FollowUpSyncState) => persistFollowUpSync(supabase, workspaceId, card.id, card.verdict, s)
    : async () => {});

  const targets = input.targets ?? (supabase ? await resolveHubspotTargets(supabase, workspaceId, card) : { dealIds: [], companyId: null, contactIds: [] });
  result.targets = targets;
  const pendingFailures = (error: string, message: string, status: number | null = null): WritebackFailure[] => [
    ...pendingTasks.filter((t) => !sync.tasks[t.id] && !result.failed.some((f) => f.kind === 'task' && f.id === t.id))
      .map((t) => ({ kind: 'task' as const, id: t.id, error, message, status })),
    ...(wantNote && !sync.note ? [{ kind: 'note' as const, id: null, error, message, status }] : []),
  ];

  if (!hasHubspotTarget(targets)) {
    result.failed.push(...pendingFailures('not_in_hubspot', 'This account has no deal or company in HubSpot yet, so there is nothing to file it on.'));
    await logWriteback(supabase, workspaceId, 'writeback_failed', 'Follow-up not synced: the account is not in HubSpot', { follow_up_id: card.id }, input.approverId ?? null);
    return result;
  }

  const timeZone = input.timeZone || defaultTimeZone();
  const meeting = lastMeeting(card.meetings);
  const denied = async (status: number, message: string) => {
    result.error = WRITEBACK_NOT_ALLOWED;
    result.message = WRITEBACK_NOT_ALLOWED_MESSAGE;
    result.failed.push(...pendingFailures(WRITEBACK_NOT_ALLOWED, WRITEBACK_NOT_ALLOWED_MESSAGE, status));
    await logWriteback(supabase, workspaceId, 'writeback_not_allowed',
      `HubSpot refused the follow-up write (${status}): grant write access to tasks and notes`,
      { follow_up_id: card.id, status, hubspot_message: message }, input.approverId ?? null);
    return result;
  };

  // The owner: the first email HubSpot knows as a user. Read once per run, and only when a task needs it.
  let ownerId: string | null = null;
  if (pendingTasks.length) {
    const cache = input.ownerByEmail ?? new Map<string, string | null>();
    for (const e of input.ownerEmails ?? []) {
      ownerId = await hubspotOwnerIdByEmail(token, e, cache);
      if (ownerId) break;
    }
  }

  for (const t of pendingTasks) {
    const out = await createObject(token, 'tasks', hubspotTaskProperties({ task: t, meeting, ownerId, timeZone, now }), HUBSPOT_TASK_ASSOC, targets, true);
    if (out.kind === 'denied') return denied(out.status, out.message);
    if (out.kind === 'failed') {
      result.failed.push({ kind: 'task', id: t.id, error: 'hubspot_error', message: out.message, status: out.status });
      await logWriteback(supabase, workspaceId, 'writeback_failed', `HubSpot task not created: ${clip(t.text, 80)} (${out.status ?? 'network'})`,
        { follow_up_id: card.id, task_id: t.id, status: out.status, hubspot_message: out.message }, input.approverId ?? null);
      continue;
    }
    sync.tasks[t.id] = out.id;
    result.created.tasks.push(t.id);
    await persist(sync);
    await logWriteback(supabase, workspaceId, 'writeback_task_created', `Task synced to HubSpot: ${clip(t.text, 80)}`,
      { follow_up_id: card.id, task_id: t.id, hubspot_task_id: out.id, dropped_contacts: out.droppedContacts }, input.approverId ?? null);
  }

  if (wantNote) {
    // Deal and company only: an update is about the deal, and every contact on it already shows the deal's notes.
    const out = await createObject(token, 'notes', hubspotNoteProperties({ updates, meeting, approverName: input.approverName, timeZone, now }), HUBSPOT_NOTE_ASSOC, targets, false);
    if (out.kind === 'denied') return denied(out.status, out.message);
    if (out.kind === 'failed') {
      result.failed.push({ kind: 'note', id: null, error: 'hubspot_error', message: out.message, status: out.status });
      await logWriteback(supabase, workspaceId, 'writeback_failed', `HubSpot note not created (${out.status ?? 'network'})`,
        { follow_up_id: card.id, status: out.status, hubspot_message: out.message }, input.approverId ?? null);
    } else {
      sync.note = out.id;
      result.created.note = out.id;
      await persist(sync);
      await logWriteback(supabase, workspaceId, 'writeback_note_created', `Note synced to HubSpot (${updates.length} ${updates.length === 1 ? 'update' : 'updates'})`,
        { follow_up_id: card.id, hubspot_note_id: out.id }, input.approverId ?? null);
    }
  }

  result.complete = result.failed.length === 0;
  return result;
}

// ─── Ticking a task done ─────────────────────────────────────────────────────

/**
 * The HubSpot task behind a Nous task: on its value, or, while the claim has not caught up with
 * the stamp observation yet, on the newest observation that carries one. Only follow-up tasks
 * can have one, so anything else answers without a read.
 */
export async function hubspotTaskIdOf(supabase: SupabaseClient, workspaceId: string, entityId: string, property: string, value: unknown): Promise<string | null> {
  const direct = idStr(obj(value)?.hubspot_task_id);
  if (direct) return direct;
  if (!String(property).startsWith('action_item.followup_')) return null;
  try {
    const { data } = await (supabase as any).from('observations').select('value')
      .eq('workspace_id', workspaceId).eq('entity_id', entityId).eq('property', property)
      .not('value->>hubspot_task_id', 'is', null)
      .order('observed_at', { ascending: false }).limit(1);
    return idStr(obj(data?.[0]?.value)?.hubspot_task_id);
  } catch { return null; }
}

/**
 * Mirror a Nous tick onto the HubSpot task Nous created: done → COMPLETED, reopened →
 * NOT_STARTED. Only the status; never anything else on the task, never a deal. Best-effort: the
 * tick in Nous stands whatever HubSpot says.
 */
export async function syncTaskStatusToHubspot({ supabase, workspaceId, hubspotTaskId, done, token }: {
  supabase: SupabaseClient; workspaceId: string; hubspotTaskId: string | null | undefined; done: boolean; token?: string | null;
}): Promise<{ ok: boolean; skipped?: string; status?: number }> {
  const id = idStr(hubspotTaskId);
  if (!id || !/^\d+$/.test(id)) return { ok: false, skipped: 'no_hubspot_task' };
  if (!(await crmWritebackEnabled(supabase, workspaceId))) return { ok: false, skipped: 'writeback_off' };
  const tk = token ?? await hubspotToken(supabase, workspaceId);
  if (!tk) return { ok: false, skipped: 'no_hubspot' };
  const hs_task_status = done ? 'COMPLETED' : 'NOT_STARTED';
  let res: Response;
  try {
    res = await hubspotWrite(tk, 'PATCH', `/crm/v3/objects/tasks/${id}`, { properties: { hs_task_status } }, 'HubSpot writeback task status');
  } catch (err: any) {
    await logWriteback(supabase, workspaceId, 'writeback_failed', `HubSpot task ${id} not updated: ${String(err?.message || err).slice(0, 120)}`, { hubspot_task_id: id, hs_task_status });
    return { ok: false };
  }
  if (!res.ok) {
    const message = await readError(res);
    const denied = res.status === 401 || res.status === 403;
    await logWriteback(supabase, workspaceId, denied ? 'writeback_not_allowed' : 'writeback_failed',
      denied ? 'HubSpot refused the task update: grant write access to tasks' : `HubSpot task ${id} not updated (${res.status})`,
      { hubspot_task_id: id, hs_task_status, status: res.status, hubspot_message: message });
    return { ok: false, status: res.status };
  }
  await logWriteback(supabase, workspaceId, 'writeback_task_status', `HubSpot task ${done ? 'completed' : 'reopened'} from Nous`, { hubspot_task_id: id, hs_task_status });
  return { ok: true, status: res.status };
}
