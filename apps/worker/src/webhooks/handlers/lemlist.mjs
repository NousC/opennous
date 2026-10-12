// Lemlist webhook handler — receives outbound email + LinkedIn campaign events.
//
// Wiring: a single webhook is auto-registered on connect (POST /api/hooks with
// no `type` filter). That means Lemlist sends every activity event to us; we
// dispatch them via EVENT_TYPE_MAP and silently drop the ones we intentionally
// ignore (see SKIPPED_EVENTS).
//
// Lemlist payload field names per docs:
//   { _id, type, teamId, createdAt, campaignId, campaignName, sequenceId,
//     sequenceStep, leadId, leadEmail, leadFirstName, leadLastName,
//     sendUserId, sendUserEmail, sendUserName, subject, secret? }
//
// Auth: per-connection secret stored on workflow_provider_connections (set at
// auto-register time). Lemlist echoes it back as `body.secret` on every
// delivery. We compare against the stored secret with a constant-time check;
// LEMLIST_WEBHOOK_SECRET env var works as a fallback for self-hosters who
// configured webhooks manually instead of via auto-register.
//
// Skipping rationale: linkedinReplied / linkedinInviteAccepted fire when a
// reply or accept lands in the user's LinkedIn inbox. Native LinkedIn (Unipile)
// is already the source of truth for those — we'd log duplicates if we acted
// on the Lemlist copy too. Lead-state-group aggregates (contacted/hooked/
// warmed/etc.) conflate channels and arrive in addition to the channel-
// specific events we already handle, so we skip those too.

import crypto from 'crypto';
import { getSupabaseClient, upsertCampaignMessage, replySignalToSentiment } from '@nous/core';
import { decrypt } from '../../utils/encryption.mjs';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';

const EVENT_TYPE_MAP = {
  // Email
  emailsSent:         'email_sent',
  emailsOpened:       'email_opened',
  emailsClicked:      'email_opened',
  emailsReplied:      'email_received',
  emailsBounced:      'email_bounced',
  emailsFailed:       'email_bounced',
  emailsInterested:    'email_received',    // strong intent — treat as a reply
  emailsNotInterested: 'email_received',    // negative intent — was dropped before
  emailsUnsubscribed: 'email_bounced',
  // LinkedIn (outbound only — Unipile covers inbound)
  linkedinSent:             'linkedin_message_sent',
  linkedinOpened:           'linkedin_message_opened',
  linkedinInviteDone:       'linkedin_connection_sent',
  linkedinFollowDone:       'linkedin_follow_sent',
  linkedinVisitDone:        'linkedin_profile_view',
  linkedinLikeLastPostDone: 'linkedin_like',
  linkedinVoiceNoteDone:    'linkedin_message_sent',
  // Lifecycle
  campaignComplete: 'campaign_completed',
};

// Lemlist's native disposition events → our canonical reply signal. Preempts the
// LLM classifier (we trust Lemlist's call). Absent → null, classifier decides.
const PROVIDER_SIGNAL = {
  emailsInterested:    'positive',
  emailsNotInterested: 'negative',
  emailsUnsubscribed:  'unsubscribe',
};

// Events we know about but deliberately don't act on, so they don't get logged
// as "unknown event" in workspace_system_log.
const SKIPPED_EVENTS = new Set([
  // Native LinkedIn (Unipile) is already the source of truth for these
  'linkedinReplied',
  'linkedinInviteAccepted',
  // Lead-state aggregates duplicate the channel-specific events we already handle
  'contacted', 'hooked', 'attracted', 'warmed', 'interested', 'notInterested',
  // Failed / skipped variants — telemetry-only, not contact-level signals
  'linkedinSendFailed', 'linkedinVisitFailed', 'linkedinFollowFailed',
  'linkedinFollowSkipped', 'linkedinInviteFailed', 'linkedinEndorseDone',
  'linkedinEndorseFailed', 'linkedinEndorseSkipped', 'linkedinVoiceNoteFailed',
  'linkedinLikeLastPostNoPost', 'linkedinLikeLastPostFailed',
  'linkedinWithdrawInvitationDone', 'linkedinWithdrawInvitationFailed',
  'linkedinInterested', 'linkedinNotInterested',
  // Channels we don't have UI for yet
  'whatsappMessageSent', 'whatsappMessageDelivered', 'whatsappMessageOpened',
  'whatsappReplied', 'whatsappMessageFailed',
  'smsSent', 'smsDelivered', 'smsReplied', 'smsFailed',
  'aircallCreated', 'aircallEnded', 'aircallDone',
  'aircallInterested', 'aircallNotInterested',
  'callRecordingDone', 'callTranscriptDone',
  // Internal plumbing / not contact-level
  'apiDone', 'apiInterested', 'apiNotInterested', 'apiFailed',
  'manualInterested', 'manualNotInterested',
  'annotated', 'paused', 'resumed', 'stopped',
  'customDomainErrors', 'connectionIssue', 'sendLimitReached', 'lemwarmPaused',
  'enrichmentDone', 'enrichmentError',
  'inboxLabelUpdated', 'signalRegistered', 'deliverabilityAlertTriggered',
]);

async function loadLemlistSecret(supabase, workspaceId) {
  try {
    const { data: conn } = await supabase
      .from('workflow_provider_connections')
      .select('encrypted_credentials, workflow_providers!inner(name)')
      .eq('workspace_id', workspaceId)
      .eq('workflow_providers.name', 'lemlist')
      .maybeSingle();
    const enc = conn?.encrypted_credentials?.webhook_secret;
    if (!enc) return null;
    try { return decrypt(enc); }
    catch { return null; }
  } catch { return null; }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}

