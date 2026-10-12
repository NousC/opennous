// Granola webhook handler.
//
// IMPORTANT: like Fireflies, a Granola webhook is only a notification — it names a
// note (note.generated / note.edited / note.access_granted) but does NOT carry the
// transcript. The body looks like:
//   { "type": "note.generated", "data": { "id": "not_abc123def45678" } }
// So we fetch the full note (GET /v1/notes/{id}?include=transcript) with a connected
// workspace key, then run the same meeting pipeline Fireflies/Fathom use: resolve
// attendees → contacts, log a meeting_held activity per external attendee, save the
// notes document + evidence file, extract signals once for the whole room.
//
// Signature: Granola signs deliveries with the Standard Webhooks scheme (HMAC-SHA256
// over `${webhook-id}.${webhook-timestamp}.${body}`, secret base64, optionally
// whsec_-prefixed) — identical to Fathom, verified in-handler against the per-connection
// signing secret stored on connect. Webhooks are Business/Enterprise-only; on other
// plans nothing is registered and the poller (pollers/granola.mjs) is the ingest path,
// re-using reprocessGranola below.

import { createHmac } from 'crypto';
import { getSupabaseClient, saveDocument, resolveCallHost, attributeRelationship, isEntityInternal } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { extractMeetingSignals } from '../../signals/index.mjs';
import { summarizeInternalMeeting } from '../../signals/meetingSummary.mjs';
import { scoreCall, recordSecondRecording } from '../../signals/callScore.mjs';
import { resolveMeetingContacts, sameMeetingAlreadyLogged } from '../../utils/resolveMeeting.mjs';
import { writeEvidenceFile, normalizeMeeting } from '../../lib/evidence/index.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { recordUnresolved, markUnresolvedResolved } from '../../utils/unresolvedIngest.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

const GRANOLA_BASE = 'https://public-api.granola.ai/v1';

// Granola keys are personal — each rep connects their own, so a workspace can hold
// several Granola connections. We load them all: any one whose key can see the note
// is the one we fetch with, and any one whose signing secret validates the delivery
// is the one that signed it. Returns { apiKey, signingKey, ownerUserId }[].
async function getGranolaConnections(supabase, workspaceId) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', 'granola').maybeSingle();
  if (!provider?.id) return [];
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, owner_user_id')
    .eq('workspace_id', workspaceId).eq('provider_id', provider.id)
    .order('created_at', { ascending: false });
  return (data || []).map(c => {
    let apiKey = null, signingKey = null;
    try { apiKey = decrypt(c.encrypted_credentials?.api_key) || null; } catch { /* skip */ }
    try { signingKey = c.encrypted_credentials?.webhook_signing_key ? decrypt(c.encrypted_credentials.webhook_signing_key) : null; } catch { /* skip */ }
    return { apiKey, signingKey, ownerUserId: c.owner_user_id || null };
  }).filter(c => c.apiKey);
}

// Standard Webhooks signature — byte-for-byte the same scheme Fathom uses.
function verifyGranolaSignature(secret, rawBody, webhookId, webhookTimestamp, signatureHeader) {
  if (!secret || !signatureHeader || !webhookId || !webhookTimestamp) return true; // skip if not configured
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(webhookTimestamp, 10)) > 300) return false;          // 5-min replay window

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretKey, 'base64');
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // Header is space-separated `v1,<sig>` pairs.
  const signatures = signatureHeader.split(' ').map(s => s.split(',').slice(1).join(','));
  return signatures.some(sig => sig === expected);
}

// Fetch a single note (with transcript inline). Returns the note object, null when the
// key can't see it (404/403 — try the next connection), throws on other errors so it
// goes to retry rather than silently dropping.
async function fetchGranolaNote(noteId, apiKey) {
  const res = await fetch(`${GRANOLA_BASE}/notes/${encodeURIComponent(noteId)}?include=transcript`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`granola_api_${res.status}`);
  return res.json().catch(() => null);
}

