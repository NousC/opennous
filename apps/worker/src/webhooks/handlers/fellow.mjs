// Fellow webhook handler.
//
// Unlike Fireflies and Granola, a Fellow `ai_note.generated` delivery is NOT just a
// notification — it carries the whole call inline: title, event times, attendees
// ({name,email}), organizer_email, the AI notes as markdown, the transcript, recap_url.
// So there is no follow-up fetch on the webhook path; we normalise the payload and run
// the same meeting pipeline Fireflies/Fathom/Granola use: resolve attendees → contacts,
// a meeting_held activity per attendee, the notes document + evidence file, one
// extraction pass for the room, call scoring, the unresolved queue.
//
// Three Fellow specifics, all from developers.fellow.ai/reference/webhooks:
//   1. URL verification. Creating the webhook makes Fellow POST
//      { type: 'url_verification', challenge } and wait 10s for the RAW challenge back
//      (plain text, not JSON, not 204). Unsigned — answered before anything else.
//   2. Signatures are svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}` with
//      the base64 `whsec_` secret Fellow returned once on create (stored encrypted).
//   3. Fellow wants a 2xx within 15s, and resolution + document writes can take longer on
//      a long call. So we ACK first and process after; a failure goes to webhook_inbox
//      and the retry worker re-runs reprocessFellow on the stored payload.
//
// Workspaces with webhooks switched off never get a webhook_id on connect; the poller
// (pollers/fellow.mjs) is their ingest path and hands reprocessFellow an already
// normalised call built from the REST API.

import { createHmac, timingSafeEqual } from 'crypto';
import { getSupabaseClient, saveDocument, resolveCallHost, attributeRelationship, isEntityInternal, isFreeEmailDomain, loadCompanyParents, mostSpecificInFamily, loadOwnDomains, writesCallArtifacts, writesCallSummary, retireMeetingNotes } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { extractMeetingSignals } from '../../signals/index.mjs';
import { summarizeInternalMeeting } from '../../signals/meetingSummary.mjs';
import { scoreCall, recordSecondRecording, readAndFileMeetingCommitments } from '../../signals/callScore.mjs';
import { resolveMeetingContacts, sameMeetingAlreadyLogged } from '../../utils/resolveMeeting.mjs';
import { writeEvidenceFile, normalizeMeeting } from '../../lib/evidence/index.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { recordUnresolved, markUnresolvedResolved } from '../../utils/unresolvedIngest.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

/**
 * `acme`, `acme.fellow.app`, `https://acme.fellow.app/…` → `acme`. Null for anything that
 * is not a bare DNS label: this becomes the host we send the API key to. Same rule as
 * fellowSubdomain in apps/api/src/providers/webhooks.mjs — the worker cannot import the API.
 */
export function fellowSubdomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.fellow\.(app|co|ai)$/, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

export function fellowApiBase(subdomain) {
  const sub = fellowSubdomain(subdomain);
  return sub ? `https://${sub}.fellow.app/api/v1` : null;
}

// Fellow is a company source (one Super Admin key, a workspace-scoped webhook), but a
// workspace can still hold more than one Fellow connection — a regular key, a reconnect —
// all delivering to the same /inbound/fellow/<workspace> URL. Whichever signing secret
// validates a delivery tells us whose webhook it was.
export async function getFellowConnections(supabase, workspaceId = null) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', 'fellow').maybeSingle();
  if (!provider?.id) return [];
  let q = supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials, owner_user_id, is_verified, created_at, account_email')
    .eq('provider_id', provider.id)
    .order('created_at', { ascending: false });
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data } = await q;
  return (data || []).map(c => {
    const creds = c.encrypted_credentials || {};
    const dec = (v) => { try { return v ? decrypt(v) : null; } catch { return null; } };
    const subdomain = fellowSubdomain(creds.fellow_subdomain || dec(creds.subdomain));
    return {
      id:          c.id,
      workspaceId: c.workspace_id,
      apiKey:      dec(creds.api_key),
      signingKey:  dec(creds.webhook_signing_key),
      webhookId:   creds.webhook_id || null,
      subdomain,
      ownerUserId: c.owner_user_id || null,
      isVerified:  !!c.is_verified,
      createdAt:   c.created_at || null,
      accountEmail: c.account_email || null,
      creds,
    };
  }).filter(c => c.apiKey && c.subdomain);
}

/**
 * The email the Fellow key belongs to (GET /me), cached on the connection.
 *
 * It is what tells our side from the buyer's when Fellow gives us no organizer: the REST list
 * carries no host field, so on a polled call the only way to know which attendee ran it is
 * "the one on our own email domain". Fetched once and stored in plain — an email is not a
 * secret — so the per-meeting path costs nothing.
 */
export async function fellowAccountEmail(supabase, conn) {
  const cached = conn?.creds?.fellow_account_email;
  if (cached) {
    // A connection cached before GET-291 holds the address ONLY inside the credentials blob, where
    // nothing outside this handler can read it. The workspace then saw one source of evidence for
    // its own domain where there were really two, and correctly refused to name it. Copy it out on
    // the way past — once, cheaply, and never at the cost of the caller's answer.
    if (conn.id && !conn.accountEmail) {
      const { error } = await supabase.from('workflow_provider_connections')
        .update({ account_email: cached }).eq('id', conn.id);
      if (error) console.warn(`[FELLOW] could not record account_email: ${error.message}`);
    }
    return cached;
  }
  if (!conn?.apiKey || !conn?.subdomain) return null;
  try {
    const res = await fetch(`${fellowApiBase(conn.subdomain)}/me`, { headers: { 'X-API-KEY': conn.apiKey } });
    if (!res.ok) return null;
    const email = (await res.json())?.user?.email || null;
    if (email && conn.id) {
      // Also on the connection's own column, not only inside the credentials blob: this address is
      // evidence of which domain the WORKSPACE itself belongs to (GET-291), and that has to be
      // readable without decrypting a credential. A note-taker's API key belongs to the company
      // that pays for it, so the account it reports is that company's own.
      await supabase.from('workflow_provider_connections')
        .update({ encrypted_credentials: { ...conn.creds, fellow_account_email: email }, account_email: email })
        .eq('id', conn.id);
    }
    return email;
  } catch { return null; }
}

/** The domain half of an email, lowercased. */
export const domainOf = (email) => {
  const at = String(email || '').lastIndexOf('@');
  return at > 0 ? String(email).slice(at + 1).toLowerCase() : null;
};

