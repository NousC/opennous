// Fireflies.ai webhook handler.
//
// IMPORTANT: a Fireflies webhook is only a notification PING — it does NOT carry
// the transcript. The body looks like:
//   { "meetingId": "FFmtg0000example", "eventType": "Transcription completed" }
// To get participants/title/summary we must fetch the transcript from the
// Fireflies GraphQL API using the meetingId plus the workspace's stored API key.
// (The previous version read participants straight out of req.body, so every
// real webhook AND every test event short-circuited to a silent no-op.)

import { getSupabaseClient, saveDocument, resolveMeetingOwner, attributeRelationship, isEntityInternal } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { extractMeetingSignals } from '../../signals/index.mjs';
import { summarizeInternalMeeting } from '../../signals/meetingSummary.mjs';
import { scoreCall, recordSecondRecording } from '../../signals/callScore.mjs';
import { resolveMeetingContacts, sameMeetingAlreadyLogged } from '../../utils/resolveMeeting.mjs';
import { writeEvidenceFile, normalizeMeeting } from '../../lib/evidence/index.mjs';
import { parseActionItems, recordActionItems } from '../../utils/actionItems.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { recordUnresolved, markUnresolvedResolved } from '../../utils/unresolvedIngest.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

async function extractMeetingFacts(title, participants) {
  const names = participants.map(p => p.name || p.email).filter(Boolean).join(', ');
  return `Meeting: ${title || 'Untitled'}${names ? ` — participants: ${names}` : ''}`;
}

// Pull the workspace's Fireflies API key (BYOK), mirroring getProviderApiKey in
// utils/verifyLead.mjs. Returns null when Fireflies isn't connected here.
async function getFirefliesApiKey(supabase, workspaceId) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', 'fireflies').maybeSingle();
  if (!provider?.id) return null;
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials')
    .eq('workspace_id', workspaceId).eq('provider_id', provider.id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!data?.encrypted_credentials) return null;
  try { return decrypt(data.encrypted_credentials.api_key) || null; } catch { return null; }
}

// Fetch a single transcript by id. Returns the transcript object, or null when
// Fireflies has no transcript for that id (e.g. a test-event ping with a fake id).
async function fetchFirefliesTranscript(meetingId, apiKey) {
  const query = `query Transcript($id: String!) {
    transcript(id: $id) {
      id title date duration transcript_url
      host_email organizer_email
      participants
      meeting_attendees { displayName email name }
      summary { overview action_items keywords short_summary }
      sentences { speaker_name text start_time }
    }
  }`;
  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables: { id: meetingId } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 401/403 → bad key; surface so it goes to retry/inbox rather than silently dropping.
    throw new Error(`fireflies_api_${res.status}: ${data?.errors?.[0]?.message || 'request failed'}`);
  }
  // A not-found / test-event id comes back as a GraphQL error or null transcript.
  if (data?.errors?.length && !data?.data?.transcript) return null;
  return data?.data?.transcript || null;
}

// Stitch Fireflies sentences into a readable "Speaker: line" transcript. Bounded
// so a multi-hour call can't blow up the stored document or its embedding.
// Distinct speaker labels from a "Name: text\n..." transcript. Fireflies labels
// each line with who spoke, so this recovers the participant names even when the
// webhook's attendee list is just the host — the input to the speaker-name
// resolution tier. Single-token first names ARE kept now: the matcher downstream
// gates a first-name-only label behind a unique-external-contact check, so the
// common "host recorded a 1:1, guest labeled by first name only" call can still
// resolve. Only the generic "Speaker" / "Speaker 2" placeholders are dropped.
function speakerNamesFromTranscript(text) {
  if (!text) return [];
  const names = new Set();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([^:]{2,60}):\s/);
    if (!m) continue;
    const n = m[1].trim();
    if (!n || n.length < 2) continue;
    if (/^speaker\s*\d*$/i.test(n)) continue;   // generic Fireflies placeholder
    names.add(n);
  }
  return [...names];
}