function pickEmail(body) {
  return (
    body.leadEmail ||
    body.email ||
    body.lead?.email ||
    ''
  ).toString().toLowerCase().trim();
}

export async function reprocessLemlist(supabase, workspaceId, body) {
  body = body || {};
  const eventType    = body.type || body.event || '';
  const leadEmail    = pickEmail(body);
  const firstName    = body.leadFirstName || body.firstName || body.lead?.firstName || null;
  const lastName     = body.leadLastName  || body.lastName  || body.lead?.lastName  || null;
  const campaignId   = body.campaignId   || body.campaign?._id  || body.campaign?.id || null;
  const campaignName = body.campaignName || body.campaign?.name || null;
  const subject      = body.subject || null;
  const preview      = body.text || body.replyText || body.body || null;
  const messageId    = body.messageId || body._id || null;
  // Variant attribution — Lemlist's unit is (campaignId, sequenceStep).
  const sequenceStep = body.sequenceStep ?? null;
  const sequenceId   = body.sequenceId ?? null;
  const variant      = body.variant ?? null;
  const sentBody     = body.html ?? body.emailBody ?? body.bodyHtml ?? null;

  console.log(`[LEMLIST_WEBHOOK] event=${eventType} email=${leadEmail}`);

  if (SKIPPED_EVENTS.has(eventType)) return { skipped: `intentional: ${eventType}` };

  const activityType = EVENT_TYPE_MAP[eventType];
  if (!activityType) {
    await logSysEvent(supabase, {
      workspaceId, source: 'lemlist', eventType: 'webhook_unknown_event',
      summary:  `Unhandled Lemlist event: ${eventType || '(missing type)'}`,
      metadata: { type: eventType, sample_keys: Object.keys(body).slice(0, 12) },
    });
    return { skipped: `unhandled event: ${eventType}` };
  }

  if (!leadEmail) throw new Error('lead_email_required');

  const isReply = activityType === 'email_received';
  const isSent  = activityType === 'email_sent';
  // Prefer Lemlist's native disposition over our own classifier when present.
  const provSignal = PROVIDER_SIGNAL[eventType] ?? null;

  const { contact } = await resolveContact(supabase, workspaceId, {
    email:      leadEmail,
    first_name: firstName,
    last_name:  lastName,
    source:     'lemlist',
  }, { createIfMissing: isReply });

  if (!contact) return { skipped: 'contact not found' };

  const externalId = messageId
    ? `lemlist_${messageId}`
    : `lemlist_${eventType}_${leadEmail}_${Date.now()}`;

  await logActivity(supabase, {
    workspaceId,
    contactId:   contact.id,
    companyId:   contact.company_id || null,
    type:        activityType,
    source:      'lemlist',
    externalId,
    occurredAt:  new Date().toISOString(),
    description: campaignName
      ? `${activityType.replace(/_/g, ' ')}: ${campaignName}`
      : activityType.replace(/_/g, ' '),
    summary:     isReply && preview ? String(preview).slice(0, 500)
                 : isSent ? ((sentBody || subject || '').slice(0, 2000) || null)
                 : (subject || null),
    rawData:     {
      event_type: eventType, campaign_id: campaignId, campaign_name: campaignName,
      step: sequenceStep, sequence_id: sequenceId, variant, subject,
      // Native disposition preempts the LLM classifier.
      ...(provSignal ? { provider_signal: provSignal, sentiment: replySignalToSentiment(provSignal) } : {}),
      ...(isSent ? { is_outbound: true } : {}),
    },
  });

  // Stash the sent copy per (campaign, step, variant).
  if (isSent && campaignId && (subject || sentBody)) {
    upsertCampaignMessage(supabase, workspaceId, {
      provider: 'lemlist', campaignId, campaignName, step: sequenceStep, variant,
      subject, body: sentBody, source: 'webhook',
    }).catch(() => {});
  }

  await logSysEvent(supabase, {
    workspaceId, source: 'lemlist', eventType: 'webhook_received',
    summary:    `${activityType.replace(/_/g, ' ')} from ${leadEmail}${campaignName ? ` (${campaignName})` : ''}`,
    contactId:  contact.id,
    metadata:   { type: eventType, email: leadEmail, campaign_name: campaignName },
  });

  return { contactId: contact.id, type: activityType };
}

export async function handleLemlist(req, res, workspaceId) {
  const supabase = getSupabaseClient();

  // Per-workspace secret check, with LEMLIST_WEBHOOK_SECRET env fallback.
  // If neither is configured (fresh self-host, no auto-register run), accept
  // the webhook unverified — same default we use for the other paste-required
  // providers when their env var is unset.
  const stored   = await loadLemlistSecret(supabase, workspaceId);
  const envSec   = process.env.LEMLIST_WEBHOOK_SECRET || null;
  const expected = stored || envSec;
  if (expected) {
    const got = (req.body?.secret || '').toString();
    if (!constantTimeEqual(got, expected)) {
      console.warn(`[LEMLIST_WEBHOOK] secret mismatch — workspace=${workspaceId}`);
      return res.status(401).json({ error: 'invalid_secret' });
    }
  }

  try {
    const result = await reprocessLemlist(supabase, workspaceId, req.body);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[LEMLIST_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'lemlist', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
