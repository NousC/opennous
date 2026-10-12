// RingCentral — a company's phone calls onto the graph (GET-289).
//
// RingCentral is where a sales team actually talks to buyers, and it hands us less than a
// note-taker does: no attendee emails and no meeting title. We get two phone numbers, a caller-ID
// name, a duration and a direction. So this pipeline differs from Fellow's in the two places that
// matter, and matches it everywhere else (logActivity → notes → extraction → call scoring → the
// unresolved queue):
//
//   1. WHO THE BUYER IS comes from the phone number, matched against the phone every contact
//      already carries (the CRM import writes it). A phone number never CREATES a contact: a
//      company's main line is shared by everyone who works there, and a caller-ID name is
//      "WIRELESS CALLER" as often as it is a person. An unmatched call goes to the unresolved
//      queue instead, and resolving it teaches the contact that number.
//   2. THE TRANSCRIPT is RingSense's (RingCentral's AI Conversation Expert) when the account has
//      it. Without RingSense a call is still filed — who, when, how long, which way — but there is
//      nothing to extract or score, by decision (Product decision, 2026-09-16: no transcription vendor in v1).
//
// There is no webhook: RingCentral has no "call ended" event on the account, so the poller
// (pollers/ringcentral.mjs) reads the company call log and hands each finished call here. The
// agent-driven resolve re-fetches one call by its call-log id.

import {
  saveDocument, resolveCallHost, attributeRelationship, isEntityInternal, assertClaims,
  ringCentralAuth, ringCentralGet, callFromCallLog, transcriptFromInsights, phoneKey,
} from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { extractMeetingSignals } from '../../signals/index.mjs';
import { summarizeInternalMeeting } from '../../signals/meetingSummary.mjs';
import { scoreCall } from '../../signals/callScore.mjs';
import { writeEvidenceFile, normalizeMeeting } from '../../lib/evidence/index.mjs';
import { recordUnresolved, markUnresolvedResolved } from '../../utils/unresolvedIngest.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

const SOURCE = 'ringcentral';

/** Every RingCentral connection (optionally one workspace's), credentials decrypted. */
export async function getRingCentralConnections(supabase, workspaceId = null) {
  const { data: provider } = await supabase
    .from('workflow_providers').select('id').eq('name', SOURCE).maybeSingle();
  if (!provider?.id) return [];
  let q = supabase
    .from('workflow_provider_connections')
    .select('id, workspace_id, encrypted_credentials, owner_user_id, is_verified, created_at')
    .eq('provider_id', provider.id)
    .order('created_at', { ascending: false });
  if (workspaceId) q = q.eq('workspace_id', workspaceId);
  const { data } = await q;
  return (data || []).map(c => {
    const creds = c.encrypted_credentials || {};
    const dec = (v) => { try { return v ? decrypt(v) : null; } catch { return null; } };
    const auth = ringCentralAuth({ jwt: dec(creds.jwt), client_id: dec(creds.client_id), client_secret: dec(creds.client_secret) });
    return {
      id:          c.id,
      workspaceId: c.workspace_id,
      auth,
      ownerUserId: c.owner_user_id || null,
      isVerified:  !!c.is_verified,
      createdAt:   c.created_at || null,
      creds,
    };
  }).filter(c => c.auth);
}

// ── Our side: which rep was on the call ─────────────────────────────────────

// Extension → email, per connection. An extension's email changes about never, and the lookup is
// a rate-limited request, so it is cached in memory for the worker's lifetime (6h TTL).
const extensionCache = new Map();
const EXTENSION_TTL_MS = 6 * 3600_000;

export async function extensionEmail(conn, extensionId) {
  if (!conn?.auth || !extensionId) return { email: null, name: null };
  const key = `${conn.id}:${extensionId}`;
  const hit = extensionCache.get(key);
  if (hit && Date.now() - hit.at < EXTENSION_TTL_MS) return hit.value;
  const r = await ringCentralGet(conn.auth, `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}`);
  // A queue, an IVR or a department has no person behind it. Cache that too — but not a rate
  // limit, which says nothing about the extension.
  if (!r.ok && r.rateLimited) return { email: null, name: null };
  const d = r.ok ? r.data : null;
  const value = {
    email: d?.type === 'User' && d?.contact?.email ? String(d.contact.email).toLowerCase() : null,
    name:  d?.contact ? [d.contact.firstName, d.contact.lastName].filter(Boolean).join(' ') || d?.name || null : d?.name || null,
  };
  extensionCache.set(key, { at: Date.now(), value });
  return value;
}

// ── Their side: who the rep was talking to ──────────────────────────────────