// A CUE INDEX: where in the call each line was said.
//
// This is what turns "open the transcript" into "open the transcript AT the sentence we
// quoted". A citation that drops somebody at the top of a fifty-minute call and leaves them
// to find the line is a citation most people do not actually check — and a proof nobody
// checks is decoration.
//
// Stored as pairs rather than objects, and truncated hard, because this rides along inside
// the observation's raw payload on every attendee's timeline. `[[128, "we'd need procurement
// to sign off on"], ...]` is enough to find a quote and costs a fraction of the transcript
// it indexes. Normalized on the way IN so matching does not have to normalize 1,500 strings
// on the way out.
const CUE_TEXT_CHARS = 64;
const MAX_CUES = 1500;

export function normalizeCue(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildCues(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return null;
  const out = [];
  for (const s of sentences) {
    // Fireflies gives start_time in seconds. A missing one is not a reason to drop the line
    // from the transcript, but it IS a reason to leave it out of here: a cue with no time
    // would produce a link to second zero, which is a wrong answer wearing a right shape.
    const t = Number(s?.start_time);
    if (!Number.isFinite(t) || t < 0) continue;
    const norm = normalizeCue(s?.text).slice(0, CUE_TEXT_CHARS);
    if (norm.length < 8) continue;               // "yeah", "mm-hm" — matches everything, locates nothing
    out.push([Math.round(t), norm]);
    if (out.length >= MAX_CUES) break;
  }
  return out.length ? out : null;
}

function buildTranscriptText(sentences) {
  if (!Array.isArray(sentences) || !sentences.length) return null;
  const lines = [];
  for (const s of sentences) {
    const txt = String(s?.text || '').trim();
    if (txt) lines.push(`${s?.speaker_name || 'Speaker'}: ${txt}`);
  }
  const out = lines.join('\n').trim();
  return out ? out.slice(0, 100_000) : null;
}

// Normalize the various participant shapes Fireflies returns into {name, email},
// deduped by email (falling back to name). Accepts:
//   - meeting_attendees: [{ displayName, email, name }]
//   - participants: [String] (emails) OR [{ name, email }] (older shape / enriched body)
//   - host_email / organizer_email: bare strings
function normalizeParticipants(participants = [], attendees = [], ...extraEmails) {
  const out = new Map();
  const addOne = (email, name) => {
    const e = email ? String(email).toLowerCase().trim() : null;
    const n = name ? String(name).trim() : null;
    if (!e && !n) return;
    const key = e || `name:${n.toLowerCase()}`;
    const prev = out.get(key);
    out.set(key, { email: e || prev?.email || null, name: n || prev?.name || null });
  };
  // One attendee record can carry SEVERAL addresses in its email field — the
  // source joins them with a comma. Everything downstream counts attendees, and
  // the email-learning step in resolveMeetingContacts only fires when there is
  // "exactly one unresolved address", so an unsplit pair satisfied that guard
  // while being two people: `avery@fernpoint.example,theo@gmail.example` was
  // attached to a prospect's record as one identifier that matches nothing, ever.
  // One value must mean one address before anything counts them.
  const add = (email, name) => {
    const parts = String(email ?? '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return addOne(email, name);
    // The name belongs to whoever the source listed first; the rest are addresses
    // we know of but cannot attribute, so they arrive nameless.
    parts.forEach((p, i) => addOne(p, i === 0 ? name : null));
  };
  for (const a of attendees || []) {
    if (!a) continue;
    if (typeof a === 'string') add(a, null);
    else add(a.email, a.displayName || a.name);
  }
  for (const p of participants || []) {
    if (!p) continue;
    if (typeof p === 'string') add(p, null);
    else add(p.email, p.name);
  }
  for (const e of extraEmails) if (e) add(e, null);
  return [...out.values()];
}

/** The GraphQL fields a hydrated transcript needs: with them, reprocessFireflies skips its own fetch. */
export const FIREFLIES_TRANSCRIPT_FIELDS = `id title date host_email organizer_email
        participants
        meeting_attendees { displayName email name }
        summary { overview action_items keywords }
        sentences { speaker_name text }`;

/** A listed transcript → the hydrated body reprocessFireflies takes (backfill replay and poller). */
export function firefliesBodyFromTranscript(t) {
  return {
    meetingId:       t.id,
    title:           t.title,
    date:            t.date,
    host_email:      t.host_email,
    organizer_email: t.organizer_email,
    participants:    t.participants,
    meeting_attendees: t.meeting_attendees,
    summary:         t.summary?.overview || null,
    action_items:    t.summary?.action_items || null,
    keywords:        Array.isArray(t.summary?.keywords) ? t.summary.keywords : [],
    transcript_text: (t.sentences || []).map(sn => `${sn.speaker_name || 'Speaker'}: ${sn.text || ''}`).join('\n').slice(0, 100000) || null,
  };
}

export async function reprocessFireflies(supabase, workspaceId, body, { onceOnly = false } = {}) {
  const { meetingId, meeting_id, eventType } = body || {};
  const id = meetingId || meeting_id;
  if (!id) throw new Error('meetingId_required');

  // Agent-driven resolve: a caller (POST /v2/unresolved/:id/resolve) re-fires this
  // meeting once it has decided which contact it belongs to. The forced entity is
  // attached below in ADDITION to normal resolution, so the full pipeline (notes +
  // extraction + evidence) runs against the right person.
  const resolveToEntityId = body?.resolveToEntityId || body?.resolve_to_entity_id || null;

  // Accept an already-hydrated body (webhook-retry of an enriched payload, or a
  // self-host manual post). Otherwise fetch the transcript from the API.
  let { title, transcript_url, duration, summary: transcriptSummary } = body || {};
  // Only ever filled from a fetched transcript — the webhook body carries no sentence times,
  // so a body-only path stores no cues rather than storing wrong ones.
  let cues = null;
  let meetingDate    = body?.date || null;
  let actionItems    = body?.action_items || null;
  let keywords       = Array.isArray(body?.keywords) ? body.keywords : [];
  let transcriptText = body?.transcript_text || null;
  let hostEmail      = body?.organizer_email || body?.host_email || null;
  let allParticipants = normalizeParticipants(body?.participants, body?.meeting_attendees);

  if (!allParticipants.length) {
    const apiKey = await getFirefliesApiKey(supabase, workspaceId);
    if (!apiKey) {
      await logSysEvent(supabase, {
        workspaceId, source: 'fireflies', eventType: 'webhook_received',
        summary:  `Fireflies webhook received (meeting ${id}) but Fireflies isn't connected here — connect it in Integrations to ingest transcripts`,
        metadata: { meeting_id: id, event_type: eventType || null, logged: 0, reason: 'no_connection' },
      });
      return { logged: 0, reason: 'no_connection' };
    }

    const t = await fetchFirefliesTranscript(id, apiKey);
    if (!t) {
      await logSysEvent(supabase, {
        workspaceId, source: 'fireflies', eventType: 'webhook_received',
        summary:  `Fireflies webhook received (meeting ${id}) — no matching transcript found (likely a test event)`,
        metadata: { meeting_id: id, event_type: eventType || null, logged: 0, reason: 'transcript_not_found' },
      });
      return { logged: 0, reason: 'transcript_not_found' };
    }

    title             = t.title || title;
    transcript_url    = t.transcript_url || transcript_url;
    duration          = t.duration ?? duration;
    transcriptSummary = t.summary?.overview || transcriptSummary || null;
    actionItems       = t.summary?.action_items || actionItems || null;
    keywords          = Array.isArray(t.summary?.keywords) ? t.summary.keywords : keywords;
    transcriptText    = buildTranscriptText(t.sentences) || transcriptText;
    cues              = buildCues(t.sentences);
    meetingDate       = t.date || meetingDate;
    hostEmail         = t.host_email || t.organizer_email || hostEmail;
    allParticipants   = normalizeParticipants(t.participants, t.meeting_attendees, t.host_email, t.organizer_email);
  }

  // Digest = AI overview + action items + keywords. This is what the activity
  // carries and what feeds the fact extractor (it reads the activity summary) —
  // action items in particular surface next steps, owners, and commitments.
  const digestParts = [];
  if (transcriptSummary) digestParts.push(transcriptSummary);
  if (actionItems)       digestParts.push(`Action items:\n${actionItems}`);
  if (keywords.length)   digestParts.push(`Keywords: ${keywords.slice(0, 20).join(', ')}`);
  const digest = digestParts.join('\n\n').trim() || null;
  // The fact extractor reads `meetingSummary`. Fireflies fires the webhook the
  // moment the raw transcript is ready, but generates its AI summary/overview a
  // little later — so the digest is often still empty here. When it is, mine the
  // full transcript directly (bounded; the extractor caps its own output) rather
  // than falling back to a title-only string that yields zero facts.
  const meetingSummary = digest
    || (transcriptText ? transcriptText.slice(0, 12000) : await extractMeetingFacts(title, allParticipants));
  // What the EXTRACTOR reads is not the display digest. The digest is a lossy AI
  // overview that drops exactly the relationship-direction signal we most want —
  // how they found us, what they offered us, the objection they raised — and, when
  // Fireflies has generated it, it would otherwise be ALL the extractor ever sees.
  // Worse, the empty-digest fallback above hard-cuts the transcript at 12k chars,
  // so a 30-min call lost its back half (that is how an offer made late in a call
  // never reached the model). Feed the verbatim transcript,
  // bounded generously, and keep the digest for display only. The extractor reads a long
  // call in parts (signals/extractionText.mjs), so this bound is a runaway guard — the
  // old 60,000 cut the last third off a long call.
  const extractionText = (transcriptText && transcriptText.length >= 40)
    ? transcriptText.slice(0, 200_000)
    : meetingSummary;
  // Fireflies `date` is an epoch-ms timestamp (or an ISO string on enriched bodies).
  let occurredAt = new Date().toISOString();
  if (meetingDate != null) {
    const d = new Date(meetingDate); // accepts epoch-ms number or ISO string
    if (!isNaN(d.getTime())) occurredAt = d.toISOString();
  }

  // Resolve who this meeting belongs to via the shared layer: attendee identity
  // match PLUS co-attendance (match to an existing booking by time/title). The
  // latter attaches the transcript to the right person even when they joined from
  // an email we don't have on file — and learns that alternate email for next time.
  const contacts = await resolveMeetingContacts(supabase, workspaceId, {
    startTime:      occurredAt,
    title,
    attendees:      allParticipants,
    organizerEmail: hostEmail,
    source:         'fireflies',
    // Who actually spoke — recovered from the transcript so an ad-hoc call with a
    // host-only attendee list still resolves to the person on the other end.
    speakerNames:   speakerNamesFromTranscript(transcriptText),
    // Create a name+email contact for an external attendee we don't have yet
    // (only when Fireflies gave us their email + name — never a bare speaker name).
    createMissing:  true,
  });

  // Agent-driven resolve: force-attach the chosen contact if normal resolution
  // missed it (the whole reason this meeting sat unresolved). Additive + deduped
  // by id, so it composes with anything resolution already found.
  if (resolveToEntityId && !contacts.some(c => c.id === resolveToEntityId)) {
    const { data: forced } = await supabase.from('contacts')
      .select('id, company_id, company, email, first_name, last_name, channels')
      .eq('workspace_id', workspaceId).eq('id', resolveToEntityId).maybeSingle();
    if (forced) contacts.push(forced);
    else console.warn(`[FIREFLIES_WEBHOOK] resolveToEntityId ${resolveToEntityId} not found in ws ${workspaceId}`);
  }

  // Which rep hosted this call — so each external attendee's relationship
  // attributes to them. Resolved from the meeting host/organizer email.
  const meetingOwnerUserId = await resolveMeetingOwner(supabase, workspaceId, hostEmail);

  // Same-meeting guard: if another note-taker (a second Fireflies account, or Fathom)
  // already logged this exact call, don't create a second timeline entry or re-extract —
  // that would duplicate every claim. The first note-taker's meeting stays the single
  // record (owned by the host; claims shared). See the Data Ingestion doc.
  const dupMeeting = await sameMeetingAlreadyLogged(supabase, workspaceId, {
    contactIds: contacts.map(c => c.id),
    occurredAt,
    externalIdPrefix: `ff_${id}_`,
  }).catch(() => false);
  if (dupMeeting) {
    // Another teammate's note-taker already put this call on the timeline. Don't log or extract it
    // twice, but don't drop it either: keep its transcript and add it to the call (GET-246).
    console.log(`[FIREFLIES_WEBHOOK] workspace=${workspaceId} meeting ${id}: another recording of a call already ingested — adding it to that call`);
    await recordSecondRecording(supabase, workspaceId, {
      source: 'fireflies', meetingId: id, title: title || 'Meeting', url: transcript_url || null, contacts, occurredAt,
      notesContent: [digest, transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null].filter(Boolean).join('\n\n') || null,
      transcript: extractionText, hostUserId: meetingOwnerUserId,
      recorder: { email: hostEmail, userId: meetingOwnerUserId },
      namedSpeakers: speakerNamesFromTranscript(transcriptText).length > 0,
    });
    return { logged: 0, deduped: true };
  }

  let logged = 0;
  // The external attendees, with the activity row each of them got. Extraction
  // runs ONCE over this whole list at the end, instead of once per attendee — see
  // extractMeetingSignals. Internal teammates never enter it: a colleague on the
  // call is not someone we mine "durable CRM facts" about.
  const externals = [];
  const internals = [];

  for (const contact of contacts) {
    const result = await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'meeting_held',
      source:      'fireflies',
      externalId:  `ff_${id}_${contact.id}`,
      occurredAt:  occurredAt || new Date().toISOString(),
      description: title || 'Meeting recorded',
      summary:     meetingSummary,
      // `cues` is the deep-citation index — see buildCues. Only present on meetings
      // recorded after it shipped; the link resolver falls back to the transcript's top.
      rawData:     { transcript_url, meeting_id: id, duration, ...(cues ? { cues } : {}) },
      ownerUserId: meetingOwnerUserId,
      // Every attendee still gets the call on their timeline. Extraction is the
      // thing that must not run N times over one transcript.
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
          company:    contact.company || null,
          companyId:  contact.company_id || null,
        });
      } else {
        internals.push(contact.id);
      }

      // Attribute the relationship to the hosting rep (skip internal attendees —
      // a teammate on the call is not a relationship of the host).
      if (meetingOwnerUserId && !internal) {
        try {
          await attributeRelationship(supabase, workspaceId, contact.id, meetingOwnerUserId, { at: occurredAt });
        } catch (e) { console.warn('[fireflies] attribute failed', e.message); }
      }
      // ONE "Meeting notes" document per call: the digest (summary + action items
      // + keywords) on top, the full word-for-word transcript below. Kept in the
      // Notes tab, out of the timeline. Gated on `result` so webhook retries don't
      // duplicate it.
      const notesContent = [
        digest,
        transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null,
      ].filter(Boolean).join('\n\n') || null;
      if (notesContent) {
        await saveDocument(supabase, workspaceId, {
          entityId: contact.id,
          type:     'meeting_notes',
          title:    `Meeting notes — ${title || 'Untitled'}`,
          content:  notesContent,
          date:     new Date().toISOString(),
          source:   'fireflies',
          // The transcript is raw content — scope it to the hosting rep + admins.
          // ⭐ source_ref is THE join key: the same pointer every citation carries, so a
          // claim → observation → this document resolves in one hop. meeting_id stays for
          // the rows written before it, and for nothing else — three provider-specific id
          // shapes is three joins to keep in sync, and the one that got forgotten (fathom)
          // left full transcripts in the database that nothing could ever reach.
          meta:     { source_ref: `source://fireflies/${id}`, meeting_id: id, transcript_url: transcript_url || null, duration: duration || null, owner_user_id: meetingOwnerUserId ?? null,
            // Everyone on the call by address (GET-459): what decides whether it was internal.
            attendee_emails: allParticipants.map(p => p.email).filter(Boolean) },
        }).catch(() => {});
        // Evidence layer — file the recap+transcript in the hosting rep's vault under the account.
        if (!internal && meetingOwnerUserId) {
          const ev = normalizeMeeting({ title: title || 'Meeting', recap: digest, transcript: transcriptText, url: transcript_url });
          await writeEvidenceFile(supabase, {
            workspaceId, ownerUserId: meetingOwnerUserId, entityId: contact.id, companyId: contact.company_id || null,
            type: 'meeting', source: 'fireflies', dedupKey: `ff:${id}`, sourceRef: `source://fireflies/${id}`,
            occurredAt: new Date().toISOString(), title: ev.title, markdown: ev.markdown,
          });
        }
      }
    }

  }

  // One extraction pass over the whole room. Cheaper than one-per-attendee, and
  // it can finally see relationships that only exist BETWEEN the people on the
  // call — who defers to whom, who actually holds the budget.
  if (externals.length) {
    extractMeetingSignals({
      onceOnly,
      sourceRef:    `source://fireflies/${id}`,
      supabase,
      workspaceId,
      participants: externals,
      summary:      extractionText,
      source:       'fireflies',
      occurredAt,
      // Our side by name, so a fact quoting the rep is dropped rather than filed on the customer (GET-417).
      ourNames: [...contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' '))].filter(Boolean),
    }).catch(err => console.warn('[fireflies] meeting extraction failed', err.message));
  } else if (internals.length) {
    // No customer on the call — mine it for TEAM insights (decisions / blockers / learnings).
    // sourceRef is what lets a quoted insight reach this call later. Same pointer shape
    // the observations carry, so it resolves through the one citation path.
    // The team-insight extractor no longer runs here (GET-467): the meeting summary below is the
    // internal record, and its insights feed Internal Insights.
    // The meeting's one consistent record (GET-445): summary, insights by scope, decisions, next steps.
    summarizeInternalMeeting({ supabase, workspaceId, transcript: extractionText, title: title || 'Meeting', occurredAt,
      sourceRef: `source://fireflies/${id}`, sourceSystem: 'fireflies', subjectEntityId: internals[0],
      participants: contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) });
  }

  // Coaching v2 (GET-83): score the customer call against the workspace rubric and store a
  // scorecard, attributed to the hosting rep. Fire-and-forget like extraction; skips thin calls.
  // (Role defaults to the AE rubric for now; per-rep role resolution is a follow-up.)
  if (externals.length && transcriptText && transcriptText.length >= 200) {
    scoreCall({
      supabase, workspaceId,
      transcript:  extractionText,
      repUserId:   meetingOwnerUserId ?? null,
      entityId:    contacts[0]?.id ?? null,
      meetingId:   id,
      source:      'fireflies',
      occurredAt,
      // The call page (GET-236): filed on the account, linked back to Fireflies.
      title:            title || 'Meeting',
      sourceUrl:        transcript_url || null,
      accountEntityId:  externals[0]?.companyId || externals[0]?.contactId || null,
      mentionEntityIds: externals.map(e => e.contactId),
      sourceRef:        `source://fireflies/${id}`,
      contacts,
      recorder:         { email: hostEmail, userId: meetingOwnerUserId },
      namedSpeakers:    speakerNamesFromTranscript(transcriptText).length > 0,
    }).catch(err => console.warn('[fireflies] call scoring failed', err.message));
  }

  // Structured action items → state observations on the meeting's primary account,
  // so the agent can answer "what are my action items" without re-reading notes.
  // Backend-only: action_item.* claims don't render in the contact UI.
  // Not on an internal call: its next steps come from the meeting summary (GET-446), and these
  // filed a teammate's items as a prospect's.
  if (actionItems && contacts.length && externals.length) {
    const primary = contacts[0];
    const parsed = parseActionItems(actionItems);
    if (parsed.length) {
      await recordActionItems(supabase, {
        workspaceId, entityId: primary.id, contact: primary,
        items: parsed, source: 'fireflies', sourceId: id, occurredAt,
      }).catch(() => {});
    }
  }

  // Nothing landed, but the call clearly had an external party we couldn't
  // identify → capture it in the unresolved queue so an agent can resolve it
  // (which re-fires this handler with resolveToEntityId and runs the full
  // pipeline). Skip when a resolve hint was already supplied (this run IS the
  // resolution) and when it was a pure internal/host-only call (nothing to miss).
  const speakerNames = speakerNamesFromTranscript(transcriptText);
  const hostLc = (hostEmail || '').toLowerCase();
  const nonHostEmails = [...new Set(allParticipants
    .map(p => (p.email || '').toLowerCase()).filter(e => e && e !== hostLc))];
  const nonHostNames = [...new Set([
    ...allParticipants.filter(p => (p.email || '').toLowerCase() !== hostLc).map(p => p.name).filter(Boolean),
    ...speakerNames,
  ])];
  const externalExpected = nonHostEmails.length > 0 || nonHostNames.length > 0;

  // Gate on who the meeting LINKED TO, not on how many rows were new. `logged`
  // counts only NEW meeting_held rows — the comment below says so, and the summary
  // counter was already fixed to use `contacts.length` for exactly that reason.
  // This gate never was, so every webhook retry and every Fireflies re-send of an
  // already-ingested call saw logged === 0 and filed a perfectly resolved meeting
  // as unresolved. Every pending row in our own workspace turned out to be fully linked
  // (each meeting to its own contact, the co-founder calls → both founders). A queue
  // that cries wolf on every retry is worse than no queue: the real misses drown.
  if (contacts.length === 0 && !resolveToEntityId && externalExpected) {
    await recordUnresolved(supabase, {
      workspaceId, source: 'fireflies', kind: 'meeting', externalId: id,
      title, occurredAt, detectedNames: nonHostNames, detectedEmails: nonHostEmails,
      summary: digest || transcriptSummary || null, raw: { meeting_id: id },
    });
  } else if (contacts.length > 0 && resolveToEntityId) {
    await markUnresolvedResolved(supabase, { workspaceId, source: 'fireflies', externalId: id, entityId: resolveToEntityId });
  }

  // Honest counter. `logged` only counts NEW meeting_held rows, so on any retry /
  // re-delivery every attendee already has the row and logged drops to 0 — which
  // read as "0 contacts updated" even though resolution succeeded and the call is
  // linked. Report what actually happened: how many contacts the meeting is linked
  // to, and how many were new this run. Only a meeting that resolved to NOBODY is
  // a real "0" — and that case names why (no matchable email or speaker name).
  const linked = contacts.length;
  const summary = linked === 0
    ? `Meeting transcript received: ${title || 'Untitled'} — no contacts resolved (no matchable email or speaker name)`
    : `Meeting transcript received: ${title || 'Untitled'} — ${linked} contact${linked === 1 ? '' : 's'} linked${logged < linked ? ` (${logged} new, ${linked - logged} already recorded)` : ''}`;
  await logSysEvent(supabase, {
    workspaceId, source: 'fireflies', eventType: 'webhook_received',
    summary,
    // Stamp the meeting's owner so this lands in that member's own Activity feed
    // (/connect › Activity), not just the company op log. The host resolved to a
    // connected member above; a meeting nobody here hosted stays owner-less.
    metadata:   { meeting_id: id, title: title || null, attendees: allParticipants.length, linked, logged, owner_user_id: meetingOwnerUserId ?? null },
  });

  return { logged };
}

export async function handleFireflies(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessFireflies(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[FIREFLIES_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'fireflies', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