/**
 * Which attendee ran the call. The calendar organizer when Fellow names one (the webhook does);
 * otherwise the attendee on our OWN email domain, which is the only signal a polled call has.
 * Null when neither is available — better unowned than attributed to the wrong side.
 */
export function pickHostEmail(attendees, organizerEmail, accountEmail) {
  if (organizerEmail) return organizerEmail;
  const ours = domainOf(accountEmail);
  if (!ours) return null;
  return attendees.find(a => domainOf(a?.email) === ours)?.email ?? null;
}

// svix signature. The header is space-separated `v1,<base64>` pairs.
export function verifyFellowSignature(secret, rawBody, msgId, timestamp, signatureHeader) {
  if (!secret || !msgId || !timestamp || !signatureHeader) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;  // 5-min replay window
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = Buffer.from(createHmac('sha256', key).update(`${msgId}.${timestamp}.${rawBody}`).digest('base64'));
  return String(signatureHeader).split(' ').some(part => {
    if (!part.startsWith('v1,')) return false;
    const got = Buffer.from(part.slice(3));
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ── Normalising ─────────────────────────────────────────────────────────────

const GENERIC_SPEAKER = /^(speaker|unknown|participant)\s*\d*$/i;

// The webhook's transcript is already text ("Jane Doe: …" per line). Pull the distinct
// speaker names out of it for the speaker-name resolution tier.
function speakersFromText(text) {
  const names = new Set();
  for (const line of String(text || '').split('\n')) {
    const m = /^([^:\n]{1,60}):\s/.exec(line.trim());
    const n = m?.[1]?.trim();
    if (n && !GENERIC_SPEAKER.test(n)) names.add(n);
  }
  return [...names];
}

// The REST API's transcript is { speech_segments: [{ speaker, text, start, end }] }.
export function transcriptFromSegments(transcript) {
  const segs = Array.isArray(transcript?.speech_segments) ? transcript.speech_segments : [];
  const lines = [];
  const names = new Set();
  for (const s of segs) {
    const name = String(s?.speaker || '').trim();
    if (name && !GENERIC_SPEAKER.test(name)) names.add(name);
    const txt = String(s?.text || '').trim();
    if (txt) lines.push(name ? `${name}: ${txt}` : txt);
  }
  return { text: lines.join('\n').trim().slice(0, 200_000) || null, speakerNames: [...names] };
}

// The REST API's ai_notes are structured recaps (sections of key moments, topics,
// decisions, action items). Render them to the same markdown the webhook sends.
export function renderRecaps(recaps) {
  if (!Array.isArray(recaps) || !recaps.length) return null;
  const out = [];
  for (const recap of recaps) {
    for (const sec of recap?.sections || []) {
      const items = [];
      const c = sec?.content;
      if (typeof c === 'string') { if (c.trim()) items.push(c.trim()); }
      else if (Array.isArray(c)) {
        for (const it of c) {
          if (!it) continue;
          if (Array.isArray(it.bullet_points)) {
            items.push(`- **${it.title || 'Topic'}**`);
            for (const b of it.bullet_points) if (b?.text) items.push(`  - ${b.text}`);
          } else if (it.text) {
            const who = (it.assignees || []).map(a => a?.full_name || a?.email).filter(Boolean);
            items.push(`- ${it.text}${who.length ? ` (${who.join(', ')})` : ''}`);
          }
        }
      }
      if (items.length) out.push(`## ${sec.title || 'Notes'}`, ...items, '');
    }
  }
  return out.join('\n').trim() || null;
}

function normalizeParticipants(attendees = [], ...extraEmails) {
  const out = new Map();
  const add = (email, name) => {
    const e = email ? String(email).toLowerCase().trim() : null;
    const n = name ? String(name).trim() : null;
    if (!e && !n) return;
    const key = e || `name:${n.toLowerCase()}`;
    const prev = out.get(key);
    out.set(key, { email: e || prev?.email || null, name: n || prev?.name || null });
  };
  for (const a of attendees || []) {
    if (!a) continue;
    if (typeof a === 'string') add(a, null);
    else add(a.email, a.name || a.full_name);
  }
  for (const e of extraEmails) if (e) add(e, null);
  return [...out.values()];
}

const isoOr = (...candidates) => {
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
};

/**
 * A recording (+ its note) from the REST API → the one call shape the pipeline reads. Used by
 * the poller and by the agent-driven resolve, so a call fetched by id is identical to a polled
 * one — the same join key, the same attendees, the same transcript.
 */
/**
 * How long the call ran, in minutes, or null: the recording's own start and end, else the end of
 * the last transcript segment. A meeting bills one credit per ten minutes of it (GET-516), and a
 * Fellow meeting had no length anywhere, so every one billed the 30-minute median.
 */
export function fellowDurationMinutes(rec) {
  const a = Date.parse(rec?.started_at ?? '');
  const b = Date.parse(rec?.ended_at ?? '');
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return Math.round((b - a) / 60000);
  const segs = Array.isArray(rec?.transcript?.speech_segments) ? rec.transcript.speech_segments : [];
  const end = Math.max(0, ...segs.map(s => Number(s?.end) || 0));
  return end > 0 ? Math.round(end / 60) : null;
}

export function callFromRecording(rec, note, { subdomain = null } = {}) {
  const { text: transcriptText, speakerNames } = transcriptFromSegments(rec?.transcript);
  const noteId = rec?.note_id || note?.id || null;
  return {
    // The note is the join key the webhook uses (`id` there is the note id), so a call fetched
    // here and later re-delivered by a webhook dedups on the same external_id.
    noteId:         noteId || `rec_${rec?.id}`,
    title:          rec?.title || note?.title || 'Untitled Meeting',
    occurredAt:     note?.event_start || rec?.started_at || rec?.created_at,
    attendees:      (note?.event_attendees || []).map(a => ({ email: a?.email || null })),
    // The REST note DOES name the organizer — the webhook is not the only place it exists. Using
    // it beats inferring the host from our own email domain, which picks whichever teammate
    // happens to be listed first.
    organizerEmail: note?.organizer_email || null,
    aiNotes:        renderRecaps(rec?.ai_notes),
    transcriptText,
    speakerNames,
    // The call in Fellow. The webhook hands us recap_url; the REST API does not, so we build the
    // same address — /meetings/<noteId> on the workspace subdomain. Without it the Call page can
    // only say "the transcript is saved with the meeting notes" instead of linking the recording.
    url:            subdomain && noteId ? `https://${subdomain}.fellow.app/meetings/${noteId}` : null,
    connectedUserRecorded: false,
    durationMinutes: fellowDurationMinutes(rec),
  };
}

/**
 * Fetch one call by its NOTE id, for the agent-driven resolve: the queue row holds the note id
 * and nothing else. The note names its recordings; the recording carries the transcript.
 */
export async function fetchFellowCallByNoteId(conn, noteId) {
  const base = fellowApiBase(conn?.subdomain);
  if (!base || !conn?.apiKey) return null;
  const get = async (path) => {
    const r = await fetch(`${base}${path}`, { headers: { 'X-API-KEY': conn.apiKey } });
    return r.ok ? r.json().catch(() => null) : null;
  };
  const note = (await get(`/note/${encodeURIComponent(noteId)}`))?.note ?? null;
  const recId = note?.recording_ids?.[0] ?? null;
  const rec = recId ? (await get(`/recording/${encodeURIComponent(recId)}`))?.recording ?? null : null;
  if (!note && !rec) return null;
  return callFromRecording(rec ?? { note_id: noteId }, note, { subdomain: conn.subdomain });
}

/**
 * The account a call belongs to: the dealership the room actually works for.
 *
 * A page filed on "Lena Quist" hides a call that belongs on Larkfield Toyota, and the
 * Accounts list then reads as a list of people. A person is the subject only when we genuinely do
 * not know their company yet — which is honest, and fixes itself the moment we do.
 *
 * Taking the first buyer whose company we know misfiled some of one workspace's first calls (GET-296),
 * and dealer groups make that systematic rather than random: a graph can hold several "Harlow
 * Bay" rooftops, several "Cinder Ridge" and several "Ostwick", each its own company with its own
 * domain. In such a workspace a sizeable share of contacts sit on an employer whose domain is not
 * the one they send mail from. Two things then go wrong at once — a contact's CRM row points at a sibling
 * rooftop, and "first" is arbitrary, so one stale row outvotes two attendees who agree.
 *
 * The email domain sitting in the room is the better evidence, and it was right in both failures.
 * So: one vote per external attendee, per corporate domain that maps to a company, and the most
 * voted company wins. Free mail never votes — a dealer on gmail resolves through their contact
 * record, which is how "test.dealer.0003@gmail.com" keeps landing on Quillmoor RV.
 *
 * Falls back to the CRM's employer when nothing resolves by domain, so a workspace whose companies
 * carry no domains behaves exactly as it did before.
 *
 * Pure: `companyIdByDomain` is loaded by the caller, so the rule is testable without a database.
 *
 * @param externals          [{ contactId, companyId, email }] — external attendees only
 * @param companyIdByDomain  Map<domain, entityId>, from companyIdsByAttendeeDomain
 */
export function pickAccountEntityId(externals, companyIdByDomain = new Map(), parentOf = new Map()) {
  const list = (externals ?? []).filter(Boolean);
  if (!list.length) return null;

  const votes = new Map();   // entityId -> { n, firstSeen }
  list.forEach((e, i) => {
    const d = domainOf(e?.email);
    if (!d || isFreeEmailDomain(d)) return;
    const companyId = companyIdByDomain.get(d);
    if (!companyId) return;
    const v = votes.get(companyId) ?? { n: 0, firstSeen: i };
    v.n += 1;
    votes.set(companyId, v);
  });

  if (votes.size) {
    // Most attendees wins; a tie falls to whoever was in the room first, so the answer does not
    // move when the attendee list arrives in a different order.
    const [best] = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || a[1].firstSeen - b[1].firstSeen);
    const byDomain = best[0];

    // The group, or one of its rooftops? Both answers are true and one is more useful.
    //
    // Someone writing from brindlecrestautogroup.example whose CRM row says Brindlecrest Chevrolet (North
    // Store) is not a misfiling — it is the group's domain on a rooftop's employee, and the rooftop is
    // where the deal lives. On the first workspace to hit this, close to half of the contacts this rule
    // moves are that shape, so choosing by domain alone would have filed them all one level too high.
    //
    // So when the CRM names a company in the SAME FAMILY as the domain's, the CRM's more specific
    // answer wins. When it names a company from another family — Fallowmere Volkswagen on a call with
    // three people from Harrowgate Motors — it is contradicting the room, and the room wins. That is
    // exactly the GET-296 failure, and it stays fixed.
    //
    // With no hierarchy loaded, mostSpecificInFamily only ever agrees with itself, so this is a
    // no-op and the domain answer stands: a workspace whose CRM models no groups is unaffected.
    const fromCrm = list.find(e => e?.companyId)?.companyId ?? null;
    return mostSpecificInFamily(fromCrm, byDomain, parentOf) ?? byDomain;
  }

  return list.find(e => e?.companyId)?.companyId ?? list[0]?.contactId ?? null;
}

/**
 * Each external attendee's corporate email domain → the company entity that owns it.
 *
 * Reads `entity_identifiers` rather than the `companies` view: a company may hold several domains
 * and only the identifier table has them all.
 *
 * Returns `{ byDomain, read }` — `read` is 'ok' or 'failed'. A TIMEOUT IS NOT AN ANSWER: this used
 * to swallow any failure and return an empty map, which is indistinguishable from "none of these
 * domains is a company we hold", so a loaded database quietly became calls filed on the wrong
 * entity. Once, three attendees were on ashgrovemazda.example, Ashgrove Mazda was active in the
 * graph under that exact domain, and the page landed on one of the workspace's own staff because
 * this returned nothing. So it retries, and when it still fails it says so, and the caller decides.
 */
export async function companyIdsByAttendeeDomain(supabase, workspaceId, externals = []) {
  const domains = [...new Set((externals ?? [])
    .map(e => domainOf(e?.email))
    .filter(d => d && !isFreeEmailDomain(d)))];
  if (!domains.length) return { byDomain: new Map(), read: 'ok' };

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data, error } = await supabase
        .from('entity_identifiers')
        .select('entity_id, value')
        .eq('workspace_id', workspaceId)
        .eq('kind', 'domain')
        .eq('status', 'active')
        .in('value', domains);
      if (error) throw new Error(error.message);
      const out = new Map();
      for (const row of data ?? []) {
        const d = String(row.value || '').toLowerCase();
        if (d && !out.has(d)) out.set(d, row.entity_id);   // first active holder wins
      }
      return { byDomain: out, read: 'ok' };
    } catch (err) {
      lastError = err;
      // A loaded database, not a broken one: give it room rather than hammering it.
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  console.warn(`[FELLOW_WEBHOOK] attendee-domain lookup failed after 3 attempts: ${lastError?.message || lastError}`);
  return { byDomain: new Map(), read: 'failed' };
}

/** A webhook payload → the one call shape the pipeline reads. */
export function callFromWebhook(p) {
  const transcriptText = String(p?.transcript || '').trim().slice(0, 200_000) || null;
  return {
    noteId:         p?.id || null,
    title:          p?.event_title || 'Untitled Meeting',
    occurredAt:     isoOr(p?.event_start, p?.recording_start),
    attendees:      p?.attendees || [],
    organizerEmail: p?.organizer_email || null,
    aiNotes:        String(p?.ai_notes || '').trim() || null,
    transcriptText,
    speakerNames:   speakersFromText(transcriptText),
    url:            p?.recap_url || null,
    // Only a user-scoped delivery says whether the connected rep started the recording.
    connectedUserRecorded: p?.is_user_who_started_recording === true,
  };
}

// ── The pipeline ────────────────────────────────────────────────────────────

/**
 * Runs one Fellow call through the meeting pipeline. Accepts:
 *   - a raw `ai_note.generated` payload (webhook, or its webhook_inbox retry), optionally
 *     carrying `_nous_owner_user_id` — the rep whose webhook signed it, stamped by
 *     handleFellow so a retry still knows;
 *   - `{ type: 'poll', call, ownerUserId }` from the poller, `call` already normalised.
 */

/**
 * Whose record one meeting's notes belong to.
 *
 * The ACCOUNT when we know it, for the same reason the call page uses it: notes filed on "Lena
 * Quist" hide a meeting that belongs to Larkfield Toyota. A person is the subject only when
 * we genuinely do not know their company, and an internal attendee only when nobody external was
 * there at all — an internal person must never become the subject of a customer's meeting.
 *
 * Exported so the rule is testable; it used to be an inline expression run once per contact, which
 * is how prod ended up holding about ten copies of every meeting (GET-355).
 */
export function meetingNotesSubject({ accountEntityId, externals = [], internals = [] } = {}) {
  return accountEntityId || externals[0]?.contactId || internals[0] || null;
}


/**
 * Does this contact take part in the pass, when their meeting row already existed?
 *
 * logActivity dedupes on external_id, so a re-run returns no row and every contact would be
 * skipped — leaving nobody external, so nothing extracts and the run reports `filed 0 · already N
 * · failed 0`. Right for an ordinary retry; wrong whenever the rows landed and the model calls did
 * not, which strands the meeting forever (GET-358).
 *
 * Exported because it is a one-line condition that decides whether an entire meeting is read or
 * silently dropped, and that deserves a test rather than a reader's confidence.
 */
export function processContact({ logged, force = false, reextract = false }) {
  return !!logged || !!force || !!reextract;
}

export async function reprocessFellow(supabase, workspaceId, body) {
  body = body || {};
  // Agent-driven resolve (POST /v2/unresolved/:id/resolve, via the worker's internal re-ingest):
  // the caller has decided who this meeting belongs to. The chosen contact is attached in
  // ADDITION to normal resolution, so the whole pipeline runs against the right person.
  const resolveToEntityId = body?.resolveToEntityId || body?.resolve_to_entity_id || null;

  let call, connectionOwnerUserId;
  if (body.type === 'resolve') {
    // Only an id — fetch the call from Fellow with whichever connection can see it.
    const noteId = body.noteId || body.note_id || body.meetingId || null;
    if (!noteId) throw new Error('note_id_required');
    const conns = await getFellowConnections(supabase, workspaceId);
    for (const c of conns) {
      call = await fetchFellowCallByNoteId(c, noteId).catch(() => null);
      if (call) { connectionOwnerUserId = c.ownerUserId || null; body = { ...body, accountEmail: body.accountEmail ?? await fellowAccountEmail(supabase, c) }; break; }
    }
    if (!call) {
      await logSysEvent(supabase, {
        workspaceId, source: 'fellow', eventType: 'webhook_received',
        summary: `Fellow note ${noteId} could not be fetched — no connected key can see it`,
        metadata: { note_id: noteId, logged: 0, reason: 'note_not_found' },
      });
      return { logged: 0, reason: 'note_not_found' };
    }
  } else if (body.type === 'poll' && body.call) {
    call = body.call;
    connectionOwnerUserId = body.ownerUserId || null;
  } else {
    if (body.event_type && body.event_type !== 'ai_note.generated') return { logged: 0, skipped: body.event_type };
    call = callFromWebhook(body);
    connectionOwnerUserId = body._nous_owner_user_id || null;
  }
  const { noteId, title, occurredAt, aiNotes, transcriptText, speakerNames, url } = call;
  if (!noteId) throw new Error('note_id_required');

  // The history import files the meeting, its people, the notes and the transcript, and calls no
  // model — extraction and scoring then run later as their own priced pass (GET-286). `dispatch`
  // is off for anything historical either way: a call from March must not trigger a follow-up now.
  const fileOnly = body.mode === 'file_only';
  // COMMITMENTS ONLY (GET-420): resolve the call as usual, then run one commitments read and file
  // the tasks — no fact extraction, no insights, no health read, no page. For meetings read before
  // every call type filed its commitments (GET-418), so their tasks can be added for ~$0.02 each
  // instead of re-buying the whole read.
  const commitmentsOnly = body.mode === 'commitments_only';
  // REBUILD a meeting we already hold (GET-286). logActivity dedups on external_id, so a re-run
  // normally files nothing, treats the call as having no participants, and therefore extracts and
  // reviews nothing — which is right for a retry and wrong when the pages themselves were deleted
  // to rebuild them under a newer system. With force, an existing row counts as a participant.
  const force = body.force === true;
  const dispatch = body.backfill ? false : true;
  // Read the account, do not grade the rep (see scoreCall). Opt-in, and only a caller that asked
  // for it gets it: live ingest always coaches, and a backfill coaches unless told otherwise.
  const skipCoaching = body.skipCoaching === true;
  // ARCHIVAL: harvest what this call permanently teaches us about the account, and write none of
  // the artifacts that only make sense while it is recent (GET-351). Claims still run — they are
  // the point, and they do not go stale. The health read, the commitments it files, the call page
  // and the grade do not run, because `deriveAccountHealth` would drop those signals for age on the
  // very next read, nobody browses to a ten-month-old summary, and a rep cannot re-run March.
  //
  // Decided by the MEETING'S OWN DATE so a caller cannot get it wrong and a meeting becomes
  // archival on its own schedule. Live ingest is never archival: `backfill` gates it. An explicit
  // mode still wins, for deliberate repairs of an old call.
  // THE ACTIVITY EXISTS BUT THE WORK DOES NOT (GET-358).
  //
  // logActivity dedupes on external_id, so a meeting whose rows were written by an earlier run
  // returns no `result` and every contact is skipped below — which leaves `externals` empty, so
  // nothing extracts, nothing is filed, and the run reports `filed 0 · already N · failed 0`.
  //
  // That is right for an ordinary retry and wrong whenever the rows landed and the MODEL CALLS did
  // not: a credit outage, a provider 500, a container killed mid-flight. The meeting is then stuck
  // forever — the resume check correctly says "no claims, try it", the handler says "already seen,
  // skip", and the loop repeats at any scale you point it at, reporting success every time.
  //
  // Distinct from `force`, which also rebuilds pages and overwrites what is there. This says only:
  // the activity is not the work, so do the work.
  const reextract = body.reextract === true;
  const archival = body.mode === 'archival'
    || (body.mode !== 'live' && body.backfill === true && !writesCallArtifacts(occurredAt));

  // A note with no meeting recording still fires, in a reduced form (empty ai_notes,
  // transcript and attendees). Nothing to put on a timeline.
  if (!aiNotes && !transcriptText && !(call.attendees || []).length) {
    return { logged: 0, reason: 'empty_note' };
  }

  const attendees = normalizeParticipants(call.attendees, call.organizerEmail);

  // WHO RAN THE CALL. Fellow's webhook names the calendar organizer; its REST list does not,
  // so on a polled call we take the attendee on OUR OWN email domain — the domain the Fellow
  // key belongs to. Without it the seller's own rep is just another attendee: the call ends up
  // with no owner, and the rep is read as if she were on the buyer's side.
  const hostEmail = pickHostEmail(attendees, call.organizerEmail, body.accountEmail);

  // OUR OWN PEOPLE ARE NOT THE CUSTOMER. `isEntityInternal` is a claim asserted from workspace
  // MEMBERS, and a client whose reps have no seats yet has none — so their own CS manager read as a
  // buyer, facts about her landed on her record, and the call page filed itself on the seller's own
  // account instead of the dealership's.
  //
  // The workspace's OWN DOMAINS are the answer, recorded once from seats and connected accounts
  // (GET-291) instead of re-derived here. The Fellow key's own domain stays as a fallback: it is
  // right, it is always available, and a workspace that has not resolved its domains yet must keep
  // working exactly as before rather than treating everyone as a customer.
  const ownDomains = await loadOwnDomains(supabase, workspaceId).catch(() => new Set());
  const keyDomain = domainOf(body.accountEmail);
  const ourDomains = new Set([...ownDomains, ...(keyDomain ? [keyDomain] : [])]);
  const ourDomain = keyDomain;   // still used for picking the host, which needs one address
  const onOurDomain = (email) => {
    const d = domainOf(email);
    return !!d && ourDomains.has(d);
  };


  const extractionText = (transcriptText && transcriptText.length >= 40)
    ? transcriptText.slice(0, 200_000)
    : aiNotes;
  const meetingSummary = aiNotes
    || (transcriptText ? transcriptText.slice(0, 12_000) : `Meeting: ${title}`);
  const notesContent = [
    aiNotes,
    transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null,
  ].filter(Boolean).join('\n\n') || null;

  const contacts = await resolveMeetingContacts(supabase, workspaceId, {
    startTime:      occurredAt,
    title,
    attendees,
    organizerEmail: hostEmail,
    source:         'fellow',
    speakerNames,
    createMissing:  true,
  });

  if (resolveToEntityId && !contacts.some(c => c.id === resolveToEntityId)) {
    const { data: forced } = await supabase.from('contacts')
      .select('id, company_id, company, email, first_name, last_name, channels')
      .eq('workspace_id', workspaceId).eq('id', resolveToEntityId).maybeSingle();
    if (forced) contacts.push(forced);
    else console.warn(`[FELLOW_WEBHOOK] resolveToEntityId ${resolveToEntityId} not found in ws ${workspaceId}`);
  }

  // WHICH OF THESE PEOPLE ARE OURS. `contacts` is a projection over claims, so `email` can be empty
  // on a row that was just written — some of a client's own staff slipped through as buyers that way
  // and their calls filed onto the seller. So we check three things, any of which makes someone
  // ours: the email on the row, the email the INVITE used (which we always have), and the domain of
  // the company the contact belongs to.
  const ourEmails = new Set(
    attendees.map(a => String(a.email ?? '').toLowerCase()).filter(e => onOurDomain(e)),
  );
  const ourCompanyIds = new Set();
  if (ourDomains.size) {
    const companyIds = [...new Set(contacts.map(c => c.company_id).filter(Boolean))];
    if (companyIds.length) {
      const { data: comps } = await supabase.from('companies')
        .select('id, domain').eq('workspace_id', workspaceId).in('id', companyIds);
      for (const c of comps ?? []) {
        if (ourDomains.has(String(c.domain ?? '').toLowerCase().replace(/^www\./, ''))) ourCompanyIds.add(c.id);
      }
    }
  }
  const isOurs = (contact) => {
    const email = String(contact.email ?? '').toLowerCase();
    if (email && (ourEmails.has(email) || onOurDomain(email))) return true;
    return !!(contact.company_id && ourCompanyIds.has(contact.company_id));
  };

  // Who OWNS the call: the one rule every note-taker uses (GET-246, resolveCallHost) — the
  // organizer when they are on the team, else whoever recorded it. Fellow is a company source,
  // so the connector counts as the recorder only when the delivery says they recorded it.
  const recorderUserId = (call.connectedUserRecorded && connectionOwnerUserId) || null;
  const meetingOwnerUserId = await resolveCallHost(supabase, workspaceId, {
    organizerEmail: hostEmail,
    recorderEmail:  hostEmail,
    recorderUserId,
  });
  // The host EMAIL is kept whether or not it maps to a seat. A rep hosting on her own company
  // address with no Nous seat is exactly the case that used to land unowned and unattributable:
  // stored here, the call still says who ran it, and it attaches by itself the day that seat exists.
  // The host's NAME comes with the invite. It was left null here, so every task a host with no seat
  // promised read "unassigned" under a title that said her name (GET-400).
  const hostName = attendees.find(a => String(a.email ?? '').toLowerCase() === String(hostEmail ?? '').toLowerCase())?.name || null;
  const recorder = { name: hostName, email: hostEmail, userId: recorderUserId || meetingOwnerUserId };

  // Two reps on the same call each have their own Fellow webhook, so the same note can
  // arrive twice — own deliveries share the prefix and dedup on external_id. A DIFFERENT
  // note-taker on the same call is caught here.
  //
  // FORCE IS THE ONE EXEMPTION. A rebuild deletes the pages, then re-runs the meetings that made
  // them — and every one of those meetings is, by definition, already on the timeline. So this
  // check called all ten "another recording of a call already ingested" and rebuilt nothing.
  // Force means "we deleted these deliberately, do it again", so it has to reach the pipeline.
  // Nothing doubles: logActivity still dedups on external_id, and force is exactly what lets an
  // existing row count as a participant.
  //
  // AND ONLY A CUSTOMER IS EVIDENCE. Matching on any shared contact let our own staff — who are on
  // every call — prove that two calls were one. A CS manager running two dealership installations
  // in an afternoon had them merged into a single record, with one page between them.
  const dupMeeting = force ? false : await sameMeetingAlreadyLogged(supabase, workspaceId, {
    contactIds: contacts.filter(c => !isOurs(c)).map(c => c.id),
    occurredAt,
    externalIdPrefix: `fellow_${noteId}_`,
  }).catch(() => false);
  if (dupMeeting) {
    // Another teammate's note-taker already put this call on the timeline. Don't log or extract it
    // twice, but don't drop it either: keep its transcript and add it to the call (GET-246).
    console.log(`[FELLOW_WEBHOOK] workspace=${workspaceId} note ${noteId}: another recording of a call already ingested — adding it to that call`);
    await recordSecondRecording(supabase, workspaceId, {
      source: 'fellow', meetingId: noteId, title, url: url || null, contacts, occurredAt, notesContent,
      transcript: extractionText, hostUserId: meetingOwnerUserId, recorder,
      namedSpeakers: (speakerNames || []).length > 0,
    });
    return { logged: 0, deduped: true };
  }

  const sourceRef = `source://fellow/${noteId}`;
  let logged = 0;
  const externals = [];
  const internals = [];

  // A FORCED RE-READ REPLACES THE LAST READ (GET-409). The facts the previous read extracted from
  // this note — on every attendee and on the account — are retired before extraction runs again.
  // The semantic dedup is meant to catch a repeat, and it did not: it times out under load
  // ("NOTE_DEDUP_BLIND") and then ADDS. A rebuild is exactly the case where "the same fact again"
  // is certain, so it does not depend on the dedup at all.
  if (force || reextract) {
    const companyIds = [...new Set(contacts.map(c => c.company_id).filter(Boolean))];
    const retired = await retireMeetingNotes(supabase, workspaceId, {
      entityIds: [...contacts.map(c => c.id), ...companyIds], meetingId: noteId,
    }).catch(err => { console.error(`[FELLOW_WEBHOOK] note ${noteId}: could not retire the previous read's notes — duplicates possible: ${err.message}`); return 0; });
    console.log(`[FELLOW_WEBHOOK] note ${noteId}: retired ${retired} note(s) from the previous read before rebuilding`);
  }

  for (const contact of contacts) {
    const result = await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'meeting_held',
      source:      'fellow',
      externalId:  `fellow_${noteId}_${contact.id}`,
      occurredAt,
      description: `Meeting: ${title}`,
      summary:     meetingSummary,
      rawData:     { title, note_id: noteId, url, host_email: hostEmail, ...(call.durationMinutes ? { duration_minutes: call.durationMinutes } : {}) },
      ownerUserId: meetingOwnerUserId,
      suppressExtraction: true,
    });
    if (!processContact({ logged: !!result, force, reextract })) continue;
    if (result) logged++;

    let internal = ourDomain ? isOurs(contact) : false;
    if (!internal) {
      try { internal = await isEntityInternal(supabase, workspaceId, contact.id); }
      catch { /* on failure treat as external — losing signal is worse */ }
    }

    if (!internal) {
      externals.push({
        contactId:  contact.id,
        activityId: result?.id ?? null,   // a forced rebuild has no NEW row; the call is the same call
        name:       [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
        company:    contact.company || null,
        companyId:  contact.company_id || null,
        email:      contact.email || null,   // the account vote is cast on this (GET-296)
      });
    } else {
      internals.push(contact.id);
    }

    if (meetingOwnerUserId && !internal) {
      try { await attributeRelationship(supabase, workspaceId, contact.id, meetingOwnerUserId, { at: occurredAt }); }
      catch (e) { console.warn('[fellow] attribute failed', e.message); }
    }

    // The meeting's notes used to be written HERE, once per contact — so a five-person call stored
    // the same blob five times, and prod held about ten copies of every meeting (GET-355). It is
    // one thing that happened, so it is written once, below, after we know whose account it is.
    //
    // The evidence file stays per contact: it writes to the OWNER's own store, keyed by
    // `fellow:<noteId>`, and is a different system from the claims table.
    if (notesContent && (result || force)) {
      if (!internal && meetingOwnerUserId) {
        const ev = normalizeMeeting({ title, recap: aiNotes, transcript: transcriptText, url });
        await writeEvidenceFile(supabase, {
          workspaceId, ownerUserId: meetingOwnerUserId, entityId: contact.id, companyId: contact.company_id || null,
          type: 'meeting', source: 'fellow', dedupKey: `fellow:${noteId}`, sourceRef,
          occurredAt, title: ev.title, markdown: ev.markdown,
        });
      }
    }
  }

  if (fileOnly) {
    const linkedOnly = contacts.length;
    await logSysEvent(supabase, {
      workspaceId, source: 'fellow', eventType: 'webhook_received',
      summary: `Fellow meeting filed: ${title} — ${linkedOnly} contact${linkedOnly === 1 ? '' : 's'} linked, no extraction (history import)`,
      metadata: { note_id: noteId, title, linked: linkedOnly, logged, host_email: hostEmail, mode: 'file_only' },
    });
    return { logged, linked: contacts.length, fileOnly: true, hostEmail, hasTranscript: !!transcriptText };
  }

  // Live, these are fire-and-forget: the worker keeps running and the webhook must answer fast.
  // A BACKFILL is the opposite — the script exits when the loop ends, so anything not awaited is
  // killed mid-flight, and an un-awaited loop would also put hundreds of concurrent model calls on
  // the extraction provider at once. So a backfill waits for each call's own work.
  const pending = [];
  if (commitmentsOnly) {
    // Only the commitments (GET-420): no facts, no insights, no team read. The account is decided
    // below exactly as it is for the health read, then one read and the filing.
  } else if (externals.length && extractionText) {
    pending.push(extractMeetingSignals({ supabase, workspaceId, participants: externals, summary: extractionText,
      source: 'fellow', occurredAt, sourceRef,
      // Our side, by name, so a fact quoting the rep is dropped rather than filed on the customer.
      ourNames: [hostName, ...contacts.filter(c => isOurs(c)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' '))].filter(Boolean) })
      .catch(err => console.warn('[fellow] meeting extraction failed', err.message)));
  } else if (internals.length && extractionText) {
    // The team-insight extractor no longer runs here (GET-467): the meeting summary below is the
    // internal record, and its insights feed Internal Insights.
    // The meeting's one consistent record (GET-445): summary, insights by scope, decisions, next steps.
    pending.push(summarizeInternalMeeting({ supabase, workspaceId, transcript: extractionText, title: title, occurredAt,
      sourceRef: sourceRef, sourceSystem: 'fellow', subjectEntityId: internals[0],
      participants: contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) }));
  }

  // Which dealership this call belongs to, by the attendees' own email domains (GET-296).
  // Resolved once, before scoring, so the page and the scorecard cannot disagree.
  const { byDomain, read: domainRead } = await companyIdsByAttendeeDomain(supabase, workspaceId, externals);
  const pickedAccountId = pickAccountEntityId(
    externals,
    byDomain,
    // The groups those companies belong to, so a rooftop is not filed on its parent.
    await loadCompanyParents(supabase, workspaceId, [
      ...new Set([...byDomain.values(), ...externals.map(e => e?.companyId).filter(Boolean)]),
    ]),
  );
  const crmWouldHaveSaid = externals.find(e => e?.companyId)?.companyId ?? null;
  if (pickedAccountId && crmWouldHaveSaid && pickedAccountId !== crmWouldHaveSaid) {
    console.log(`[FELLOW_WEBHOOK] note ${noteId}: account by attendee domain -> ${pickedAccountId} (the CRM said ${crmWouldHaveSaid})`);
  }

  // NO PAGE IS BETTER THAN A WRONG PAGE. Two ways this call could be filed on something that is
  // not the customer, and both produce a page nobody questions:
  //
  //   1. The domain read failed. We then know nothing about who owns these domains, and every
  //      remaining answer is the CRM's or a bare contact id — a guess wearing a confident face.
  //   2. The answer is one of OUR OWN people. pickAccountEntityId ends at `list[0].contactId` when
  //      nothing else resolves, and `externals` can still contain a colleague whose contact row we
  //      could not tell apart from a buyer. That is how a dealership's installation call filed
  //      itself on the customer's own employee.
  //
  // Either way the call, its people and its transcript are still filed — only the ACCOUNT is
  // withheld, and the meeting goes to the unresolved queue where a human can name it.
  const ourEntityIds = new Set(internals.filter(Boolean));
  const picksOurselves = pickedAccountId != null && ourEntityIds.has(pickedAccountId);
  const accountEntityId = (domainRead === 'failed' || picksOurselves) ? null : pickedAccountId;
  if (accountEntityId !== pickedAccountId) {
    const why = domainRead === 'failed'
      ? 'the attendee-domain lookup failed, so any account here would be a guess'
      : 'the only answer was one of our own people';
    console.warn(`[FELLOW_WEBHOOK] note ${noteId}: not filing this call on an account — ${why}`);
    await recordUnresolved(supabase, {
      workspaceId, source: 'fellow', kind: 'meeting', externalId: noteId,
      title, occurredAt,
      detectedEmails: externals.map(e => e?.email).filter(Boolean),
      summary: `Account not resolved: ${why}.`,
    }).catch(err => console.warn('[FELLOW_WEBHOOK] unresolved record failed', err.message));
  }
  if (commitmentsOnly) {
    // Same window as the health read: an archival call's promises are history, not a to-do.
    const r = !archival && externals.length && transcriptText && transcriptText.length >= 200
      ? await readAndFileMeetingCommitments({
          supabase, workspaceId, transcript: extractionText, meetingId: noteId, source: 'fellow',
          title, sourceUrl: url || null, occurredAt, contacts, recorder,
          accountEntityId, entityId: externals[0]?.contactId ?? null, repUserId: meetingOwnerUserId,
        }).catch(err => { console.warn('[fellow] commitments-only read failed', err.message); return { filed: 0 }; })
      : { filed: 0 };
    console.log(`[fellow] note ${noteId}: commitments only — ${r.filed} filed`);
    return { logged, linked: contacts.length, commitmentsOnly: true, filed: r.filed, hostEmail, hasTranscript: !!transcriptText };
  }


  // ONE record of what was said, on the account it belongs to (GET-355).
  //
  // Filed on the account rather than on whoever happened to be first in the room, for the same
  // reason the call page is: notes filed on "Lena Quist" hide a meeting that belongs to Larkfield
  // Toyota. A person is only the subject when we genuinely do not know their company.
  //
  // Archival meetings write none of it. The AI notes ARE the call summary, and an old call is worth
  // its claims and nothing else (GET-351) — that ruling covered the call page and missed this.
  //
  // IDEMPOTENT, which the old per-contact write was only by accident: it rode on `result`, the new
  // activity row, so a resumed run wrote nothing. This writes once per meeting, so it has to ask.
  // `saveDocument` is a plain insert — it hashes the content into metadata and never checks it —
  // and the backfill's whole promise is that a re-run resumes rather than duplicates.
  // Thirty days, not the archival cut: a summary is read by a person, and a person does not read
  // last March. A backfilled meeting older than that writes none, whatever else it still earns.
  const wantsSummary = body.backfill ? writesCallSummary(occurredAt) : true;
  if (notesContent && !archival && wantsSummary && !fileOnly) {
    const notesSubject = meetingNotesSubject({ accountEntityId, externals, internals });
    let alreadyHaveNotes = false;
    if (notesSubject) {
      const { data: existing, error: notesErr } = await supabase.from('claims')
        .select('id').eq('workspace_id', workspaceId).like('property', 'note.%')
        .eq('value->metadata->>note_id', noteId)
        .eq('value->metadata->>doc_type', 'meeting_notes')
        .limit(1);
      // A failed check must not write a duplicate on a guess: treat "we could not tell" as "we
      // have it". A missing notes record is recoverable; a table full of copies is what we are
      // here to fix.
      alreadyHaveNotes = notesErr ? true : (existing ?? []).length > 0;
      if (notesErr) console.warn('[fellow] notes dedupe check failed, skipping the write', notesErr.message);
    }
    if (notesSubject && !alreadyHaveNotes) {
      await saveDocument(supabase, workspaceId, {
        entityId: notesSubject,
        type:     'meeting_notes',
        title:    `Meeting notes — ${title}`,
        content:  notesContent,
        date:     occurredAt,
        source:   'fellow',
        meta:     {
          source_ref: sourceRef, note_id: noteId, url: url || null,
          owner_user_id: meetingOwnerUserId ?? null, host_email: hostEmail,
          // Who was in the room, so one record does not lose what N records carried.
          participant_entity_ids: [...externals.map(e => e.contactId), ...internals],
          // Everyone on the call by address (GET-459): what decides whether it was internal.
          attendee_emails: attendees.map(a => String(a.email ?? '').toLowerCase()).filter(Boolean),
        },
      }).catch(err => console.warn('[fellow] meeting notes failed', err.message));
    }
  }

  // Archival calls stop here: the claims above are what they were worth. Everything scoreCall
  // produces — the health read and its commitments, the call page, the grade — is recency-bound.
  if (archival && externals.length) {
    console.log(`[fellow] note ${noteId}: archival (${occurredAt}) — claims only, no health read, page or grade`);
  }
  if (!archival && externals.length && transcriptText && transcriptText.length >= 200) {
    pending.push(scoreCall({
      supabase, workspaceId,
      transcript:  extractionText,
      repUserId:   meetingOwnerUserId ?? null,
      entityId:    externals[0]?.contactId ?? null,
      meetingId:   noteId,
      source:      'fellow',
      occurredAt,
      // The call page (GET-236): filed on the account, linked back to Fellow.
      title,
      sourceUrl:        url || null,
      // The account, not the person who happened to be first on the call: a page filed on
      // "Lena Quist" hides a call that belongs on Larkfield Toyota. A person is only the
      // subject when we genuinely do not know their company yet.
      accountEntityId,
      mentionEntityIds: externals.map(e => e.contactId),
      sourceRef,
      contacts,
      recorder,
      namedSpeakers:    (speakerNames || []).length > 0,
      dispatch,
      skipCoaching,
      // The health read still runs — a risk from ninety days ago is inside its own window and
      // still worth acting on. What it must not do is write a page nobody will read (GET-351).
      writePage: wantsSummary,
    }).catch(err => console.warn('[fellow] call scoring failed', err.message)));
  }

  // A backfill waits; live ingest does not.
  if (body.backfill && pending.length) await Promise.all(pending);

  // Unresolved queue — same gate as granola.mjs: on who it LINKED, not on new rows.
  const hostLc = (hostEmail || '').toLowerCase();
  const nonHostEmails = [...new Set(attendees.map(p => (p.email || '').toLowerCase()).filter(e => e && e !== hostLc))];
  const nonHostNames  = [...new Set([
    ...attendees.filter(p => (p.email || '').toLowerCase() !== hostLc).map(p => p.name).filter(Boolean),
    ...speakerNames,
  ])];
  if (contacts.length > 0 && resolveToEntityId) {
    await markUnresolvedResolved(supabase, { workspaceId, source: 'fellow', externalId: noteId, entityId: resolveToEntityId });
  } else if (contacts.length === 0 && !resolveToEntityId && (nonHostEmails.length > 0 || nonHostNames.length > 0)) {
    await recordUnresolved(supabase, {
      workspaceId, source: 'fellow', kind: 'meeting', externalId: noteId,
      title, occurredAt, detectedNames: nonHostNames, detectedEmails: nonHostEmails,
      summary: aiNotes || null, raw: { note_id: noteId },
    });
  }

  const linked = contacts.length;
  const sysSummary = linked === 0
    ? `Fellow meeting received: ${title} — no contacts resolved (no matchable email or speaker name)`
    : `Fellow meeting received: ${title} — ${linked} contact${linked === 1 ? '' : 's'} linked${logged < linked ? ` (${logged} new, ${linked - logged} already recorded)` : ''}`;
  await logSysEvent(supabase, {
    workspaceId, source: 'fellow', eventType: 'webhook_received',
    summary: sysSummary,
    metadata: { note_id: noteId, title, attendees: attendees.length, linked, logged, owner_user_id: meetingOwnerUserId ?? null, host_email: hostEmail, via: body.type === 'poll' ? 'poll' : 'webhook' },
  });

  return { logged, linked, hostEmail, hasTranscript: !!transcriptText };
}

