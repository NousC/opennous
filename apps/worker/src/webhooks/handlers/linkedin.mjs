// LinkedIn / Unipile webhook handler — ported from an earlier internal prototype.
// Handles two Unipile event types:
//   message_received — inbound/outbound LinkedIn messages
//   new_relation     — new 1st-degree connection accepted

import {
  getSupabaseClient, countActivities,
  resolveEntity, getOrCreateEntity, upsertIdentifier, isMemberUrnLinkedInUrl,
  connectedLinkedinOwner, attributeRelationship, isEntityInternal,
} from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { applyLinkedInProfile } from '../../utils/enrichContact.mjs';
import { fetchLinkedInProfile, parseHeadline } from '../../utils/linkedinProfile.mjs';
import { discoverEmailForContact } from '../../utils/discoverEmail.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Write a line to the Activity Log UI (workspace_system_log table).
// Fire-and-forget — never throw.
async function logSysEvent(supabase, workspaceId, source, eventType, summary, contactId, metadata) {
  try {
    await supabase.from('workspace_system_log').insert({
      workspace_id: workspaceId,
      source,
      event_type:   eventType,
      summary:      summary || null,
      contact_id:   contactId || null,
      metadata:     metadata || {},
      occurred_at:  new Date().toISOString(),
    });
  } catch { /* non-critical — never block the webhook response */ }
}

// A LinkedIn message with no text is a voice note / image / attachment. Label it
// by media type so the timeline reads "Voice memo received" instead of a generic
// "LinkedIn message (received)" placeholder. Defensive across Unipile shapes —
// `src` is the webhook body or a Unipile chat-message object.
function linkedinMediaLabel(src) {
  if (!src || typeof src !== 'object') return null;
  const hint = String(src.message_type || src.message?.type || src.attachment_type || '').toLowerCase();
  const atts = src.attachments || src.message?.attachments || [];
  const a = Array.isArray(atts) ? atts[0] : null;
  const t = String(a?.type || a?.attachment_type || hint || '').toLowerCase();
  const mime = String(a?.mimetype || a?.mime_type || '').toLowerCase();
  if (a?.voice_note || a?.is_voice_note || /voice|audio/.test(t) || mime.startsWith('audio/')) return 'Voice memo';
  if (/img|image|photo|picture/.test(t) || mime.startsWith('image/')) return 'Image';
  if (/video/.test(t) || mime.startsWith('video/')) return 'Video';
  if (/gif/.test(t)) return 'GIF';
  if (t === 'linkedin_post' || /share|post/.test(t)) return 'Shared a post';
  if (a || hint) return 'Attachment';
  return null;
}

// Description + summary for a logged LinkedIn message. Real text → the text; no
// text → a media label ("Voice memo received"); summary is null when there's no
// text so the timeline shows no empty "You:" body line.
function linkedinMessageContent(text, isOutbound, src) {
  const dir = isOutbound ? 'sent' : 'received';
  if (text) {
    return {
      description: text.slice(0, 500),
      summary: isOutbound ? `You: ${text.slice(0, 200)}` : text.slice(0, 200),
    };
  }
  const media = linkedinMediaLabel(src);
  return {
    description: media ? `${media} ${dir}` : (isOutbound ? 'LinkedIn message (sent)' : 'LinkedIn message (received)'),
    summary: null,
  };
}

