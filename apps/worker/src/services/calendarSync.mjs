// Google Calendar → the graph. The one path every calendar event takes (GET-221).
//
// The calendar is STATE, not a stream of events. What matters is what is on it right now:
// the call on Monday, the one that moved to Tuesday, the one that got cancelled. A push
// trigger can only ever tell you "something was created" — it cannot tell you about a move
// or a cancellation, and when its payload shape changes it drops everything silently. That
// is exactly what happened: from the Composio cutover (2026-09-01) to 2026-09-13 not one
// calendar event reached the graph, while the connection read "verified".
//
// So the design is:
//   1. A window SCAN is the source of truth. Every connected calendar is read through Composio
//      (GOOGLECALENDAR_EVENTS_LIST, the Google event shape) over [-1d, +30d] on a schedule,
//      and each event is reconciled into observations. Dedup is by external id, so a scan that
//      finds nothing new writes nothing.
//   2. The Composio trigger is a NUDGE: "this calendar changed, scan it now". It never parses
//      the trigger payload for event fields, so a payload-shape change cannot drop an event.
//   3. Every scan stamps `last_used_at` on the connection. The nightly invariant
//      `connection_not_syncing` reads that stamp, so a calendar that stops syncing is
//      found the next morning, not two weeks later.
//
// What one event becomes: an `interaction.meeting_scheduled` / `meeting_held` observation on
// every EXTERNAL person in it — which is what Home, Tasks and the agent's `calendar` tool read.
// Ported from the retired native poller (pollers/calendar.mjs, deleted in 6bb6932) and the
// rules it had earned: our own team is never a lead, scheduler/no-reply addresses are not
// people, a moved meeting drops a marker on the old slot.
//
// Who gets a record: an attendee already in the graph always does. A NEW attendee is created
// only when their email domain belongs to a company the workspace already tracks — Corin Ashdale at
// harborline.example joins the Harborline account; a random vendor on a random domain does not become
// a lead because they sent an invite. Personal mailboxes (gmail.com, …) are never created.

import { getSupabaseClient, getInternalIdentities, getInternalEntityIds, isFreeEmailDomain } from '@nous/core';
import { logActivity } from '../utils/activity.mjs';
import { resolveContact } from '../utils/resolveContact.mjs';
import { googleClientFor, hasGoogleTransport, noClientError, nativeConnections } from '../utils/googleClient.mjs';
import {
  normalizeCalendarEvent, externalAttendees, meetingKind, emailDomainOf, likeEscape, calendarListArgs,
} from '../utils/calendarEvent.mjs';

const DAY = 86_400_000;
export const LOOKBACK_DAYS = 1;
export const LOOKAHEAD_DAYS = 30;
const PAGE_SIZE = 50;     // Composio caps the page; more pages follow nextPageToken
const MAX_PAGES = 10;

// ── Workspace context ─────────────────────────────────────────────────────────

async function loadInternal(supabase, workspaceId) {
  const internal = new Set();
  const internalDomains = new Set();
  let internalEntityIds = new Set();
  try {
    for (const idy of await getInternalIdentities(supabase, workspaceId)) {
      if (idy.kind !== 'email' || !idy.value) continue;
      const e = idy.value.trim().toLowerCase();
      internal.add(e);
      const d = emailDomainOf(e);
      if (d && !isFreeEmailDomain(d)) internalDomains.add(d);
    }
    internalEntityIds = new Set(await getInternalEntityIds(supabase, workspaceId));
  } catch (e) {
    console.warn('[CALENDAR] internal identities unavailable:', e.message);
  }
  return { internal, internalDomains, internalEntityIds };
}

/** Which of these domains belong to a company the workspace already tracks. */
async function knownCompanyDomains(supabase, workspaceId, domains) {
  const list = [...new Set(domains.filter(d => d && !isFreeEmailDomain(d)))];
  if (!list.length) return new Set();
  const { data } = await supabase.from('entity_identifiers')
    .select('value')
    .eq('workspace_id', workspaceId).eq('kind', 'domain').eq('status', 'active')
    .in('value', list);
  return new Set((data || []).map(r => r.value.toLowerCase()));
}

// ── One event ─────────────────────────────────────────────────────────────────

