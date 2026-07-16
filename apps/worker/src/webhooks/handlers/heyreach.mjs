// HeyReach webhook handler — LinkedIn outbound signals.
// HeyReach posts JSON like: { eventType, timestamp, leadProfile: { firstName, lastName, emailAddress, linkedInUrl, ... }, message, campaign: { id, name }, ... }
// Each subscription is single-event, so we route off the top-level eventType field.

import { getSupabaseClient } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

// Map HeyReach event types → internal activity types. Replies and acceptances
// are strong intent signals; the rest update existing contacts only.
const EVENT_TYPE_MAP = {
  MESSAGE_REPLY_RECEIVED:       'linkedin_message_received',
  EVERY_MESSAGE_REPLY_RECEIVED: 'linkedin_message_received',
  INMAIL_REPLY_RECEIVED:        'linkedin_message_received',
  CONNECTION_REQUEST_ACCEPTED:  'linkedin_connection_accepted',
  CONNECTION_REQUEST_SENT:      'linkedin_connection_sent',
  MESSAGE_SENT:                 'linkedin_message_sent',
  INMAIL_SENT:                  'linkedin_message_sent',
  FOLLOW_SENT:                  'linkedin_follow_sent',
  LIKED_POST:                   'linkedin_like',
  VIEWED_PROFILE:               'linkedin_profile_view',
  CAMPAIGN_COMPLETED:           'campaign_completed',
  LEAD_TAG_UPDATED:             'tag_updated',
};

function pickLead(body) {
  return body.leadProfile || body.lead || body.leadData || body.data?.leadProfile || body.data?.lead || {};
}

export async function reprocessHeyReach(supabase, workspaceId, body) {
  body = body || {};
  const eventType = body.eventType || body.event_type || body.type || body.event?.type || '';
  const lead      = pickLead(body);

  const linkedInUrl = lead.linkedInUrl || lead.linkedinUrl || lead.profileUrl || lead.linkedin_url || null;
  const email       = (lead.emailAddress || lead.email || '').toLowerCase().trim() || null;
  const firstName   = lead.firstName || lead.first_name || null;
  const lastName    = lead.lastName  || lead.last_name  || null;
  const campaignId   = body.campaign?.id   || body.campaignId   || null;
  const campaignName = body.campaign?.name || body.campaignName || null;
  const messageText  = body.message?.text  || body.message?.body || body.messageText || null;
  const messageId    = body.message?.id    || body.messageId    || body.id || null;

  console.log(`[HEYREACH_WEBHOOK] event=${eventType} email=${email || ''} linkedin=${linkedInUrl || ''}`);

  const activityType = EVENT_TYPE_MAP[eventType];
  if (!activityType) {
    await logSysEvent(supabase, {
      workspaceId, source: 'heyreach', eventType: 'webhook_unknown_event',
      summary:  `Unhandled HeyReach event: ${eventType || '(missing type)'}`,
      metadata: { type: eventType, sample_keys: Object.keys(body).slice(0, 12) },
    });
    return { skipped: `unhandled event: ${eventType}` };
  }

  if (!email && !linkedInUrl) throw new Error('email_or_linkedin_required');

  const isReply = activityType === 'linkedin_message_received';
  const isAccept = activityType === 'linkedin_connection_accepted';

  const { contact } = await resolveContact(supabase, workspaceId, {
    email,
    linkedin_url: linkedInUrl,
    first_name:   firstName,
    last_name:    lastName,
    source:       'heyreach',
  }, { createIfMissing: isReply || isAccept });

  if (!contact) return { skipped: 'contact not found' };

  const externalId = messageId
    ? `heyreach_${messageId}`
    : `heyreach_${eventType}_${email || linkedInUrl}_${Date.now()}`;

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        activityType,
    source:      'heyreach',
    externalId,
    occurredAt:  new Date().toISOString(),
    description: campaignName
      ? `${activityType.replace(/_/g, ' ')}: ${campaignName}`
      : activityType.replace(/_/g, ' '),
    summary:     isReply && messageText ? String(messageText).slice(0, 500) : null,
    rawData:     { event_type: eventType, campaign_id: campaignId, campaign_name: campaignName },
  });

  await logSysEvent(supabase, {
    workspaceId, source: 'heyreach', eventType: 'webhook_received',
    summary:    `${activityType.replace(/_/g, ' ')}${campaignName ? ` (${campaignName})` : ''}`,
    contactId:  contact.id,
    metadata:   { type: eventType, email, linkedin_url: linkedInUrl, campaign_name: campaignName },
  });

  return { contactId: contact.id, type: activityType };
}

export async function handleHeyReach(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  try {
    const result = await reprocessHeyReach(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[HEYREACH_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'heyreach', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