// Flexible LinkedIn URL match — handles www/no-www, trailing slash, query params.
async function matchContactByLinkedInUrl(supabase, workspaceId, rawUrl) {
  if (!rawUrl) return null;
  const slug = rawUrl.match(/\/in\/([^/?#]+)/)?.[1];
  if (!slug) return null;
  const { data } = await supabase
    .from('contacts')
    .select('id, workspace_id, company_id, linkedin_url, linkedin_member_id, email, channels')
    .eq('workspace_id', workspaceId)
    .ilike('linkedin_url', `%/in/${slug}%`)
    .maybeSingle();
  return data || null;
}

// Full contact resolution — 4-step waterfall matching the prior prototype's logic.
// 1. linkedin_member_id — permanent numeric ID, survives URL format changes
// 2. URL slug ilike     — readable slug fallback
// 3. First + last name  — catches contacts imported without any LinkedIn data
// 4. Create new contact — only if all above miss and we have enough data
// Always patches linkedin_member_id + linkedin_url back so future calls hit step 1/2.
// Returns { contact, created } — created=true means it was just inserted for the first time.
async function resolveLinkedInContact(supabase, workspaceId, { linkedinUrl, fullName, memberId }) {
  const SELECT = 'id, workspace_id, company_id, linkedin_url, linkedin_member_id, email, channels, first_name, last_name, job_title, company, photo_url';

  // Step 1: v2 entity_identifiers fast path — exact match by member_id / URL.
  for (const ident of [
    memberId    && { kind: 'linkedin_member_id', value: memberId },
    linkedinUrl && { kind: 'linkedin_url',       value: linkedinUrl },
  ].filter(Boolean)) {
    const entityId = await resolveEntity(supabase, workspaceId, ident);
    if (!entityId) continue;
    const { data } = await supabase.from('contacts').select(SELECT).eq('id', entityId).maybeSingle();
    if (data) {
      const patch = {};
      if (memberId    && !data.linkedin_member_id) patch.linkedin_member_id = memberId;
      if (linkedinUrl && !data.linkedin_url)       patch.linkedin_url       = linkedinUrl;
      if (Object.keys(patch).length)
        await supabase.from('contacts').update(patch).eq('id', data.id).then(null, () => {});
      return { contact: { ...data, ...patch }, created: false };
    }
  }

  // Step 2: URL slug ilike — handles linkedin_url variants entity_identifiers
  // doesn't catch (www/no-www, query params, trailing slash).
  const byUrl = await matchContactByLinkedInUrl(supabase, workspaceId, linkedinUrl);
  if (byUrl) {
    const patch = {};
    if (memberId    && !byUrl.linkedin_member_id) patch.linkedin_member_id = memberId;
    if (linkedinUrl && !byUrl.linkedin_url)       patch.linkedin_url       = linkedinUrl;
    if (Object.keys(patch).length)
      await supabase.from('contacts').update(patch).eq('id', byUrl.id).then(null, () => {});
    // Register what we know in entity_identifiers so step 1 hits next time.
    // (reactivate-or-insert; a plain .upsert can't target the partial active index)
    if (memberId)    await upsertIdentifier(supabase, workspaceId, byUrl.id, 'linkedin_member_id', memberId);
    if (linkedinUrl) await upsertIdentifier(supabase, workspaceId, byUrl.id, 'linkedin_url', linkedinUrl);
    return { contact: { ...byUrl, ...patch }, created: false };
  }

  // Step 2.5: a DM-sourced webhook arrives with a member-URN URL (/in/ACoAA…) — or
  // only a member_id — which won't string-match a record we already hold under the
  // person's REAL vanity handle (e.g. an earlier import). Resolve the member-URN to
  // its vanity handle via Unipile ONCE, then retry the URL match on the real handle.
  // This is the fix that stops a LinkedIn DM from forking a NEW record off someone we
  // already have (the Shubham case). Only runs when steps 1-2 missed AND we have a
  // member_id with no usable vanity URL, so it's at most one fetch on a maybe-new
  // contact. `healedVanity` is reused below so a genuinely-new record is created with
  // the clean URL, not the encoded one.
  let healedVanity = null;
  if (memberId && (!linkedinUrl || isMemberUrnLinkedInUrl(linkedinUrl))) {
    const accountId = await getUnipileAccountId(supabase, workspaceId);
    if (accountId) {
      const prof = await fetchLinkedInProfile(accountId, memberId).catch(() => null);
      if (prof?.publicIdentifier) {
        healedVanity = `https://www.linkedin.com/in/${prof.publicIdentifier}`;
        const byVanity = await matchContactByLinkedInUrl(supabase, workspaceId, healedVanity);
        if (byVanity) {
          await upsertIdentifier(supabase, workspaceId, byVanity.id, 'linkedin_member_id', memberId);
          await upsertIdentifier(supabase, workspaceId, byVanity.id, 'linkedin_url', healedVanity);
          const patch = {};
          if (!byVanity.linkedin_member_id) patch.linkedin_member_id = memberId;
          if (!byVanity.linkedin_url || isMemberUrnLinkedInUrl(byVanity.linkedin_url)) patch.linkedin_url = healedVanity;
          if (Object.keys(patch).length)
            await supabase.from('contacts').update(patch).eq('id', byVanity.id).then(null, () => {});
          return { contact: { ...byVanity, ...patch }, created: false };
        }
      }
    }
  }

  // Step 3: first + last name match — contacts-only fallback (names aren't v2 identifiers).
  // Require a UNIQUE name match: with two same-name people, merging onto an arbitrary
  // one would fuse strangers, so we'd rather create + let dedup/review handle it.
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    const first = parts[0];
    const last  = parts.slice(1).join(' ');
    if (first && last) {
      const { data: nameMatches } = await supabase
        .from('contacts')
        .select(SELECT)
        .eq('workspace_id', workspaceId)
        .ilike('first_name', first)
        .ilike('last_name', last)
        .order('created_at', { ascending: true });
      const byName = nameMatches?.length === 1 ? nameMatches[0] : null;
      if (byName) {
        const patch = {};
        if (!byName.linkedin_url && linkedinUrl)     patch.linkedin_url = linkedinUrl;
        if (!byName.linkedin_member_id && memberId)  patch.linkedin_member_id = memberId;
        if (Object.keys(patch).length)
          await supabase.from('contacts').update(patch).eq('id', byName.id).then(null, () => {});
        if (memberId)    await upsertIdentifier(supabase, workspaceId, byName.id, 'linkedin_member_id', memberId);
        if (linkedinUrl) await upsertIdentifier(supabase, workspaceId, byName.id, 'linkedin_url', linkedinUrl);
        return { contact: { ...byName, ...patch }, created: false };
      }
    }
  }

  // Step 4: create — requires at least a LinkedIn URL or a full name.
  if (!linkedinUrl && !fullName) return { contact: null, created: false };

  // Prefer the healed vanity URL (from Step 2.5) over a raw member-URN, so a new
  // record is created scrapeable/enrichable and will string-match next time —
  // preventing the same person from forking yet another duplicate later.
  const finalUrl = healedVanity || linkedinUrl || null;
  const identifiers = [];
  if (memberId) identifiers.push({ kind: 'linkedin_member_id', value: memberId });
  if (finalUrl && !isMemberUrnLinkedInUrl(finalUrl)) identifiers.push({ kind: 'linkedin_url', value: finalUrl });

  let entityId;
  if (identifiers.length) {
    entityId = await getOrCreateEntity(supabase, workspaceId, 'person', identifiers);
  } else {
    const { data: ent } = await supabase.from('entities')
      .insert({ workspace_id: workspaceId, type: 'person', status: 'active' })
      .select('id').single();
    entityId = ent?.id;
  }

  const nameParts = fullName?.trim().split(/\s+/) || [];
  const { data: created, error } = await supabase
    .from('contacts')
    .insert({
      id:                 entityId,
      workspace_id:       workspaceId,
      first_name:         nameParts[0] || null,
      last_name:          nameParts.slice(1).join(' ') || null,
      linkedin_url:       finalUrl,
      linkedin_member_id: memberId     || null,
      pipeline_stage:     'identified',
      source:             'linkedin',
    })
    .select(SELECT)
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabase.from('contacts').select(SELECT).eq('id', entityId).maybeSingle();
      if (existing) return { contact: existing, created: false };
    }
    console.error('[LINKEDIN_WEBHOOK] contact create failed:', error.message);
    return { contact: null, created: false };
  }

  // (No explicit state mirror: the contacts view's INSERT trigger handled it.)
  return { contact: created, created: true };
}