// A Google event keeps its id when moved. A moved start drops a "Rescheduled:" cancellation
// on the old slot (stage derivation and `getMeetings` both read that) and logs the new time.
async function recordMeeting(supabase, conn, event, contact, attendee) {
  const workspaceId = conn.workspace_id;
  const ownerUserId = conn.owner_user_id ?? null;
  const { type, label } = meetingKind(event, attendee);
  const stableExtId = `gcal_${event.id}_${contact.id}`;
  const startKey = event.start.slice(0, 16);

  const { data: prior } = await supabase.from('observations')
    .select('observed_at, external_id, property')
    .eq('workspace_id', workspaceId)
    .eq('source', 'google_calendar')
    .eq('entity_id', contact.id)
    .like('external_id', `${likeEscape(stableExtId)}%`)
    .in('property', ['interaction.meeting_scheduled', 'interaction.meeting_held'])
    .order('ingested_at', { ascending: false })
    .limit(1);
  const last = prior?.[0] || null;
  const lastKey = last ? new Date(last.observed_at).toISOString().slice(0, 16) : null;

  let externalId = stableExtId;
  if (last && lastKey !== startKey) {
    await logActivity(supabase, {
      workspaceId, contactId: contact.id, companyId: contact.company_id || null,
      type: 'meeting_cancelled', source: 'google_calendar',
      externalId: `gcal_resched_${event.id}_${contact.id}_${lastKey}`,
      occurredAt: last.observed_at, description: `Rescheduled: ${event.summary}`,
      ownerUserId, suppressExtraction: true,
    });
    externalId = `${stableExtId}_${startKey}`;
  } else if (last) {
    externalId = last.external_id;
    // Same slot, same kind → already recorded. A scheduled meeting that has since happened
    // falls through and records the held one under its own id.
    if (last.property === `interaction.${type}`) return 0;
    if (type === 'meeting_held') externalId = `${stableExtId}_held`;
  }

  const result = await logActivity(supabase, {
    workspaceId, contactId: contact.id, companyId: contact.company_id || null,
    type, source: 'google_calendar', externalId, occurredAt: event.start,
    description: `${event.summary} ${label}`,
    ownerUserId,
    // A calendar invite carries a title, not a conversation. Nothing to extract, and each
    // extraction is a paid model call per attendee per event.
    suppressExtraction: true,
    rawData: {
      event_id: event.id, summary: event.summary, start_time: event.start,
      organizer_email: event.organizerEmail, attendee_emails: event.attendees.map(a => a.email),
      response_status: attendee?.responseStatus ?? null,
    },
  });
  return result ? 1 : 0;
}

// Google returns a deleted event with little more than its id and `status: 'cancelled'` — no
// attendees, often no start. So a cancellation is matched on what we RECORDED for that event
// id, not on the event's own fields: every person we logged it against gets the cancellation
// at the slot we logged.
async function recordCancellationByEventId(supabase, conn, eventId, summary) {
  const { data: rows } = await supabase.from('observations')
    .select('entity_id, observed_at, ingested_at')
    .eq('workspace_id', conn.workspace_id).eq('source', 'google_calendar')
    .like('external_id', `${likeEscape(`gcal_${eventId}_`)}%`)
    .eq('property', 'interaction.meeting_scheduled')
    .order('ingested_at', { ascending: false })
    .limit(50);
  if (!rows?.length) return 0;   // never saw it scheduled — nothing to cancel

  const latestPerPerson = new Map();
  for (const r of rows) if (!latestPerPerson.has(r.entity_id)) latestPerPerson.set(r.entity_id, r);

  let logged = 0;
  for (const [entityId, r] of latestPerPerson) {
    // Only upcoming slots. A past meeting that shows as deleted today was cleaned up, not
    // called off, and must not rewrite a held meeting's history.
    if (new Date(r.observed_at).getTime() < Date.now()) continue;
    const externalId = `gcal_cancel_${eventId}_${entityId}_${new Date(r.observed_at).toISOString().slice(0, 16)}`;
    const { data: done } = await supabase.from('observations').select('id')
      .eq('workspace_id', conn.workspace_id).eq('source', 'google_calendar').eq('external_id', externalId).limit(1);
    if (done?.length) continue;
    const result = await logActivity(supabase, {
      workspaceId: conn.workspace_id, contactId: entityId,
      type: 'meeting_cancelled', source: 'google_calendar', externalId,
      occurredAt: r.observed_at, description: `Cancelled: ${summary || 'Calendar meeting'}`,
      ownerUserId: conn.owner_user_id ?? null, suppressExtraction: true,
    });
    if (result) logged++;
  }
  return logged;
}

