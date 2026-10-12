// Fathom webhook handler — receives meeting-ready events and logs meeting_held activities.
// Payload: calendar_invitees[], title, default_summary, recording_start_time, url
// Update-only — never creates new contacts from meeting invitees.

import { createHmac } from 'crypto';
import { getSupabaseClient, saveDocument, resolveMeetingOwner, attributeRelationship, isEntityInternal } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { extractMeetingSignals } from '../../signals/index.mjs';
import { summarizeInternalMeeting } from '../../signals/meetingSummary.mjs';
import { scoreCall, recordSecondRecording } from '../../signals/callScore.mjs';
import { resolveMeetingContacts, sameMeetingAlreadyLogged } from '../../utils/resolveMeeting.mjs';
import { writeEvidenceFile, normalizeMeeting } from '../../lib/evidence/index.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

// When Fathom is connected through the app, we register the webhook via their API and they
// hand back a per-connection signing secret, stored (encrypted) on the connection. That is
// the secret that actually signs inbound deliveries, so it wins. FATHOM_WEBHOOK_SECRET is
// the fallback for the manual-paste path, where the user chose the secret themselves.
async function loadFathomSigningKey(supabase, workspaceId) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('workflow_providers.name', 'fathom')
    .maybeSingle();
  const encryptedKey = conn?.encrypted_credentials?.webhook_signing_key;
  if (!encryptedKey) return null;
  try { return decrypt(encryptedKey); }
  catch { return null; }
}

function verifyFathomSignature(secret, rawBody, webhookId, webhookTimestamp, signatureHeader) {
  if (!secret || !signatureHeader || !webhookId || !webhookTimestamp) return true; // skip if not configured
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(webhookTimestamp, 10)) > 300) return false;

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const secretBytes = Buffer.from(secretKey, 'base64');
  const expected = createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const signatures = signatureHeader.split(' ').map(s => s.split(',').slice(1).join(','));
  return signatures.some(sig => {
    try { return sig === expected; } catch { return false; }
  });
}