// Pull up to 50 historical messages from Unipile and backfill them for a new contact.
// chatId: pass directly from the webhook payload — skips slow chat search for outbound.
// Fire-and-forget — called only on new contact creation.
// `accountId` is the rep's LinkedIn this conversation belongs to — pass the one
// from the webhook. Without it we fetch a DIFFERENT rep's chats and stamp their
// ownership on this contact's history.
async function backfillLinkedInMessages(supabase, workspaceId, contactId, { linkedinUrl, chatId, accountId: accountIdIn }) {
  const dsn = process.env.UNIPILE_DSN;
  const key = process.env.UNIPILE_API_KEY;
  if (!dsn || !key) return;

  const BASE = `https://${dsn}/api/v1`;
  const hdrs = { 'X-API-KEY': key, 'Content-Type': 'application/json', accept: 'application/json' };

  const slug = linkedinUrl?.match(/\/in\/([^/?#]+)/)?.[1];
  if (!chatId && !slug) {
    console.log('[LINKEDIN_BACKFILL] skipping — no chatId or linkedin URL slug');
    return;
  }

  try {
    const accountId = accountIdIn || await getUnipileAccountId(supabase, workspaceId);
    if (!accountId) {
      console.log('[LINKEDIN_BACKFILL] no unipile account for workspace', workspaceId);
      return;
    }
    console.log(`[LINKEDIN_BACKFILL] starting — contact=${contactId} chatId=${chatId} slug=${slug}`);

    let resolvedChatId = chatId;

    if (!resolvedChatId) {
      const chatsRes = await fetch(`${BASE}/chats?account_id=${accountId}&limit=100`, { headers: hdrs });
      if (!chatsRes.ok) {
        console.error(`[LINKEDIN_BACKFILL] chats fetch failed: ${chatsRes.status}`);
        return;
      }
      const chatsBody = await chatsRes.json();
      const chats = chatsBody.items || chatsBody.objects || (Array.isArray(chatsBody) ? chatsBody : []);

      const targetChat = chats.find(chat =>
        (chat.attendees || []).some(a => {
          const url = a.profile_url || a.attendee_profile_url || a.url || '';
          return !a.is_self && url.includes(`/in/${slug}`);
        })
      );
      if (!targetChat) {
        console.log(`[LINKEDIN_BACKFILL] no chat matched slug=${slug} in ${chats.length} chats`);
        return;
      }
      resolvedChatId = targetChat.id;
    }

    const msgsRes = await fetch(`${BASE}/chats/${resolvedChatId}/messages?account_id=${accountId}&limit=50`, { headers: hdrs });
    if (!msgsRes.ok) {
      console.error(`[LINKEDIN_BACKFILL] messages fetch failed: ${msgsRes.status}`);
      return;
    }
    const msgsBody = await msgsRes.json();
    const messages = msgsBody.items || msgsBody.objects || (Array.isArray(msgsBody) ? msgsBody : []);
    console.log(`[LINKEDIN_BACKFILL] fetched ${messages.length} messages for contact=${contactId}`);

    // Whose LinkedIn this chat came through — stamped on each message (scopes the
    // raw DM to that rep) and reused for relationship attribution below.
    const ownerUserId = await connectedLinkedinOwner(supabase, workspaceId, accountId);

    let logged = 0;
    let maxAt = null;
    for (const msg of messages) {
      // provider_message_id is the ONE id both the backfill and the webhook payloads
      // share for the same message. Key external_id on it (not msg.id, which differs
      // between paths) so the unique index collapses the duplicate ingest. See dedup note.
      const msgId = msg.provider_message_id || msg.provider_id || msg.id || msg.message_id;
      if (!msgId) continue;
      const isOutbound  = !!(msg.is_sender);
      const text        = msg.text || msg.body || msg.content || '';
      const occurredAt  = msg.created_at || msg.timestamp || msg.date || msg.sent_at || new Date().toISOString();
      const content     = linkedinMessageContent(text, isOutbound, msg);
      await logActivity(supabase, {
        workspaceId,
        contactId,
        type:        'linkedin_message',
        source:      'linkedin',
        externalId:  `li_msg_${msgId}`,
        occurredAt,
        rawData:     { ...msg, text, is_outbound: isOutbound },
        description: content.description,
        summary:     content.summary,
        ownerUserId,
      });
      logged++;
      if (!maxAt || occurredAt > maxAt) maxAt = occurredAt;
    }
    console.log(`[LINKEDIN_BACKFILL] done — contact=${contactId} logged=${logged}/${messages.length}`);

    // Attribute the relationship to the rep whose LinkedIn this is (once for the
    // whole chat, using the most recent message). Skip if the contact is internal.
    if (logged > 0) {
      if (ownerUserId && !(await isEntityInternal(supabase, workspaceId, contactId))) {
        await attributeRelationship(supabase, workspaceId, contactId, ownerUserId, { at: maxAt || new Date().toISOString() });
      }
    }
  } catch (e) {
    console.error('[LINKEDIN_BACKFILL] error:', e.message);
  }
}

// Resolve the workspace's Unipile account id (needed for any profile/chat fetch).
//
// LAST RESORT ONLY. This returns the most recently connected account in the
// workspace, which is a coin flip once two reps have connected LinkedIn — and it
// silently attributed every event to whoever connected last. Anything handling a
// specific webhook must use the account_id ON THE PAYLOAD (see accountIdFromBody).
async function getUnipileAccountId(supabase, workspaceId) {
  const { data } = await supabase
    .from('workspace_linkedin_connections')
    .select('unipile_account_id')
    .eq('workspace_id', workspaceId)
    .order('connected_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.unipile_account_id || null;
}

// The Unipile account this event actually belongs to. Unipile stamps it on every
// webhook; we were ignoring it and guessing from the workspace instead, which is
// how one rep's messages ended up owned by another. Fall back to the workspace
// lookup only when the payload genuinely carries no account (older webhook
// shapes), because a wrong owner leaks a private conversation.
function accountIdFromBody(body) {
  return body?.account_id
      || body?.account_info?.id
      || body?.account?.id
      || null;
}

// Pull title + company from Unipile (free), write them, score ICP, and discover an
// email from connected mailboxes. SELF-GUARDING and idempotent, so it is safe to
// call on EVERY LinkedIn webhook (accept or message), not only on first creation —
// a contact created by another path (full sync, invite-poll) still gets enriched.
// Skips the Unipile fetch once a title exists and skips discovery once an email
// exists, so repeated webhooks never re-hit Unipile. Fire-and-forget.
async function enrichNewLinkedInContact(supabase, workspaceId, contact, { memberId, inlineHeadline } = {}) {
  try {
    if (contact.job_title && contact.email) return;   // nothing left to fill

    // (2) Free inline enrichment first. Unipile webhooks carry the person's
    // headline as attendee_specifics.occupation — parse title/company from it
    // BEFORE paying for a profile fetch. parseHeadline is a pure regex; the LLM
    // fallback inside applyLinkedInProfile only fires when the regex misses (the
    // same cost the profile path would incur). If this fills the title and we
    // already have an email, we skip the Unipile fetch entirely.
    if (!contact.job_title && inlineHeadline) {
      // Try the free regex first; pass its result so applyLinkedInProfile's LLM
      // fallback only fires when "Role @ Company" isn't present in the headline.
      const parsed = parseHeadline(inlineHeadline);
      await applyLinkedInProfile(supabase, contact, {
        jobTitle: parsed.jobTitle, company: parsed.company, headline: inlineHeadline,
      });
      const { data: refreshed } = await supabase.from('contacts')
        .select('job_title, company, email, company_id, photo_url').eq('id', contact.id).maybeSingle();
      if (refreshed) contact = { ...contact, ...refreshed };
      if (contact.job_title && contact.email) return;   // inline was enough
    }

    // One Unipile profile fetch fills title/company/photo AND often the real email
    // (contact_info.emails on first-degree connections). Fetch if we're missing
    // either title or email.
    let profileEmail = null;
    if (!contact.job_title || !contact.email) {
      const accountId = await getUnipileAccountId(supabase, workspaceId);
      const fields = await fetchLinkedInProfile(accountId, memberId || contact.linkedin_member_id);
      if (fields) {
        profileEmail = fields.email || null;
        await applyLinkedInProfile(supabase, contact, {
          jobTitle: fields.jobTitle, company: fields.company,
          companyDomain: fields.companyDomain, photoUrl: fields.photoUrl,
          email: fields.email, phone: fields.phone, headline: fields.headline,
          publicIdentifier: fields.publicIdentifier,
        });
        if (fields.email) contact = { ...contact, email: fields.email }; // so we don't re-discover
        await logSysEvent(supabase, workspaceId, 'linkedin', 'enrichment_run',
          `LinkedIn profile: ${[fields.jobTitle, fields.company, fields.email].filter(Boolean).join(' · ') || 'no parseable fields'}`,
          contact.id, { source: 'linkedin_profile', got_title: !!fields.jobTitle, got_email: !!fields.email });
      } else {
        await logSysEvent(supabase, workspaceId, 'linkedin', 'enrichment_run',
          'LinkedIn profile fetch returned null', contact.id, { source: 'linkedin_profile', got_title: false });
      }
    }
    // Still no email → fall back to the workspace's own Gmail / inbox by name.
    if (!contact.email && !profileEmail) {
      const r = await discoverEmailForContact(supabase, workspaceId, contact);
      if (r.found) console.log(`[DISCOVER_EMAIL] ${contact.id}: ${r.email} via ${r.source} (${r.hits} hit/s)`);
    }
  } catch (e) {
    console.error(`[LINKEDIN_PROFILE] ${contact?.id} enrich failed:`, e.message, e.stack);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

// Non-actionable Unipile events — carry message_id/chat_id but have no content to log.
const NON_ACTIONABLE = new Set([
  'message_read', 'message_delivered',
  'message_edit', 'message_edited',
  'message_delete', 'message_deleted',
  'message_reaction',
]);

export async function handleLinkedIn(req, res, workspaceId) {
  const supabase  = getSupabaseClient();
  const body      = req.body;
  const eventType = body.event || body.event_type || '';

  console.log('[LINKEDIN_WEBHOOK] event=', eventType, 'keys:', Object.keys(body).join(', '));

  if (NON_ACTIONABLE.has(eventType)) {
    console.log('[LINKEDIN_WEBHOOK] skipping non-actionable event:', eventType);
    return res.json({ ok: true, skipped: eventType });
  }

  // WHICH REP this event belongs to. Take it from the payload — Unipile tells us
  // the account every webhook came through. The workspace-wide lookup is only a
  // fallback for payloads that carry no account at all: with two reps connected it
  // returns whoever connected most recently, which mis-attributes the other rep's
  // messages to them and then redacts those messages from their actual owner.
  const liAccountId   = accountIdFromBody(body) || await getUnipileAccountId(supabase, workspaceId);
  const liOwnerUserId = await connectedLinkedinOwner(supabase, workspaceId, liAccountId);
  if (!accountIdFromBody(body)) {
    console.warn('[LINKEDIN_WEBHOOK] no account_id on payload — falling back to newest connection', { workspaceId });
  }
  const attributeLI = async (contactId, at) => {
    if (!liOwnerUserId || !contactId) return;
    try {
      if (await isEntityInternal(supabase, workspaceId, contactId)) return;
      await attributeRelationship(supabase, workspaceId, contactId, liOwnerUserId, { at });
    } catch (e) { console.warn('[LINKEDIN_WEBHOOK] attribute failed', e.message); }
  };

  // Fall back to shape-detection for older webhook configs without explicit event field
  const isMessage  = eventType === 'message_received' || (!eventType && !!(body.message_id || body.chat_id));
  const isRelation = eventType === 'new_relation'     || (!eventType && !!(body.user_profile_url || body.user_full_name));

  if (!isMessage && !isRelation) {
    console.log('[LINKEDIN_WEBHOOK] skipping unknown event:', eventType || 'unknown');
    return res.json({ ok: true, skipped: `unknown event: ${eventType || 'unknown'}` });
  }

  // ── New connection ──────────────────────────────────────────────────────────
  if (isRelation) {
    const linkedinUrl = body.user_profile_url || null;
    const fullName    = body.user_full_name   || null;
    const identifier  = body.user_public_identifier || body.user_provider_id || null;
    // Some new_relation payloads include the connection's headline inline — use it
    // for free title/company enrichment, same as the message path.
    const inlineHeadline = body.user_headline || body.user_occupation
      || body.user_attendee_specifics?.occupation || null;
    if (!linkedinUrl && !fullName) return res.json({ ok: true, skipped: 'no identity' });

    const { contact, created } = await resolveLinkedInContact(supabase, workspaceId, { linkedinUrl, fullName, memberId: identifier });
    if (!contact) return res.json({ ok: true, skipped: 'could not resolve contact' });

    // Pull title/company from Unipile (free) + score ICP. AWAITED, not fire-and-
    // forget: a detached promise gets cut off when the handler responds, so the
    // Unipile fetch + scoring never finished and the contact stayed blank. Webhooks
    // tolerate a few seconds. Runs on every accept (self-guards across creation paths).
    await enrichNewLinkedInContact(supabase, workspaceId, contact, { memberId: identifier, inlineHeadline });

    // Deduplicate — Unipile re-fires new_relation on re-auth
    const alreadyConnected = await countActivities(supabase, {
      contactId: contact.id, types: ['linkedin_connected'], source: 'linkedin',
    });
    if (alreadyConnected > 0) {
      console.log(`[LINKEDIN_WEBHOOK] ${contact.id} already has linkedin_connected — skipping duplicate`);
      return res.json({ ok: true, contactId: contact.id, type: 'connection_already_logged' });
    }

    await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'linkedin_connected',
      source:      'linkedin',
      externalId:  `li_conn_${identifier || linkedinUrl?.match(/\/in\/([^/?#]+)/)?.[1] || linkedinUrl}`,
      occurredAt:  body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString(),
      rawData:     body,
      description: 'Connected on LinkedIn',
      ownerUserId: liOwnerUserId,
    });
    await attributeLI(contact.id, body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString());

    // Update channels.linkedin.state = connected
    const { data: chRow } = await supabase.from('contacts').select('channels').eq('id', contact.id).single();
    const ch = chRow?.channels || {};
    const li = ch.linkedin || {};
    const nextChannels = { ...ch, linkedin: { ...li, state: 'connected', connected_at: new Date().toISOString() } };
    await supabase.from('contacts').update({ channels: nextChannels }).eq('id', contact.id);

    logSysEvent(supabase, workspaceId, 'linkedin', 'webhook_received',
      `New LinkedIn connection${fullName ? `: ${fullName}` : ''}`,
      contact.id, { type: 'connection', linkedin_url: linkedinUrl }
    );
    return res.json({ ok: true, contactId: contact.id, type: 'connection' });
  }

  // ── Message received / sent ─────────────────────────────────────────────────
  if (isMessage) {
    const sender      = body.sender      || {};
    const attendees   = body.attendees   || [];
    const accountInfo = body.account_info || {};

    const myUserId = accountInfo.user_id;
    const isSender = !!(body.is_sender ?? (myUserId && sender.attendee_provider_id === myUserId));

    // Unipile puts the recipient in attendees[] for outbound messages
    let linkedinUrl, fullName, memberId, inlineHeadline = null;
    // attendee_specifics.occupation carries the OTHER party's LinkedIn headline —
    // free enrichment for title/company without a profile fetch. Skip company
    // pages (is_company) so we never parse a brand page's tagline as a job title.
    const headlineFrom = (sp) => (sp && !sp.is_company ? sp.occupation || null : null);
    if (isSender) {
      const other = attendees.find(a => !a.is_self && a.provider_id !== myUserId)
                 || attendees.find(a => !a.is_self);
      linkedinUrl = other?.profile_url        || other?.attendee_profile_url || null;
      fullName    = other?.name               || other?.attendee_name        || null;
      memberId    = other?.provider_id        || other?.attendee_provider_id || null;
      inlineHeadline = headlineFrom(other?.attendee_specifics);
    } else {
      linkedinUrl = sender.attendee_profile_url || sender.profile_url || null;
      fullName    = sender.attendee_name        || sender.name        || null;
      memberId    = sender.attendee_provider_id || sender.provider_id || null;
      inlineHeadline = headlineFrom(sender.attendee_specifics);
    }

    if (!linkedinUrl && !fullName && !memberId) {
      console.warn('[LINKEDIN_WEBHOOK] could not extract identity from message event', { isSender, senderKeys: Object.keys(sender) });
      return res.json({ ok: true, skipped: 'no identity' });
    }

    const { contact, created } = await resolveLinkedInContact(supabase, workspaceId, { linkedinUrl, fullName, memberId });
    if (!contact) {
      console.warn('[LINKEDIN_WEBHOOK] could not resolve contact', { linkedinUrl, fullName, workspaceId });
      return res.json({ ok: true, skipped: 'could not resolve contact' });
    }

    const messageText = body.message?.text || (typeof body.message === 'string' ? body.message : '') || body.text || '';
    // provider_message_id FIRST — it's the stable id shared with the backfill path, so
    // a message seen by both webhook + backfill produces ONE external_id, not two.
    const msgId       = body.provider_message_id || body.message?.provider_message_id || body.message_id || body.message?.id;
    const occurredAt  = body.timestamp ? new Date(body.timestamp).toISOString() : new Date().toISOString();

    // Real text → the text; a text-less message (voice note, image, …) gets a media
    // label ("Voice memo received") so the timeline never shows a bare placeholder.
    const content = linkedinMessageContent(messageText, isSender, body);
    await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'linkedin_message',
      source:      'linkedin',
      externalId:  msgId ? `li_msg_${msgId}` : null,
      occurredAt,
      // is_outbound drives sent-vs-received fact extraction — a message WE sent
      // must never become a "fact" about the contact. body carries is_sender.
      rawData:     { ...body, is_outbound: isSender },
      description: content.description,
      summary:     content.summary,
      ownerUserId: liOwnerUserId,
    });
    await attributeLI(contact.id, occurredAt);

    // channels.linkedin update — fire-and-forget
    setImmediate(async () => {
      try {
        const otherSpecifics = isSender
          ? (attendees.find(a => a.attendee_provider_id !== myUserId && !a.is_self)?.attendee_specifics || {})
          : (sender.attendee_specifics || {});
        const isConnected = otherSpecifics.network_distance === 'DISTANCE_1';
        const chatId = body.chat_id || body.provider_chat_id || null;

        const { data: row } = await supabase.from('contacts').select('channels').eq('id', contact.id).single();
        const currentLi = row?.channels?.linkedin || {};
        const updatedLi = {
          ...currentLi,
          ...(isConnected && { state: 'connected' }),
          ...(chatId && { chat_id: chatId }),
          messages_sent:     (currentLi.messages_sent     || 0) + (isSender ? 1 : 0),
          messages_received: (currentLi.messages_received || 0) + (isSender ? 0 : 1),
          awaiting_reply:    isSender,
          last_message_at:   occurredAt,
        };
        const nextChannels = { ...(row?.channels || {}), linkedin: updatedLi };
        await supabase.from('contacts').update({ channels: nextChannels }).eq('id', contact.id);

        // Infer linkedin_connected from DISTANCE_1 if new_relation webhook never fired
        if (isConnected) {
          const alreadyConnected = await countActivities(supabase, {
            contactId: contact.id, types: ['linkedin_connected'], source: 'linkedin',
          });
          if (!alreadyConnected) {
            await logActivity(supabase, {
              workspaceId,
              contactId:   contact.id,
              companyId:   contact.company_id || null,
              type:        'linkedin_connected',
              source:      'linkedin',
              externalId:  `li_conn_inferred_${memberId || contact.id}`,
              occurredAt,
              description: 'Connected on LinkedIn',
              ownerUserId: liOwnerUserId,
            });
            console.log(`[LINKEDIN_WEBHOOK] Inferred linkedin_connected for ${contact.id} from message signal`);
          }
        }
      } catch (e) {
        console.error('[LINKEDIN_WEBHOOK] channels.linkedin update failed:', e.message);
      }
    });

    // Email self-healing — if someone shares their email in a LinkedIn message, capture it
    if (!contact.email && messageText) {
      const emailMatch = messageText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        const discoveredEmail = emailMatch[0].toLowerCase();
        await supabase.from('contacts').update({ email: discoveredEmail }).eq('id', contact.id);
        console.log(`[LINKEDIN_WEBHOOK] Email discovered in message: ${discoveredEmail} → contact ${contact.id}`);
      }
    }

    logSysEvent(supabase, workspaceId, 'linkedin', 'webhook_received',
      isSender
        ? `LinkedIn message sent to ${fullName || linkedinUrl}: ${messageText.slice(0, 120)}`
        : `LinkedIn message from ${fullName || linkedinUrl}: ${messageText.slice(0, 120)}`,
      // owner_user_id lets the ops-feed reader redact this message text for members
      // who don't own the LinkedIn account it came through (PRIVACY_MODEL.md).
      contact.id, { type: isSender ? 'message_sent' : 'message', message_id: msgId, is_sender: isSender, owner_user_id: liOwnerUserId ?? null }
    );

    // New contact → backfill their full conversation history.
    // Also backfill existing contacts that have no prior linkedin_message activities —
    // catches contacts imported before the webhook was set up (e.g. old connections).
    // Capture title/company + score ICP + discover email. AWAITED (see accept
    // branch) so the detached promise isn't cut off when the handler responds.
    // Self-guarding, so it's safe on every message and across creation paths.
    await enrichNewLinkedInContact(supabase, workspaceId, contact, { memberId, inlineHeadline });

    const chatId = body.chat_id || body.provider_chat_id || null;
    if (created) {
      backfillLinkedInMessages(supabase, workspaceId, contact.id, { linkedinUrl, chatId, accountId: liAccountId }).catch(() => {});
    } else {
      const priorMsgCount = await countActivities(supabase, {
        contactId: contact.id, types: ['linkedin_message'], source: 'linkedin',
      });
      if (!priorMsgCount) {
        backfillLinkedInMessages(supabase, workspaceId, contact.id, { linkedinUrl, chatId, accountId: liAccountId }).catch(() => {});
      }
    }

    return res.json({ ok: true, contactId: contact.id, type: 'message' });
  }
}

// For the webhook retry worker. Re-runs handleLinkedIn with a stub res so
// internal res.json() calls become no-ops; we just care about the side
// effects (logActivity, resolveContact). Throws on DB/transport failures,
// which is what the retry worker uses to schedule the next attempt.
export async function reprocessLinkedIn(supabase, workspaceId, body) {
  const fakeReq = { body, headers: {}, fromRetry: true };
  const fakeRes = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleLinkedIn(fakeReq, fakeRes, workspaceId);
  if (fakeRes.statusCode >= 500) throw new Error(fakeRes.body?.error || 'linkedin_handler_error');
  return fakeRes.body;
}
