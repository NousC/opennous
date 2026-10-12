// Count a new workspace's history AT THE SOURCE, before anything is filed (GET-549).
//
// The backfill estimate counts conversations already in our observations. On a new workspace
// nothing is filed until the backfill runs, so the estimate fell back to a projection from the
// CRM's size ("50 of 5,000 backfill credits") and the panel could not say what it had found. The
// panel now shows real numbers — emails, meetings — and recommends a plan from the last 30 days,
// so they are counted where they live:
//
//   Gmail      one search per 20 people (the same OR-batched query the backfill files with), and
//              Gmail's resultSizeEstimate — messages, collapsed to threads by the measured ratio.
//   Fireflies  the transcripts list since the window opened, paged; durations give meeting credits,
//              and the attendees say who the backfill will meet (GET-788).
//   Fathom     the meetings list, newest first, until a page reaches back past the window; the
//              recording length gives credits and the calendar invitees who it will meet (GET-817).
//
// Granola and Fellow are not counted: the confirmed backfill does not read them. Granola's first
// three months come in through its poller on connect, and Fellow is live-only (its history is a
// separate import, fellowBackfill.mjs).
//
// Counting reads metadata only: no message bodies, no model. Each source is best-effort — one
// that fails or is not connected is left out, never a reason to block the estimate.

import { CREDIT_SCALE, getInternalIdentities, isFreeEmailDomain } from '@nous/core';
import { decrypt } from '../providers/crypto.mjs';

// Messages per thread, measured on a customer workspace (roughly five messages for every three threads) — the same
// ratio historyBackfill.mjs collapses filed email by.
const MESSAGES_PER_THREAD = 1.64;
const MEETING_MINUTES_PER_CREDIT = 10;

/** Gmail searches for mail with any of these addresses, 20 per search (keep in step with the worker's gmailSync). */
export function addressQueries(addresses, days, chunk = 20) {
  const clean = [...new Set(addresses.map(a => String(a || '').trim().toLowerCase()).filter(a => a.includes('@')))];
  const out = [];
  for (let i = 0; i < clean.length; i += chunk) {
    const terms = clean.slice(i, i + chunk).flatMap(a => [`from:${a}`, `to:${a}`, `cc:${a}`]);
    out.push(`newer_than:${days}d {${terms.join(' ')}}`);
  }
  return out;
}

async function gmailThreads(supabase, workspaceId, addresses, days, ownerUserId = null) {
  let q = supabase.from('workflow_provider_connections')
    .select('id, account_email, owner_user_id, composio_connection_id, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId).eq('managed_by', 'composio').eq('is_verified', true)
    .not('composio_connection_id', 'is', null).eq('workflow_providers.name', 'gmail_oauth');
  // A member's backfill counts their own mailbox (GET-571).
  if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
  const { data: conns } = await q;
  if (!conns?.length) return null;
  const { loadComposioConfig, getComposioClient } = await import('../providers/composio.mjs');
  const cfg = await loadComposioConfig(supabase, workspaceId);
  if (!cfg?.apiKey) return null;
  const composio = getComposioClient(cfg.apiKey, cfg.baseUrl);
  let messages = 0;
  for (const conn of conns) {
    // The mailbox's own address is on every message in it; searching for it counts everything.
    const own = String(conn.account_email || '').toLowerCase();
    for (const q of addressQueries(addresses.filter(a => String(a).toLowerCase() !== own), days)) {
      const res = await composio.tools.execute('GMAIL_FETCH_EMAILS', {
        userId: String(conn.owner_user_id ?? ''), connectedAccountId: conn.composio_connection_id,
        arguments: { query: q, max_results: 1, include_payload: false },
      });
      if (res?.successful === false) throw new Error(String(res?.error || 'gmail search rejected').slice(0, 200));
      messages += Number(res?.data?.resultSizeEstimate ?? 0) || 0;
    }
  }
  return Math.round(messages / MESSAGES_PER_THREAD);
}

/** The newest verified note-taker key on the workspace (a member's own, for their backfill). */
async function noteTakerKey(supabase, workspaceId, provider, ownerUserId = null) {
  const { data: prov } = await supabase.from('workflow_providers').select('id').eq('name', provider).maybeSingle();
  if (!prov?.id) return null;
  let q = supabase.from('workflow_provider_connections')
    .select('encrypted_credentials').eq('workspace_id', workspaceId).eq('provider_id', prov.id)
    .eq('is_verified', true);
  if (ownerUserId) q = q.eq('owner_user_id', ownerUserId);
  const { data: conn } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  const enc = conn?.encrypted_credentials?.api_key;
  return enc ? decrypt(enc) : null;
}

/** One attendee into the map: an address, and a name when the note-taker had one. */
function addAttendee(attendees, email, name) {
  email = String(email ?? '').trim().toLowerCase();
  if (!email.includes('@')) return;
  name = String(name ?? '').trim();
  if (!attendees.has(email) || (name && !attendees.get(email))) attendees.set(email, name);
}

const creditsForMinutes = (minutes) => CREDIT_SCALE * Math.max(1, Math.ceil((Number(minutes) || 30) / MEETING_MINUTES_PER_CREDIT));

async function firefliesMeetings(supabase, workspaceId, days, ownerUserId = null) {
  const apiKey = await noteTakerKey(supabase, workspaceId, 'fireflies', ownerUserId);
  if (!apiKey) return null;
  const fromDate = new Date(Date.now() - days * 86_400_000).toISOString();
  let meetings = 0, credits = 0;
  const attendees = new Map(); // email → a name, when the note-taker had one
  for (let skip = 0; skip < 2000; skip += 50) {
    const res = await fetch('https://api.fireflies.ai/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: 'query T($from: DateTime, $skip: Int) { transcripts(fromDate: $from, limit: 50, skip: $skip) { id duration meeting_attendees { email displayName name } } }',
        variables: { from: fromDate, skip },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data?.errors?.length && !data?.data)) throw new Error(`fireflies_${res.status}`);
    const page = data?.data?.transcripts ?? [];
    for (const t of page) {
      meetings++;
      for (const a of t.meeting_attendees ?? []) addAttendee(attendees, a?.email, a?.displayName || a?.name);
      credits += creditsForMinutes(t.duration);
    }
    if (page.length < 50) break;
  }
  return { meetings, credits, attendees };
}