// Fallback until supabase/migrations/2026_09_16_phone_lookup.sql is applied: every phone claim in
// the workspace, keyed by its last ten digits, cached for 10 minutes. Correct, and slow on a
// CRM-sized workspace — which is why the RPC exists.
const phoneMapCache = new Map();
async function phoneMapFallback(supabase, workspaceId) {
  const hit = phoneMapCache.get(workspaceId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.map;
  const map = new Map();
  const PAGE = 1000;   // PostgREST caps every response at 1000 rows
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('claims')
      .select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('property', 'phone').is('invalid_at', null)
      .order('entity_id').range(from, from + PAGE - 1);
    if (error) break;
    for (const r of data || []) {
      const k = phoneKey(typeof r.value === 'string' ? r.value : String(r.value ?? ''));
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r.entity_id);
    }
    if (!data || data.length < PAGE) break;
  }
  phoneMapCache.set(workspaceId, { at: Date.now(), map });
  return map;
}

/**
 * People whose phone is this number, compared on the last ten digits (the stored phone is in
 * whatever format the CRM allowed). Companies carry a `phone` claim too; reading the ids back
 * through the `contacts` view keeps only people, and only live (unmerged) ones.
 */
export async function contactsByPhone(supabase, workspaceId, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  let ids;
  const { data, error } = await supabase.rpc('find_entities_by_phone', { p_workspace_id: workspaceId, p_phone_key: key });
  if (!error) ids = (data || []).map(r => r.entity_id);
  else ids = (await phoneMapFallback(supabase, workspaceId)).get(key) || [];
  ids = [...new Set(ids)].filter(Boolean);
  if (!ids.length) return [];
  const { data: contacts } = await supabase.from('contacts')
    .select('id, company_id, company, email, first_name, last_name, phone')
    .eq('workspace_id', workspaceId)
    .in('id', ids.slice(0, 50));
  return contacts || [];
}

/**
 * Only one person can be "the person on the phone". Several contacts sharing one number is a
 * switchboard or a family line, and filing the call on all of them would put a conversation on
 * people who were not in it — so an ambiguous number resolves to nobody and goes to the queue.
 */
const MAX_PHONE_MATCHES = 1;

// ── Fetching one call ───────────────────────────────────────────────────────

/** RingSense insights for a call, by telephony session. Null when there are none (yet). */
export async function fetchInsights(conn, telephonySessionId) {
  if (!conn?.auth || !telephonySessionId) return { records: null };
  const r = await ringCentralGet(conn.auth,
    `/ai/ringsense/v1/public/accounts/~/domains/pbx/sessions/${encodeURIComponent(telephonySessionId)}/insights`);
  if (r.ok) {
    const records = Array.isArray(r.data?.records) ? r.data.records : (r.data?.insights ? [r.data] : []);
    return { records: records.length ? records : null };
  }
  return { records: null, status: r.status, rateLimited: r.rateLimited };
}

/** One call-log record by id, for the agent-driven resolve. */
export async function fetchCallRecord(conn, callId) {
  const r = await ringCentralGet(conn.auth, `/restapi/v1.0/account/~/call-log/${encodeURIComponent(callId)}`, { view: 'Detailed' });
  return r.ok ? r.data : null;
}

// ── The pipeline ────────────────────────────────────────────────────────────

