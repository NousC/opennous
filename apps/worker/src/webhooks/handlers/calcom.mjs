// Cal.com webhook handler — receives BOOKING_CREATED, BOOKING_CANCELLED, and
// BOOKING_RESCHEDULED events and logs meeting activities.
//
// Signature: x-cal-signature-256 is the hex HMAC-SHA256 of the raw request body
// keyed with the secret we supplied to Cal.com at subscription time.

import crypto from 'crypto';
import { getSupabaseClient } from '@nous/core';
import { decrypt } from '../../utils/encryption.mjs';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

async function loadCalComSigningKey(supabase, workspaceId) {
  const { data: conn } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('workflow_providers.name', 'cal_com')
    .maybeSingle();
  const encryptedKey = conn?.encrypted_credentials?.webhook_signing_key;
  if (!encryptedKey) return null;
  try { return decrypt(encryptedKey); }
  catch { return null; }
}

export async function reprocessCalCom(supabase, workspaceId, body) {
  body = body || {};
  const trigger = body.triggerEvent || body.event || '';
  const payload = body.payload || body;

  console.log(`[CAL_COM_WEBHOOK] trigger=${trigger}`);

  const known = ['BOOKING_CREATED', 'BOOKING_CANCELLED', 'BOOKING_RESCHEDULED'];
  if (!known.includes(trigger)) return { skipped: `unhandled trigger: ${trigger}` };

  const isCanceled = trigger === 'BOOKING_CANCELLED';

  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const primary   = attendees[0] || {};
  const email     = (primary.email || '').toLowerCase().trim();
  const name      = primary.name || '';
  const startTime = payload.startTime || payload.start || null;
  const endTime   = payload.endTime   || payload.end   || null;
  const title     = payload.title || payload.eventType?.title || 'Meeting';
  const bookingUid = payload.uid || payload.bookingUid || null;

  if (!email) throw new Error('attendee_email_required');

  const nameParts = name.trim().split(/\s+/).filter(Boolean);

  const { contact } = await resolveContact(supabase, workspaceId, {
    email,
    first_name: nameParts[0] || null,
    last_name:  nameParts.slice(1).join(' ') || null,
    source:     'cal_com',
  }, { createIfMissing: !isCanceled });

  if (!contact) return { skipped: isCanceled ? 'contact not found' : 'could not create contact' };

  const occurredAt = startTime ? new Date(startTime).toISOString() : new Date().toISOString();

  const externalId = bookingUid
    ? `cal_com_${isCanceled ? 'cancel' : 'book'}_${bookingUid}`
    : `cal_com_${isCanceled ? 'cancel' : 'book'}_${email}_${occurredAt.slice(0, 10)}`;

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        isCanceled ? 'meeting_cancelled' : 'meeting_scheduled',
    source:      'cal_com',
    externalId,
    occurredAt,
    description: isCanceled ? `Cancelled: ${title}` : `Booked: ${title}`,
    rawData:     {
      meeting_name: title,
      start_time:   startTime,
      end_time:     endTime,
      booking_uid:  bookingUid,
      trigger,
    },
  });

  // A reschedule creates a NEW booking (new uid) at the new time while the old
  // one survives as a stale "Booked:" row. Cal.com hands us the original start
  // (rescheduleStartTime); drop a cancellation marker on that old slot so the
  // read layer supersedes it — leaving only the live booking. The "Rescheduled:"
  // prefix tells the read layer this marker is bookkeeping, not a real cancel.
  if (trigger === 'BOOKING_RESCHEDULED') {
    const oldStartRaw = payload.rescheduleStartTime || payload.rescheduleStart || null;
    const oldStart    = oldStartRaw ? new Date(oldStartRaw).toISOString() : null;
    const oldUid      = payload.rescheduleUid || null;
    if (oldStart && oldStart !== occurredAt) {
      await logActivity(supabase, {
        workspaceId,
        contactId:   contact.id,
        companyId:   contact.company_id || null,
        type:        'meeting_cancelled',
        source:      'cal_com',
        externalId:  `cal_com_resched_${oldUid || bookingUid || email}_${oldStart.slice(0, 16)}`,
        occurredAt:  oldStart,
        description: `Rescheduled: ${title}`,
        rawData:     { meeting_name: title, old_start: oldStart, new_start: startTime, reschedule_uid: oldUid, trigger },
      });
    }
  }

  await logSysEvent(supabase, {
    workspaceId, source: 'cal_com', eventType: 'webhook_received',
    summary:    isCanceled ? `Cancelled: ${title} (${email})` : `Booked: ${title} (${email})`,
    contactId:  contact.id,
    metadata:   { type: trigger.toLowerCase(), email },
  });

  return { contactId: contact.id, type: isCanceled ? 'meeting_cancelled' : 'meeting_scheduled' };
}

export async function handleCalCom(req, res, workspaceId) {
  const supabase = getSupabaseClient();

  const signingKey = await loadCalComSigningKey(supabase, workspaceId);
  if (!signingKey) {
    console.warn(`[CAL_COM_WEBHOOK] no signing key on file for workspace ${workspaceId} — rejecting`);
    return res.status(401).json({ error: 'no_signing_key' });
  }

  const sig = req.headers['x-cal-signature-256'];
  if (!sig || typeof sig !== 'string') return res.status(401).json({ error: 'missing_signature' });

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');

  const sigHex = sig.replace(/^sha256=/i, '').trim();
  let sigBuf, expBuf;
  try { sigBuf = Buffer.from(sigHex, 'hex'); expBuf = Buffer.from(expected, 'hex'); }
  catch { return res.status(401).json({ error: 'invalid_signature' }); }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  try {
    const result = await reprocessCalCom(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[CAL_COM_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'cal_com', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