export async function reprocessFathom(supabase, workspaceId, payload) {
  payload = payload || {};

  const title       = payload.title || payload.meeting_title || 'Untitled Meeting';
  // default_summary is an object ({ markdown_formatted } when Fathom has generated a
  // recap, {} when it hasn't — which is the common case on the API backfill path, so
  // it must NOT be the only thing the extractor reads).
  const ds          = payload.default_summary;
  const summary     = (ds && typeof ds === 'object' ? ds.markdown_formatted : (typeof ds === 'string' ? ds : null)) || null;
  const occurredAt  = payload.recording_start_time
    ? new Date(payload.recording_start_time).toISOString()
    : (payload.scheduled_start_time ? new Date(payload.scheduled_start_time).toISOString() : new Date().toISOString());
  const meetingUrl  = payload.share_url || payload.url || null;
  // Stable natural key for the meeting — dedups the activity across the webhook and
  // the enrichment-backfill path (both call this function for the same recording).
  const meetingKey  = payload.recording_id || payload.id || `${title}_${occurredAt.slice(0, 10)}`;

  const invitees = (payload.calendar_invitees || []).filter(i => i.email?.includes('@'));
  if (!invitees.length) return { logged: 0, skipped: 'no_invitees' };

  // Fathom's transcript labels each line with the speaker's display_name and,
  // when it can, the calendar-invitee email that speaker maps to. Use it to (a)
  // give each attendee the name actually spoken on the call and (b) feed the
  // speaker-name fallback for anyone who joined off-invite. (Present only if the
  // Fathom webhook was set up with include_transcript.)
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const nameByEmail = new Map();
  const speakerNameSet = new Set();
  const lines = [];
  for (const seg of transcript) {
    const sp = seg?.speaker;
    const dn = sp?.display_name ? String(sp.display_name).trim() : null;
    if (dn) speakerNameSet.add(dn);
    const em = sp?.matched_calendar_invitee_email ? String(sp.matched_calendar_invitee_email).toLowerCase().trim() : null;
    if (em && dn && !nameByEmail.has(em)) nameByEmail.set(em, dn);
    const txt = seg?.text ? String(seg.text).trim() : '';
    if (txt) lines.push(dn ? `${dn}: ${txt}` : txt);
  }
  const transcriptText = lines.join('\n').slice(0, 100000) || null;

  // What the fact extractor actually reads. The full transcript is the richest intent
  // signal; default_summary is frequently empty on the API backfill path, so falling
  // back to it alone would extract nothing. Mirrors the Fireflies handler.
  const extractionText = (transcriptText && transcriptText.length >= 40) ? transcriptText : summary;
  // Stored meeting_notes: recap on top when present, full transcript below.
  const notesContent = [
    summary,
    transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null,
  ].filter(Boolean).join('\n\n') || null;
  // Timeline blurb: the recap when present, else a transcript snippet (the full text
  // lives in the notes document above).
  const activitySummary = summary || (transcriptText ? transcriptText.slice(0, 2000) : null);

  // Attach to EXTERNAL invitees only — never the host/your own team (Fathom flags
  // internal attendees with is_external:false; unknown is kept). Prefer the
  // transcript speaker name over the raw invitee name. The shared layer then
  // enforces email-only matching, host exclusion, co-attendance, and creation.
  const attendees = invitees
    .filter(i => i.is_external !== false)
    .map(i => ({ email: i.email, name: nameByEmail.get(i.email?.toLowerCase().trim()) || i.matched_speaker_display_name || i.name || null }));

  // The host is the internal invitee Fathom flags is_external:false — recover it
  // so each external attendee's relationship attributes to the hosting rep.
  const hostEmail = invitees.find(i => i.is_external === false)?.email || null;
  const meetingOwnerUserId = await resolveMeetingOwner(supabase, workspaceId, hostEmail);

  const contacts = await resolveMeetingContacts(supabase, workspaceId, {
    startTime:      occurredAt,
    title,
    attendees,
    organizerEmail: hostEmail,
    source:         'fathom',
    speakerNames:   [...speakerNameSet],
    createMissing:  true,
  });

  // Same-meeting guard: if another note-taker (Fireflies, or a second Fathom account)
  // already logged this exact call, don't create a second timeline entry or re-extract —
  // that would duplicate every claim. See the Data Ingestion doc.
  const dupMeeting = await sameMeetingAlreadyLogged(supabase, workspaceId, {
    contactIds: contacts.map(c => c.id),
    occurredAt,
    externalIdPrefix: `fathom_${meetingKey}_`,
  }).catch(() => false);
  if (dupMeeting) {
    // Another teammate's note-taker already put this call on the timeline. Don't log or extract it
    // twice, but don't drop it either: keep its transcript and add it to the call (GET-246).
    console.log(`[FATHOM_WEBHOOK] workspace=${workspaceId} meeting ${meetingKey}: another recording of a call already ingested — adding it to that call`);
    await recordSecondRecording(supabase, workspaceId, {
      source: 'fathom', meetingId: meetingKey, title, url: meetingUrl, contacts, occurredAt, notesContent,
      transcript: extractionText, hostUserId: meetingOwnerUserId,
      recorder: { email: hostEmail, userId: meetingOwnerUserId },
      namedSpeakers: speakerNameSet.size > 0,
    });
    return { logged: 0, deduped: true };
  }

  let logged = 0;
  // External attendees only, extracted once as a group at the end rather than once
  // each. See extractMeetingSignals — a three-person call used to re-send the whole
  // recap three times, and mine "facts" about our own colleague while it did.
  const externals = [];
  const internals = [];

  for (const contact of contacts) {
    const externalId = `fathom_${meetingKey}_${contact.id}`;

    const result = await logActivity(supabase, {
      workspaceId,
      contactId:  contact.id,
      companyId:  contact.company_id || null,
      type:       'meeting_held',
      source:     'fathom',
      externalId,
      occurredAt,
      description: `Meeting: ${title}`,
      // Recap when Fathom generated one, else a transcript snippet. The full text
      // lives in the meeting_notes document below; extraction reads extractionText.
      summary:    activitySummary,
      rawData:    { title, url: meetingUrl, invitees: invitees.map(i => i.email) },
      ownerUserId: meetingOwnerUserId,
      // Timeline yes, extraction no — that runs once, below, for the whole room.
      suppressExtraction: true,
    });
    if (result) {
      logged++;

      let internal = false;
      try {
        internal = await isEntityInternal(supabase, workspaceId, contact.id);
      } catch { /* on failure treat as external — losing signal is worse */ }

      if (!internal) {
        externals.push({
          contactId:  contact.id,
          activityId: result.id,
          name:       [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
          companyId:  contact.company_id || null,
        });
      } else {
        internals.push(contact.id);
      }

      if (meetingOwnerUserId && !internal) {
        try {
          await attributeRelationship(supabase, workspaceId, contact.id, meetingOwnerUserId, { at: occurredAt });
        } catch (e) { console.warn('[fathom] attribute failed', e.message); }
      }
      // Keep the FULL notes (recap + word-for-word transcript) as a document on the
      // contact — the activity summary is truncated. Gated on `result` so retries
      // (which dedup the activity) don't duplicate the document.
      if (notesContent) {
        await saveDocument(supabase, workspaceId, {
          entityId: contact.id,
          type:     'meeting_notes',
          title:    `Meeting notes — ${title}`,
          content:  notesContent,
          date:     occurredAt,
          source:   'fathom',
          // The transcript/recap is raw content — scope it to the hosting rep + admins.
          // ⚠️ This meta carried NO id at all, which is why dozens of Fathom transcripts averaging
          // tens of thousands of characters sat in the database completely unreachable: the document was
          // saved, and nothing could join a citation to it. source_ref fixes it for good.
          meta:     { source_ref: `source://fathom/${meetingKey}`, meeting_id: meetingKey, url: meetingUrl || null, owner_user_id: meetingOwnerUserId ?? null,
            // Every invitee by address, ours included (GET-459): what decides whether it was internal.
            attendee_emails: invitees.map(i => String(i.email).toLowerCase().trim()).filter(Boolean) },
        }).catch(() => {});
        // Evidence layer — also file the recap+transcript as a markdown file in the
        // hosting rep's personal vault under the account, keyed to the resolved entity
        // (external attendees only; the meeting url dedups one file per account).
        if (!internal && meetingOwnerUserId) {
          const ev = normalizeMeeting({ title, recap: summary, transcript: transcriptText, url: meetingUrl });
          await writeEvidenceFile(supabase, {
            workspaceId, ownerUserId: meetingOwnerUserId, entityId: contact.id, companyId: contact.company_id || null,
            type: 'meeting', source: 'fathom', dedupKey: ev.dedupKey, sourceRef: meetingUrl ? `source://fathom/${meetingKey}` : null,
            occurredAt, title: ev.title, markdown: ev.markdown,
          });
        }
      }
    }
  }

  // One extraction pass over the whole room, reading the transcript (or the recap
  // when that's all we have). This is what populates note.* facts → intent.
  if (externals.length && extractionText) {
    extractMeetingSignals({
      sourceRef:    `source://fathom/${meetingKey}`,
      supabase,
      workspaceId,
      participants: externals,
      summary:      extractionText,
      source:       'fathom',
      occurredAt,
      // Our side by name, so a fact quoting the rep is dropped rather than filed on the customer (GET-417).
      ourNames: [...contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' '))].filter(Boolean),
    }).catch(err => console.warn('[fathom] meeting extraction failed', err.message));
  } else if (internals.length && extractionText) {
    // No customer on the call — mine it for TEAM insights (decisions / blockers / learnings).
    // sourceRef is what lets a quoted insight reach this call later. Same pointer shape
    // the observations carry, so it resolves through the one citation path.
    // The team-insight extractor no longer runs here (GET-467): the meeting summary below is the
    // internal record, and its insights feed Internal Insights.
    // The meeting's one consistent record (GET-445): summary, insights by scope, decisions, next steps.
    summarizeInternalMeeting({ supabase, workspaceId, transcript: extractionText, title: title, occurredAt,
      sourceRef: `source://fathom/${meetingKey}`, sourceSystem: 'fathom', subjectEntityId: internals[0],
      participants: contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) });
  }

  // Coaching v2 (GET-83): score the customer call, then fire the after-call dispatch (inside scoreCall).
  if (externals.length && transcriptText && transcriptText.length >= 200) {
    scoreCall({
      supabase, workspaceId,
      transcript:  extractionText,
      repUserId:   meetingOwnerUserId ?? null,
      entityId:    externals[0]?.contactId ?? null,
      meetingId:   meetingKey,
      source:      'fathom',
      occurredAt,
      // The call page (GET-236): filed on the account, linked back to Fathom.
      title,
      sourceUrl:        meetingUrl,
      accountEntityId:  externals[0]?.companyId || externals[0]?.contactId || null,
      mentionEntityIds: externals.map(e => e.contactId),
      sourceRef:        `source://fathom/${meetingKey}`,
      contacts,
      recorder:         { email: hostEmail, userId: meetingOwnerUserId },
      namedSpeakers:    speakerNameSet.size > 0,
    }).catch(err => console.warn('[fathom] call scoring failed', err.message));
  }

  console.log(`[FATHOM_WEBHOOK] workspace=${workspaceId} logged=${logged}`);

  await logSysEvent(supabase, {
    workspaceId, source: 'fathom', eventType: 'webhook_received',
    summary:    `Meeting recording: ${title} — ${logged} contact${logged === 1 ? '' : 's'} updated`,
    metadata:   { title, logged },
  });

  return { logged };
}

export async function handleFathom(req, res, workspaceId) {
  const supabase = getSupabaseClient();

  // Signature verification (only on live deliveries — retries trust the row).
  // Per-connection secret from the auto-registered webhook first, env secret second.
  const secret = (await loadFathomSigningKey(supabase, workspaceId)) || process.env.FATHOM_WEBHOOK_SECRET;
  if (secret) {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const valid = verifyFathomSignature(
      secret, rawBody,
      req.headers['webhook-id'],
      req.headers['webhook-timestamp'],
      req.headers['webhook-signature'],
    );
    if (!valid) return res.status(401).json({ error: 'invalid_signature' });
  }

  try {
    const result = await reprocessFathom(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[FATHOM_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'fathom', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