const titleFor = (call, contact) => {
  const who = contact
    ? ([contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.company || contact.email)
    : (call.otherName || call.otherPhone);
  return `${call.direction === 'Inbound' ? 'Inbound call from' : 'Call with'} ${who || 'unknown caller'}`;
};

const minutes = (sec) => `${Math.max(1, Math.round(sec / 60))} min`;

/**
 * Runs one RingCentral call through the call pipeline. Accepts:
 *   - `{ type: 'poll', record, insights, conn }` from the poller;
 *   - `{ type: 'resolve', callId, resolveToEntityId }` from /internal/reingest.
 */
export async function reprocessRingCentral(supabase, workspaceId, body) {
  body = body || {};
  const resolveToEntityId = body.resolveToEntityId || body.resolve_to_entity_id || null;

  let record = body.record || null;
  let insights = body.insights || null;
  let conn = body.conn || null;

  if (body.type === 'resolve') {
    const callId = body.callId || body.call_id || null;
    if (!callId) throw new Error('call_id_required');
    for (const c of await getRingCentralConnections(supabase, workspaceId)) {
      record = await fetchCallRecord(c, callId).catch(() => null);
      if (record) { conn = c; break; }
    }
    if (!record) {
      await logSysEvent(supabase, {
        workspaceId, source: SOURCE, eventType: 'sync_run',
        summary: `RingCentral call ${callId} could not be fetched — no connection can see it`,
        metadata: { call_id: callId, logged: 0, reason: 'call_not_found' },
      });
      return { logged: 0, reason: 'call_not_found' };
    }
    const call0 = callFromCallLog(record);
    if (call0.recordingId) insights = (await fetchInsights(conn, call0.telephonySessionId).catch(() => ({ records: null }))).records;
  }
  if (!record) throw new Error('record_required');

  const call = callFromCallLog(record);
  const occurredAt = new Date(call.startTime).toISOString();
  const { text: transcriptText, recap, speakerNames } = transcriptFromInsights(insights);

  // Our rep, from the extension that placed or took the call.
  const rep = await extensionEmail(conn, call.repExtensionId).catch(() => ({ email: null, name: null }));
  const hostEmail = rep.email;

  // The buyer, by phone. Exactly one match or nobody.
  let contacts = await contactsByPhone(supabase, workspaceId, call.otherPhone);
  const ambiguous = contacts.length > MAX_PHONE_MATCHES;
  if (ambiguous) contacts = [];

  if (resolveToEntityId && !contacts.some(c => c.id === resolveToEntityId)) {
    const { data: forced } = await supabase.from('contacts')
      .select('id, company_id, company, email, first_name, last_name, phone')
      .eq('workspace_id', workspaceId).eq('id', resolveToEntityId).maybeSingle();
    if (forced) {
      contacts = [forced];
      // Teach the identity: the contact the agent chose now owns this number, so the next call from
      // it resolves on its own. Only when the contact has no phone — never overwrite a number the
      // CRM already holds, because a person with two phones is more common than a wrong CRM.
      if (!phoneKey(forced.phone) && call.otherPhone) {
        await assertClaims(supabase, workspaceId, forced.id, { values: { phone: call.otherPhone }, source: SOURCE })
          .catch(e => console.warn('[ringcentral] phone claim failed', e.message));
      }
    } else {
      console.warn(`[RINGCENTRAL] resolveToEntityId ${resolveToEntityId} not found in ws ${workspaceId}`);
    }
  }

  const meetingOwnerUserId = await resolveCallHost(supabase, workspaceId, {
    organizerEmail: hostEmail,
    recorderEmail:  hostEmail,
    recorderUserId: null,
  });
  const recorder = { name: rep.name || call.repName, email: hostEmail, userId: meetingOwnerUserId };

  const title = titleFor(call, contacts[0]);
  const type = call.direction === 'Inbound' ? 'call_received' : 'call_made';
  const sourceRef = `source://${SOURCE}/${call.id}`;
  const extractionText = (transcriptText && transcriptText.length >= 40) ? transcriptText : recap;
  const summary = recap
    || (transcriptText ? transcriptText.slice(0, 12_000) : `${title} — ${minutes(call.durationSec)}${call.recordingId ? ', recorded' : ''}`);
  const notesContent = [
    recap,
    transcriptText ? `———— Transcript ————\n\n${transcriptText}` : null,
  ].filter(Boolean).join('\n\n') || null;

  let logged = 0;
  const externals = [];
  const internals = [];

  for (const contact of contacts) {
    const result = await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type,
      source:      SOURCE,
      externalId:  `${SOURCE}_${call.id}_${contact.id}`,
      occurredAt,
      description: title,
      summary,
      rawData: {
        title, call_id: call.id, telephony_session_id: call.telephonySessionId,
        direction: call.direction, duration_sec: call.durationSec, result: call.result,
        other_phone: call.otherPhone, other_name: call.otherName,
        rep_extension_id: call.repExtensionId, host_email: hostEmail,
        recording_id: call.recordingId, has_transcript: !!transcriptText,
      },
      ownerUserId: meetingOwnerUserId,
      suppressExtraction: true,
    });
    if (!result) continue;
    logged++;

    let internal = false;
    try { internal = await isEntityInternal(supabase, workspaceId, contact.id); }
    catch { /* on failure treat as external — losing signal is worse */ }

    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || call.otherName;
    if (!internal) externals.push({ contactId: contact.id, activityId: result.id, name, company: contact.company || null, companyId: contact.company_id || null });
    else internals.push(contact.id);

    if (meetingOwnerUserId && !internal) {
      try { await attributeRelationship(supabase, workspaceId, contact.id, meetingOwnerUserId, { at: occurredAt }); }
      catch (e) { console.warn('[ringcentral] attribute failed', e.message); }
    }

    if (notesContent) {
      await saveDocument(supabase, workspaceId, {
        entityId: contact.id,
        type:     'meeting_notes',
        title:    `Call notes — ${title}`,
        content:  notesContent,
        date:     occurredAt,
        source:   SOURCE,
        meta:     { source_ref: sourceRef, call_id: call.id, owner_user_id: meetingOwnerUserId ?? null, host_email: hostEmail },
      }).catch(() => {});
      if (!internal && meetingOwnerUserId) {
        const ev = normalizeMeeting({ title, recap, transcript: transcriptText, url: null });
        await writeEvidenceFile(supabase, {
          workspaceId, ownerUserId: meetingOwnerUserId, entityId: contact.id, companyId: contact.company_id || null,
          type: 'meeting', source: SOURCE, dedupKey: `${SOURCE}:${call.id}`, sourceRef,
          occurredAt, title: ev.title, markdown: ev.markdown,
        });
      }
    }
  }

  // Extraction and the call review need words. A call RingSense did not transcribe stops here,
  // filed and counted, by decision.
  const pending = [];
  if (externals.length && extractionText) {
    pending.push(extractMeetingSignals({ supabase, workspaceId, participants: externals, summary: extractionText,
      source: SOURCE, occurredAt, sourceRef })
      .catch(err => console.warn('[ringcentral] call extraction failed', err.message)));
  } else if (internals.length && extractionText) {
    // The team-insight extractor no longer runs here (GET-467): the meeting summary below is the
    // internal record, and its insights feed Internal Insights.
    // The meeting's one consistent record (GET-445): summary, insights by scope, decisions, next steps.
    pending.push(summarizeInternalMeeting({ supabase, workspaceId, transcript: extractionText, title: title, occurredAt,
      sourceRef: sourceRef, sourceSystem: SOURCE, subjectEntityId: internals[0],
      participants: contacts.filter(c => internals.includes(c.id)).map(c => [c.first_name, c.last_name].filter(Boolean).join(' ')) }));
  }

  if (externals.length && transcriptText && transcriptText.length >= 200) {
    pending.push(scoreCall({
      supabase, workspaceId,
      transcript:  transcriptText,
      repUserId:   meetingOwnerUserId ?? null,
      entityId:    externals[0]?.contactId ?? null,
      meetingId:   call.id,
      source:      SOURCE,
      occurredAt,
      title,
      sourceUrl:        null,
      accountEntityId:  externals[0]?.companyId || externals[0]?.contactId || null,
      mentionEntityIds: externals.map(e => e.contactId),
      sourceRef,
      contacts,
      recorder,
      namedSpeakers:    (speakerNames || []).length > 0,
      dispatch:         true,
    }).catch(err => console.warn('[ringcentral] call scoring failed', err.message)));
  }
  // The poller runs calls one after another; waiting keeps a busy afternoon of calls from putting
  // dozens of concurrent model calls on the extraction provider at once.
  if (pending.length) await Promise.all(pending);

  // Unresolved queue: a real conversation we could not put on anyone.
  if (contacts.length > 0 && resolveToEntityId) {
    await markUnresolvedResolved(supabase, { workspaceId, source: SOURCE, externalId: call.id, entityId: resolveToEntityId });
  } else if (contacts.length === 0 && !resolveToEntityId) {
    await recordUnresolved(supabase, {
      workspaceId, source: SOURCE, kind: 'meeting', externalId: call.id,
      title, occurredAt,
      detectedNames: [call.otherName, call.otherPhone].filter(Boolean),
      detectedEmails: [],
      summary: recap || null,
      raw: { call_id: call.id, phone: call.otherPhone, caller_id_name: call.otherName, ambiguous, direction: call.direction, duration_sec: call.durationSec, host_email: hostEmail },
    });
  }

  const linked = contacts.length;
  const sysSummary = linked === 0
    ? `RingCentral call received: ${title} (${minutes(call.durationSec)}) — ${ambiguous ? 'several contacts share this number' : 'no contact has this number'}`
    : `RingCentral call received: ${title} (${minutes(call.durationSec)}) — ${linked} contact linked${logged < linked ? ' (already recorded)' : ''}${transcriptText ? ', transcript from RingSense' : ''}`;
  await logSysEvent(supabase, {
    workspaceId, source: SOURCE, eventType: 'sync_run',
    summary: sysSummary,
    metadata: { call_id: call.id, linked, logged, ambiguous, owner_user_id: meetingOwnerUserId ?? null, host_email: hostEmail, has_transcript: !!transcriptText, via: body.type || 'poll' },
  });

  return { logged, linked, hostEmail, hasTranscript: !!transcriptText };
}