/**
 * Tally one page of Fathom's meetings list into { meetings, credits, attendees }, counting only
 * meetings that started inside the window. Returns whether to read the next page: not once a whole
 * page is older than the window. The backfill's replay (scanFathomReplay) reads the same list, 10 a
 * page, and stops at the same place.
 */
export function tallyFathomPage(items, fromMs, tally) {
  let older = 0;
  for (const m of items ?? []) {
    const start = Date.parse(m?.recording_start_time || m?.scheduled_start_time || '');
    if (Number.isFinite(start) && start < fromMs) { older++; continue; }
    tally.meetings++;
    const end = Date.parse(m?.recording_end_time || '');
    tally.credits += creditsForMinutes(Number.isFinite(start) && end > start ? (end - start) / 60_000 : null);
    for (const a of m?.calendar_invitees ?? []) addAttendee(tally.attendees, a?.email, a?.name);
  }
  // The list is in Fathom's own order, not strictly by start: one old meeting mid-list is skipped,
  // and only a page that is old all through ends the paging (the replay's rule).
  return !(items?.length && older === items.length);
}

async function fathomMeetings(supabase, workspaceId, days, ownerUserId = null) {
  const apiKey = await noteTakerKey(supabase, workspaceId, 'fathom', ownerUserId);
  if (!apiKey) return null;
  const fromMs = Date.now() - days * 86_400_000;
  const tally = { meetings: 0, credits: 0, attendees: new Map() };
  let cursor = null;
  // Metadata only, no transcript; 60 pages of 10 is the replay's own cap.
  for (let page = 0; page < 60; page++) {
    const url = `https://api.fathom.ai/external/v1/meetings?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
    if (!res.ok) throw new Error(`fathom_${res.status}`);
    const data = await res.json().catch(() => ({}));
    const more = tallyFathomPage(data?.items, fromMs, tally);
    cursor = data?.next_cursor || null;
    if (!more || !cursor) break;
  }
  return tally;
}

/** Attendees from several note-takers as one map by address, keeping a name any of them had. */
export function mergeAttendees(...maps) {
  const out = new Map();
  for (const m of maps) for (const [email, name] of m ?? []) addAttendee(out, email, name);
  return out.size ? out : null;
}

// The same bar the meeting resolver sets before it creates a person (worker resolveMeeting.mjs):
// a name, said or readable off the address. An address alone is never made into a person, and a
// role mailbox (info@, sales@) or a local part with digits has no readable name.
const ROLE_MAILBOX = /^(info|sales|support|hello|contact|admin|team|office|billing|accounts?|noreply|no-reply|notifications?|help|marketing|hr|jobs|careers)$/i;
function hasUsableName(email, name) {
  if (name && name.length >= 2 && !name.includes('@')) return true;
  const local = email.split('@')[0];
  if (ROLE_MAILBOX.test(local) || /\d/.test(local)) return false;
  return /^[a-z]{2,}[._-][a-z]{2,}$/i.test(local);
}

/**
 * Who the note-taker's meetings will bring onto the graph (GET-788), split by whether we hold them.
 *
 * The backfill creates every outside attendee it can name, whether or not the CRM has them; they
 * show as "Not in CRM". The pre-check said nothing about them: its accounts are the contacts we
 * already hold. This counts, from attendee metadata only, the outside people the meetings name
 * that are not on the graph yet, and the companies (work domains) behind them that are not either.
 * Our own people (logins, connected mailboxes and their work domains) are left out.
 */
export async function newFromNotetakers(supabase, workspaceId, attendees) {
  if (!attendees?.size) return { people: 0, accounts: 0 };
  const internal = await getInternalIdentities(supabase, workspaceId).catch(() => []);
  const ourEmails = new Set(internal.filter(i => i.kind === 'email').map(i => i.value));
  const ourDomains = new Set([...ourEmails].map(e => e.split('@')[1]).filter(d => d && !isFreeEmailDomain(d)));
  const outside = [...attendees.entries()].filter(([email, name]) => {
    const domain = email.split('@')[1];
    return !ourEmails.has(email) && !ourDomains.has(domain) && hasUsableName(email, name);
  }).map(([email]) => email);
  if (!outside.length) return { people: 0, accounts: 0 };

  const known = new Set();
  for (let i = 0; i < outside.length; i += 100) {
    const { data, error } = await supabase.from('entity_identifiers').select('value')
      .eq('workspace_id', workspaceId).eq('kind', 'email').in('value', outside.slice(i, i + 100));
    if (error) throw error;
    for (const r of data ?? []) known.add(String(r.value).toLowerCase());
  }
  const fresh = outside.filter(e => !known.has(e));
  const domains = [...new Set(fresh.map(e => e.split('@')[1]).filter(d => d && !isFreeEmailDomain(d)))];
  const knownDomains = new Set();
  for (let i = 0; i < domains.length; i += 100) {
    const { data, error } = await supabase.from('companies').select('domain')
      .eq('workspace_id', workspaceId).in('domain', domains.slice(i, i + 100));
    if (error) throw error;
    for (const r of data ?? []) if (r.domain) knownDomains.add(String(r.domain).toLowerCase());
  }
  return { people: fresh.length, accounts: domains.filter(d => !knownDomains.has(d)).length };
}

/**
 * What a workspace holds over the last `days`, counted at the source.
 * Returns { counts: { email_thread, meeting, call }, meetingCredits, sources, discovered } — a source
 * that is not connected or failed is absent from `sources` and counts zero. `discovered` is
 * { people, accounts } the note-taker's meetings will add that are not on the graph yet, or null.
 */
export async function countHistoryAtSource(supabase, workspaceId, addresses, { days, ownerUserId = null }) {
  const counts = { email_thread: 0, meeting: 0, call: 0 };
  const sources = {};
  let meetingCredits = 0;
  let attendees = null;
  try {
    const threads = await gmailThreads(supabase, workspaceId, addresses, days, ownerUserId);
    if (threads != null) { counts.email_thread = threads; sources.gmail = threads; }
  } catch (e) { console.warn(`[HISTORY_COUNT] ws=${workspaceId} gmail:`, e?.message || e); }
  for (const [name, read] of [['fireflies', firefliesMeetings], ['fathom', fathomMeetings]]) {
    try {
      const nt = await read(supabase, workspaceId, days, ownerUserId);
      if (nt) { counts.meeting += nt.meetings; meetingCredits += nt.credits; sources[name] = nt.meetings; }
      // A person on both note-takers' calls is one person (GET-817).
      attendees = mergeAttendees(attendees, nt?.attendees);
    } catch (e) { console.warn(`[HISTORY_COUNT] ws=${workspaceId} ${name}:`, e?.message || e); }
  }
  let discovered = null;
  try {
    if (attendees) discovered = await newFromNotetakers(supabase, workspaceId, attendees);
  } catch (e) { console.warn(`[HISTORY_COUNT] ws=${workspaceId} new people:`, e?.message || e); }
  return { counts, meetingCredits, sources, discovered };
}

/** Credits a month of this activity bills, at today's denomination. */
export function monthlyCredits({ counts, meetingCredits }) {
  return CREDIT_SCALE * ((counts.email_thread || 0) + (counts.call || 0)) + (meetingCredits || 0);
}