/**
 * Reconcile one event into the graph. Returns counts, never throws on a single attendee.
 * `ctx` is the per-scan workspace context from loadScanContext().
 */
export async function recordCalendarEvent(supabase, conn, rawEvent, ctx) {
  const out = { logged: 0, matched: 0, created: 0, skipped: {} };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };

  if (rawEvent?.status === 'cancelled' && rawEvent?.id) {
    out.logged += await recordCancellationByEventId(supabase, conn, String(rawEvent.id), rawEvent.summary);
    return out;
  }

  const event = normalizeCalendarEvent(rawEvent);
  if (!event) { skip('unparseable'); return out; }
  if (event.allDay) { skip('all_day'); return out; }

  const people = externalAttendees(event, { ...ctx, ownEmail: ctx.ownEmail || event.selfEmail });
  if (!people.length) { skip('no_external_attendees'); return out; }

  const domains = await knownCompanyDomains(supabase, conn.workspace_id, people.map(p => emailDomainOf(p.email)));

  for (const person of people) {
    try {
      const domain = emailDomainOf(person.email);
      const mayCreate = !!domain && domains.has(domain);
      const [first, ...rest] = (person.name || '').trim().split(/\s+/);
      const { contact, created } = await resolveContact(supabase, conn.workspace_id, {
        email: person.email,
        first_name: person.name ? first : undefined,
        last_name: person.name && rest.length ? rest.join(' ') : undefined,
        company_domain: mayCreate ? domain : undefined,
        source: 'google_calendar',
      }, { createIfMissing: mayCreate });

      if (!contact) { skip(domain && isFreeEmailDomain(domain) ? 'unknown_personal_email' : 'unknown_company'); continue; }
      if (ctx.internalEntityIds.has(contact.id)) { skip('internal'); continue; }
      out.matched++;
      if (created) out.created++;

      out.logged += await recordMeeting(supabase, conn, event, contact, person);
    } catch (e) {
      skip('error');
      console.warn(`[CALENDAR] event ${event.id} attendee failed:`, e.message);
    }
  }
  return out;
}

export async function loadScanContext(supabase, conn) {
  const internalCtx = await loadInternal(supabase, conn.workspace_id);
  return { ...internalCtx, ownEmail: conn.account_email ? conn.account_email.trim().toLowerCase() : null };
}

// ── One calendar ──────────────────────────────────────────────────────────────

async function listEvents(composio, conn, { timeMin, timeMax }) {
  const items = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await composio.tools.execute('GOOGLECALENDAR_EVENTS_LIST', {
      userId: String(conn.owner_user_id ?? ''),
      connectedAccountId: conn.composio_connection_id,
      arguments: calendarListArgs({ timeMin, timeMax, maxResults: PAGE_SIZE, pageToken }),
    });
    // A rejected action is `successful: false` with the reason in `error`. Reading past it
    // turns "the call failed" into "no meetings" — the exact silence this file exists to end.
    if (res?.successful === false) {
      throw new Error(String(res?.error || res?.data?.message || 'GOOGLECALENDAR_EVENTS_LIST rejected').slice(0, 300));
    }
    const out = res?.data || res?.response_data || {};
    const batch = out.items || out.events || (Array.isArray(out) ? out : []);
    if (Array.isArray(batch)) items.push(...batch);
    pageToken = out.nextPageToken || out.next_page_token || null;
    if (!pageToken) break;
  }
  return items;
}

/**
 * Scan one connected calendar over a window and reconcile every event.
 * `lookbackDays` > LOOKBACK_DAYS is a history backfill; the schedule uses the defaults.
 */