export async function handleFellow(req, res, workspaceId) {
  const body = req.body || {};

  // 1. URL verification — raw challenge, plain text, before any other work (10s budget).
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return res.status(200).type('text/plain').send(body.challenge);
  }

  const supabase = getSupabaseClient();

  // 2. Signature. Any connected rep's secret may have signed it; the env secret is a
  // self-host fallback. A workspace with a Fellow webhook always has a secret, so an
  // unsigned or mis-signed delivery is refused rather than trusted.
  const conns = await getFellowConnections(supabase, workspaceId);
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
  const headers = [req.headers['svix-id'], req.headers['svix-timestamp'], req.headers['svix-signature']];
  const candidates = conns.filter(c => c.signingKey).map(c => ({ secret: c.signingKey, ownerUserId: c.ownerUserId, conn: c }));
  if (process.env.FELLOW_WEBHOOK_SECRET) candidates.push({ secret: process.env.FELLOW_WEBHOOK_SECRET, ownerUserId: null, conn: conns[0] ?? null });
  if (!candidates.length) {
    // Nobody here holds a Fellow webhook — not ours to process.
    return res.status(200).json({ ok: true, skipped: 'no_connection' });
  }
  const signer = candidates.find(c => verifyFellowSignature(c.secret, rawBody, ...headers));
  if (!signer) return res.status(401).json({ error: 'invalid_signature' });

  if (body.event_type !== 'ai_note.generated') {
    return res.status(200).json({ ok: true, skipped: body.event_type || 'unknown_event' });
  }

  // 3. ACK inside Fellow's 15s, then process. Stamp whose webhook it was onto the body so
  // a webhook_inbox retry (which stores req.body) still attributes the call to that rep.
  // Our own email domain travels with the event, so the pipeline can tell which attendee is
  // the host even when Fellow names no organizer. Stamped on the body so a webhook_inbox retry
  // (which stores req.body) resolves the host the same way.
  const accountEmail = signer.conn ? await fellowAccountEmail(supabase, signer.conn) : null;
  req.body = { ...body, _nous_owner_user_id: signer.ownerUserId, accountEmail };
  res.status(200).json({ ok: true, accepted: true });

  try {
    await reprocessFellow(supabase, workspaceId, req.body);
  } catch (err) {
    console.error('[FELLOW_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'fellow', req, err });
  }
}