// Oversized transcripts come back as "TRANSCRIPT_TOO_LARGE" inline — pull them from the
// dedicated paginated endpoint. Bounded so a marathon call can't loop forever.
async function fetchGranolaTranscript(noteId, apiKey) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${GRANOLA_BASE}/notes/${encodeURIComponent(noteId)}/transcript`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) break;
    const d = await res.json().catch(() => ({}));
    const chunk = Array.isArray(d?.transcript) ? d.transcript : (Array.isArray(d?.items) ? d.items : []);
    items.push(...chunk);
    if (!d?.hasMore || !d?.cursor) break;
    cursor = d.cursor;
  }
  return items;
}

// Stitch Granola transcript items into a readable "Speaker: line" block + the set of
// distinct speaker names (the speaker-name resolution tier's input). A transcript item is
// { text, start_time, end_time, speaker } where speaker is a string, { name/display_name }, or —
// what Granola's desktop capture actually sends — { source: 'microphone'|'speaker',
// attribution: 'me'|'them' }: the recorder's own microphone vs everyone else's audio.
//
// Those lines used to come out with no label at all, so the call review could not tell the rep
// from the buyer and guessed names and roles (GET-236). Now "me" is the note's owner by name and
// "them" is "Them", and the timings give the rep's measured share of the talking.
export function buildGranolaTranscript(items, ownerName = null) {
  if (!Array.isArray(items) || !items.length) return { text: null, speakerNames: [], repTalkShare: null };
  const lines = [];
  const names = new Set();
  let meMs = 0, themMs = 0;
  for (const it of items) {
    const sp = it?.speaker;
    const side = sp && typeof sp === 'object'
      ? (sp.attribution === 'me' || sp.source === 'microphone' ? 'me'
        : sp.attribution === 'them' || sp.source === 'speaker' ? 'them' : null)
      : null;
    const named = typeof sp === 'string' ? sp.trim() : (sp?.name || sp?.display_name || '').trim();
    if (named && !/^speaker\s*\d*$/i.test(named)) names.add(named);
    const label = named || (side === 'me' ? (ownerName || 'Me') : side === 'them' ? 'Them' : '');
    const txt = String(it?.text || '').trim();
    if (txt) lines.push(label ? `${label}: ${txt}` : txt);
    const ms = Date.parse(it?.end_time) - Date.parse(it?.start_time);
    if (Number.isFinite(ms) && ms > 0) {
      if (side === 'me') meMs += ms;
      else if (side === 'them') themMs += ms;
    }
  }
  const text = lines.join('\n').trim().slice(0, 100_000) || null;
  const repTalkShare = meMs + themMs > 0 ? meMs / (meMs + themMs) : null;
  return { text, speakerNames: [...names], repTalkShare };
}

// Normalize Granola attendees/owner into {name,email}, deduped by email — same contract
// as the Fireflies handler's normalizer, kept local so the two can't drift.
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
    else add(a.email, a.name || a.display_name);
  }
  for (const e of extraEmails) if (e) add(e, null);
  return [...out.values()];
}

function pickOccurredAt(note) {
  const ce = note?.calendar_event || {};
  const candidate = ce.start_time || ce.start || ce.scheduled_start_time || ce.scheduled_at || note?.created_at;
  if (candidate) {
    const d = new Date(candidate);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export async function reprocessGranola(supabase, workspaceId, body) {
  body = body || {};
  const eventType = body.type || body.event || null;
  // The note id lives under a few shapes across webhook / poll / retry callers.
  const noteId = body?.data?.id || body?.data?.note_id || body?.note_id || body?.id || body?.note?.id || null;
  if (!noteId) throw new Error('note_id_required');

  // Agent-driven resolve (POST /v2/unresolved/:id/resolve re-fires with the chosen
  // contact) — attached in ADDITION to normal resolution, mirroring Fireflies.
  const resolveToEntityId = body?.resolveToEntityId || body?.resolve_to_entity_id || null;

  const connections = await getGranolaConnections(supabase, workspaceId);

  // Accept an already-hydrated note (webhook-retry of an enriched body); else fetch it
  // with whichever connected key can see it.
  let note = (body?.note && typeof body.note === 'object' && body.note.title !== undefined) ? body.note : null;
  let fetchKey = null;
  let recorderUserId = null;   // the teammate whose Granola key could see the note
  if (!note) {
    if (!connections.length) {
      await logSysEvent(supabase, {
        workspaceId, source: 'granola', eventType: 'webhook_received',
        summary:  `Granola event received (note ${noteId}) but Granola isn't connected here — connect it in Integrations to ingest notes`,
        metadata: { note_id: noteId, event_type: eventType, logged: 0, reason: 'no_connection' },
      });
      return { logged: 0, reason: 'no_connection' };
    }
    let lastErr = null;
    for (const c of connections) {
      try {
        const n = await fetchGranolaNote(noteId, c.apiKey);
        if (n) { note = n; fetchKey = c.apiKey; recorderUserId = c.ownerUserId; break; }
      } catch (err) { lastErr = err; }
    }
    if (!note) {
      // Every connected key threw (bad key / API down) → surface for retry.
      if (lastErr) throw lastErr;
      // Note is simply not visible to any connected key (test event, or belongs to a
      // rep who hasn't connected). Not an error — record and move on.
      await logSysEvent(supabase, {
        workspaceId, source: 'granola', eventType: 'webhook_received',
        summary:  `Granola event received (note ${noteId}) — no connected key can see it (likely a test event, or the owner hasn't connected Granola)`,
        metadata: { note_id: noteId, event_type: eventType, logged: 0, reason: 'note_not_found' },
      });
      return { logged: 0, reason: 'note_not_found' };
    }
  }

  const title      = note.title || note.calendar_event?.title || 'Untitled Meeting';
  const summary    = note.summary_markdown || note.summary_text || null;
  const ownerEmail = note.owner?.email || null;   // the rep whose Granola recorded it = host
  const webUrl     = note.web_url || null;
  const occurredAt = pickOccurredAt(note);

  // Transcript: inline unless too large, then pull it from the paginated endpoint.
  let transcriptItems = Array.isArray(note.transcript) ? note.transcript : [];
  const tooLarge = note.transcript === 'TRANSCRIPT_TOO_LARGE'
    || (transcriptItems.length === 1 && transcriptItems[0] === 'TRANSCRIPT_TOO_LARGE');
  if ((tooLarge || !transcriptItems.length) && (fetchKey || connections[0]?.apiKey)) {
    const key = fetchKey || connections[0].apiKey;
    transcriptItems = await fetchGranolaTranscript(noteId, key).catch(() => []);
  }
  const { text: transcriptText, speakerNames, repTalkShare } = buildGranolaTranscript(transcriptItems, note.owner?.name || null);

  // Attendees → {name,email}. Include the owner and the calendar organizer so the host
  // is present for exclusion; the shared layer enforces host exclusion + creation.
  const attendees = normalizeParticipants(
    note.attendees,
    ownerEmail,
    note.calendar_event?.organizer?.email,
  );

  // What the fact extractor reads — the verbatim transcript is the richest intent
  // signal; the AI summary is the display fallback. Mirrors Fireflies exactly.
  const extractionText = (transcriptText && transcriptText.length >= 40)
    ? transcriptText.slice(0, 200_000)
    : summary;
  const meetingSummary = summary
    || (transcriptText ? transcriptText.slice(0, 12_000) : `Meeting: ${title}`);
  const notesContent = [
    summary,
    transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null,
  ].filter(Boolean).join('\n\n') || null;

  // Resolve who this meeting belongs to: attendee identity match + co-attendance +
  // transcript speaker-name match. Owner (the rep) is the host to exclude.
  const contacts = await resolveMeetingContacts(supabase, workspaceId, {
    startTime:      occurredAt,
    title,
    attendees,
    organizerEmail: ownerEmail,
    source:         'granola',
    speakerNames,
    createMissing:  true,
  });

  if (resolveToEntityId && !contacts.some(c => c.id === resolveToEntityId)) {
    const { data: forced } = await supabase.from('contacts')
      .select('id, company_id, company, email, first_name, last_name, channels')
      .eq('workspace_id', workspaceId).eq('id', resolveToEntityId).maybeSingle();
    if (forced) contacts.push(forced);
    else console.warn(`[GRANOLA_WEBHOOK] resolveToEntityId ${resolveToEntityId} not found in ws ${workspaceId}`);
  }

  // Who owns the call (GET-246): the calendar organizer when they are on the team, whoever
  // recorded it; otherwise the teammate whose Granola recorded it. Relationships, the evidence
  // file and the scorecard all attribute to them.
  const meetingOwnerUserId = await resolveCallHost(supabase, workspaceId, {
    organizerEmail: note.calendar_event?.organizer?.email || null,
    recorderEmail:  ownerEmail,
    recorderUserId,
  });
  const recorder = { name: note.owner?.name || null, email: ownerEmail, userId: recorderUserId };

  // Same-meeting guard: if another note-taker (Fireflies/Fathom) already logged this
  // exact call, don't double-log or re-extract. Different external_id prefix, same room.
  const dupMeeting = await sameMeetingAlreadyLogged(supabase, workspaceId, {
    contactIds: contacts.map(c => c.id),
    occurredAt,
    externalIdPrefix: `granola_${noteId}_`,
  }).catch(() => false);
  if (dupMeeting) {
    // Another teammate's note-taker already put this call on the timeline. Don't log or extract it
    // twice, but don't drop it either: keep its transcript and add it to the call (GET-246).
    console.log(`[GRANOLA_WEBHOOK] workspace=${workspaceId} note ${noteId}: another recording of a call already ingested — adding it to that call`);
    await recordSecondRecording(supabase, workspaceId, {
      source: 'granola', meetingId: noteId, title, url: webUrl, contacts, occurredAt, notesContent,
      transcript: extractionText, hostUserId: meetingOwnerUserId, recorder,
      namedSpeakers: speakerNames.length > 0, repTalkShare,
    });
    return { logged: 0, deduped: true };
  }

  let logged = 0;
  const externals = [];
  const internals = [];

  for (const contact of contacts) {
    const result = await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'meeting_held',
      source:      'granola',
      externalId:  `granola_${noteId}_${contact.id}`,
      occurredAt,
      description: `Meeting: ${title}`,
      summary:     meetingSummary,
      rawData:     { title, note_id: noteId, url: webUrl },
      ownerUserId: meetingOwnerUserId,
      // Timeline for every attendee; extraction runs ONCE for the room, below.
      suppressExtraction: true,
    });
    if (!result) continue;
    logged++;

    let internal = false;
    try { internal = await isEntityInternal(supabase, workspaceId, contact.id); }
    catch { /* on failure treat as external — losing signal is worse */ }

    if (!internal) {
      externals.push({
        contactId:  contact.id,
        activityId: result.id,
        name:       [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
        company:    contact.company || null,
        companyId:  contact.company_id || null,
      });
    } else {
      internals.push(contact.id);
    }

    if (meetingOwnerUserId && !internal) {
      try { await attributeRelationship(supabase, workspaceId, contact.id, meetingOwnerUserId, { at: occurredAt }); }
      catch (e) { console.warn('[granola] attribute failed', e.message); }
    }

    // ONE meeting-notes document per call (summary on top, transcript below), plus an
    // evidence file in the hosting rep's vault. Gated on `result` so retries don't dup.
    if (notesContent) {
      await saveDocument(supabase, workspaceId, {
        entityId: contact.id,
        type:     'meeting_notes',
        title:    `Meeting notes — ${title}`,
        content:  notesContent,
        date:     occurredAt,
        source:   'granola',
        // source_ref — the one join key across every note-taker. See fireflies.mjs.
        meta:     { source_ref: `source://granola/${noteId}`, note_id: noteId, url: webUrl || null, owner_user_id: meetingOwnerUserId ?? null,
          // Everyone on the invite by address (GET-459): what decides whether it was internal.
          attendee_emails: attendees.map(a => a.email).filter(Boolean) },
      }).catch(() => {});
      if (!internal && meetingOwnerUserId) {
        const ev = normalizeMeeting({ title, recap: summary, transcript: transcriptText, url: webUrl });
        await writeEvidenceFile(supabase, {
          workspaceId, ownerUserId: meetingOwnerUserId, entityId: contact.id, companyId: contact.company_id || null,
          type: 'meeting', source: 'granola', dedupKey: `granola:${noteId}`, sourceRef: `source://granola/${noteId}`,
          occurredAt, title: ev.title, markdown: ev.markdown,
        });
      }
    }
  }

  // One extraction pass over the whole room (external calls → CRM facts/intent;
  // internal-only calls → team insights).
  if (externals.length && extractionText) {
    extractMeetingSignals({ supabase, workspaceId, participants: externals, summary: extractionText,
      source: 'granola', occurredAt, sourceRef: `source://granola/${noteId}`,
      // Our side by name, so a fact quoting the rep is dropped rather than filed on the customer (GET-417).
      ourNames: [...contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')), recorder?.name].filter(Boolean) })
      .catch(err => console.warn('[granola] meeting extraction failed', err.message));
  } else if (internals.length && extractionText) {
    // sourceRef is what lets a quoted insight reach this call later. Same pointer shape
    // the observations carry, so it resolves through the one citation path.
    // The team-insight extractor no longer runs here (GET-467): the meeting summary below is the
    // internal record, and its insights feed Internal Insights.
    // The meeting's one consistent record (GET-445): summary, insights by scope, decisions, next steps.
    summarizeInternalMeeting({ supabase, workspaceId, transcript: extractionText, title: title, occurredAt,
      sourceRef: `source://granola/${noteId}`, sourceSystem: 'granola', subjectEntityId: internals[0],
      participants: contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) });
  }

  // Coaching v2 (GET-83): score the customer call, then fire the after-call dispatch (inside scoreCall).
  if (externals.length && transcriptText && transcriptText.length >= 200) {
    scoreCall({
      supabase, workspaceId,
      transcript:  extractionText,
      repUserId:   meetingOwnerUserId ?? null,
      entityId:    externals[0]?.contactId ?? null,
      meetingId:   noteId,
      source:      'granola',
      occurredAt,
      // The call page (GET-236): filed on the account, linked back to Granola.
      title,
      sourceUrl:        webUrl,
      accountEntityId:  externals[0]?.companyId || externals[0]?.contactId || null,
      mentionEntityIds: externals.map(e => e.contactId),
      sourceRef:        `source://granola/${noteId}`,
      contacts,
      recorder,
      namedSpeakers:    speakerNames.length > 0,
      repTalkShare,
    }).catch(err => console.warn('[granola] call scoring failed', err.message));
  }

  // Unresolved queue: a call that clearly had an external party we couldn't identify →
  // capture it so an agent can resolve it (which re-fires this handler with an entity).
  const ownerLc = (ownerEmail || '').toLowerCase();
  const nonHostEmails = [...new Set(attendees.map(p => (p.email || '').toLowerCase()).filter(e => e && e !== ownerLc))];
  const nonHostNames  = [...new Set([
    ...attendees.filter(p => (p.email || '').toLowerCase() !== ownerLc).map(p => p.name).filter(Boolean),
    ...speakerNames,
  ])];
  const externalExpected = nonHostEmails.length > 0 || nonHostNames.length > 0;

  // Same gate as fireflies.mjs, same reason: `logged` counts only NEW rows, so a
  // re-delivered note that is already linked to the right people reads as zero and
  // gets filed as unresolved. Gate on who it linked to.
  //
  // A call with nobody but the host on the invite (GET-444) — an ad-hoc sync, a co-founder call
  // started from Granola — resolves to no one, because the host is "us". It used to be dropped
  // without a trace: no meeting, no notes, no team insights. It is not auto-filed as internal
  // either, because a recorder's Granola also holds calls for other companies and a quick call
  // with a buyer looks the same. So it goes to the unresolved queue, where saying who was on it
  // (a teammate → an internal meeting; a buyer → their account) re-runs this handler.
  const hostOnly = !externalExpected && !!transcriptText;
  if (contacts.length === 0 && !resolveToEntityId && (externalExpected || hostOnly)) {
    await recordUnresolved(supabase, {
      workspaceId, source: 'granola', kind: 'meeting', externalId: noteId,
      title, occurredAt, detectedNames: nonHostNames, detectedEmails: nonHostEmails,
      summary: summary || null, raw: { note_id: noteId },
    });
  } else if (contacts.length > 0 && resolveToEntityId) {
    await markUnresolvedResolved(supabase, { workspaceId, source: 'granola', externalId: noteId, entityId: resolveToEntityId });
  }

  const linked = contacts.length;
  const sysSummary = linked === 0
    ? `Granola note received: ${title} — no contacts resolved (no matchable email or speaker name)`
    : `Granola note received: ${title} — ${linked} contact${linked === 1 ? '' : 's'} linked${logged < linked ? ` (${logged} new, ${linked - logged} already recorded)` : ''}`;
  await logSysEvent(supabase, {
    workspaceId, source: 'granola', eventType: 'webhook_received',
    summary: sysSummary,
    metadata: { note_id: noteId, title, attendees: attendees.length, linked, logged, owner_user_id: meetingOwnerUserId ?? null },
  });

  return { logged };
}

export async function handleGranola(req, res, workspaceId) {
  const supabase = getSupabaseClient();

  // Signature verification (live deliveries only — retries trust the stored row).
  // Any connected rep's signing secret may have signed this delivery; env secret is a
  // self-host fallback. No secret anywhere → skip, like the Fathom manual path.
  const conns = await getGranolaConnections(supabase, workspaceId);
  const secrets = conns.map(c => c.signingKey).filter(Boolean);
  if (process.env.GRANOLA_WEBHOOK_SECRET) secrets.push(process.env.GRANOLA_WEBHOOK_SECRET);
  if (secrets.length) {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const valid = secrets.some(s => verifyGranolaSignature(
      s, rawBody,
      req.headers['webhook-id'],
      req.headers['webhook-timestamp'],
      req.headers['webhook-signature'],
    ));
    if (!valid) return res.status(401).json({ error: 'invalid_signature' });
  }

  try {
    const result = await reprocessGranola(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[GRANOLA_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'granola', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