export async function syncCalendarConnection(supabase, conn, { lookbackDays = LOOKBACK_DAYS, lookaheadDays = LOOKAHEAD_DAYS } = {}) {
  // Composio or the install's own Google OAuth app (GET-765): the same reconcile either way.
  if (!hasGoogleTransport(conn)) return { ok: false, error: 'no composio_connection_id' };
  const composio = await googleClientFor(supabase, conn);
  if (!composio) return { ok: false, error: noClientError(conn) };

  const now = Date.now();
  let items;
  try {
    items = await listEvents(composio, conn, {
      timeMin: new Date(now - lookbackDays * DAY).toISOString(),
      timeMax: new Date(now + lookaheadDays * DAY).toISOString(),
    });
  } catch (e) {
    console.error(`[CALENDAR] connection=${conn.id} list failed:`, e.message);
    return { ok: false, error: e.message };
  }

  // The connection row often has no account_email (GET-173). Google marks the calendar owner
  // with `self: true` — take it from there, and write it back so internal-identity checks
  // (here, and Gmail's) recognise this person as ours.
  const ctx = await loadScanContext(supabase, conn);
  if (!ctx.ownEmail) {
    const selfEmail = items.map(normalizeCalendarEvent).find(e => e?.selfEmail)?.selfEmail || null;
    if (selfEmail) {
      ctx.ownEmail = selfEmail;
      ctx.internal.add(selfEmail);
      await supabase.from('workflow_provider_connections')
        .update({ account_email: selfEmail }).eq('id', conn.id).is('account_email', null)
        .then(null, () => {});
    }
  }

  const totals = { fetched: items.length, logged: 0, matched: 0, created: 0, skipped: {} };
  for (const raw of items) {
    const r = await recordCalendarEvent(supabase, conn, raw, ctx);
    totals.logged += r.logged;
    totals.matched += r.matched;
    totals.created += r.created;
    for (const [k, v] of Object.entries(r.skipped)) totals.skipped[k] = (totals.skipped[k] || 0) + v;
  }

  // The heartbeat the nightly `connection_not_syncing` invariant reads. Stamped on a
  // successful LIST, whether or not anything was new — a quiet week is not a broken sync.
  await supabase.from('workflow_provider_connections')
    .update({ last_used_at: new Date().toISOString() }).eq('id', conn.id).then(null, () => {});

  console.log(`[CALENDAR] connection=${conn.id} workspace=${conn.workspace_id}: ${totals.fetched} events, ${totals.logged} logged, ${totals.created} people created, skipped ${JSON.stringify(totals.skipped)}`);

  if (totals.logged > 0) {
    await supabase.from('workspace_system_log').insert({
      workspace_id: conn.workspace_id,
      source: 'calendar',
      event_type: 'scan_complete',
      summary: `Calendar: ${totals.logged} meeting update${totals.logged === 1 ? '' : 's'} (${totals.fetched} events read)`,
      metadata: { ...totals, lookback_days: lookbackDays, lookahead_days: lookaheadDays, owner_user_id: conn.owner_user_id ?? null },
      billable_ops: totals.logged,
      occurred_at: new Date().toISOString(),
    }).then(null, (e) => console.warn('[CALENDAR] system_log insert failed:', e?.message));
  }
  return { ok: true, ...totals };
}

// ── Every calendar ────────────────────────────────────────────────────────────

const CONN_COLS = 'id, workspace_id, owner_user_id, account_email, composio_connection_id, workflow_providers!inner(name)';

export async function syncAllCalendars() {
  const supabase = getSupabaseClient();
  const { data: conns, error } = await supabase
    .from('workflow_provider_connections').select(CONN_COLS)
    .eq('is_verified', true)
    .eq('managed_by', 'composio')
    .not('composio_connection_id', 'is', null)
    .eq('workflow_providers.name', 'google_calendar');
  if (error) { console.error('[CALENDAR] connections query failed:', error.message); return; }
  for (const conn of [...(conns || []), ...await nativeConnections(supabase, 'google_calendar')]) {
    try { await syncCalendarConnection(supabase, conn); }
    catch (e) { console.error(`[CALENDAR] connection=${conn.id}:`, e.message); }
  }
}

// A trigger says "this calendar changed". Several can land within seconds of each other
// (an invite, then its update), so coalesce them into one scan per connection.
const pending = new Map();
const NUDGE_DELAY_MS = 20_000;

export function nudgeCalendarSync(supabase, conn) {
  if (!conn?.id || pending.has(conn.id)) return;
  pending.set(conn.id, setTimeout(async () => {
    pending.delete(conn.id);
    try { await syncCalendarConnection(supabase, conn); }
    catch (e) { console.error(`[CALENDAR] nudge connection=${conn.id}:`, e.message); }
  }, NUDGE_DELAY_MS));
}
