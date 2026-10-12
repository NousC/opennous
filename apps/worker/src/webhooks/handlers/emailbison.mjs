// EmailBison webhook handler — receives outbound campaign events and logs them as activities.
// Envelope per https://emailbison.com/developers:
//   { event: { type, name, instance_url, workspace_id, workspace_name }, data: { ... } }
//
// EmailBison's docs don't enumerate every `data` shape, so this handler reads lead
// identity from the common field names we've seen (lead.email, email, recipient_email,
// to_email) and falls back to logging the raw payload via the system event log when
// the event type is unknown — so we can iterate on the mapping without losing data.

import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

// EmailBison events are documented in SCREAMING_SNAKE — but operators have seen
// the dashboard emit lowercase variants too. Normalize both.
const EVENT_TYPE_MAP = {
  email_sent:          'email_sent',
  EMAIL_SENT:          'email_sent',
  email_opened:        'email_opened',
  EMAIL_OPENED:        'email_opened',
  email_clicked:       'email_opened',
  EMAIL_CLICKED:       'email_opened',
  reply_received:      'email_received',
  REPLY_RECEIVED:      'email_received',
  email_replied:       'email_received',
  EMAIL_REPLIED:       'email_received',
  interested:          'email_received',
  INTERESTED:          'email_received',
  unsubscribed:        'email_bounced',
  UNSUBSCRIBED:        'email_bounced',
  email_bounced:       'email_bounced',
  EMAIL_BOUNCED:       'email_bounced',
};

function pickEmail(data) {
  return (
    data?.lead?.email ||
    data?.lead_email ||
    data?.recipient_email ||
    data?.to_email ||
    data?.email ||
    ''
  ).toString().toLowerCase().trim();
}

function pickName(data, key) {
  return data?.lead?.[key] || data?.[`lead_${key}`] || data?.[key] || null;
}

export async function reprocessEmailBison(supabase, workspaceId, body) {
  body = body || {};
  // EmailBison wraps payloads as { event: {...}, data: {...} }. Older/test
  // payloads may flatten it — accept both.
  const envelope  = body.event && typeof body.event === 'object' ? body.event : body;
  const data      = body.data  && typeof body.data  === 'object' ? body.data  : body;

  const eventType   = (envelope.type || envelope.event_type || body.type || '').toString();
  const leadEmail   = pickEmail(data);
  const firstName   = pickName(data, 'first_name');
  const lastName    = pickName(data, 'last_name');
  const campaignId  = data.campaign_id   || data.campaign?.id   || null;
  const campaignName = data.campaign_name || data.campaign?.name || data.campaign || null;
  const preview     = data.reply_text || data.message_text || data.body || data.preview_text || null;
  const messageId   = data.message_id  || data.email_id    || data.id || null;

  console.log(`[EMAILBISON_WEBHOOK] event=${eventType} email=${leadEmail}`);

  const activityType = EVENT_TYPE_MAP[eventType];
  if (!activityType) {
    // Surface unknown events so we can iterate on the mapping without dropping data.
    await logSysEvent(supabase, {
      workspaceId, source: 'emailbison', eventType: 'webhook_unknown_event',
      summary:  `Unhandled EmailBison event: ${eventType || '(missing type)'}`,
      metadata: { type: eventType, sample_keys: Object.keys(data).slice(0, 12) },
    });
    return { skipped: `unhandled event: ${eventType}` };
  }

  if (!leadEmail) throw new Error('lead_email_required');

  const isReply = activityType === 'email_received';

  const { contact } = await resolveContact(supabase, workspaceId, {
    email:      leadEmail,
    first_name: firstName,
    last_name:  lastName,
    source:     'emailbison',
  }, { createIfMissing: isReply });

  if (!contact) return { skipped: 'contact not found' };

  const externalId = messageId
    ? `emailbison_${messageId}`
    : `emailbison_${eventType}_${leadEmail}_${Date.now()}`;

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        activityType,
    source:      'emailbison',
    externalId,
    occurredAt:  new Date().toISOString(),
    description: campaignName
      ? `${activityType.replace('_', ' ')}: ${campaignName}`
      : activityType.replace('_', ' '),
    summary:     activityType === 'email_received' && preview ? String(preview).slice(0, 500) : null,
    rawData:     { event_type: eventType, campaign_id: campaignId, campaign_name: campaignName },
  });

  await logSysEvent(supabase, {
    workspaceId, source: 'emailbison', eventType: 'webhook_received',
    summary:    `${activityType.replace('_', ' ')} from ${leadEmail}${campaignName ? ` (${campaignName})` : ''}`,
    contactId:  contact.id,
    metadata:   { type: eventType, email: leadEmail, campaign_name: campaignName },
  });

  return { contactId: contact.id, type: activityType };
}

export async function handleEmailBison(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessEmailBison(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[EMAILBISON_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'emailbison', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
