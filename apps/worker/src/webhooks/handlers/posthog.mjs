// PostHog webhook handler (GET-751) — the live half of the PostHog source.
//
// The destination we create on connect (apps/api/src/providers/webhooks.mjs, subscribePostHog)
// posts the customer's signup event and their key events here, one delivery per event, with the
// connection's secret in X-Nous-Secret. The body is PostHog's {event} and {person} globals.
//
// Each event with an email:
//   · resolves the person, creating them (and their company, from a work-email domain) if new.
//     A free-mail signup becomes a person with no account, the same rule every source follows.
//   · the signup event is also an `interaction.signed_up` on their timeline.
//   · every event is a `product.event` observation, which is what "When a PostHog event fires"
//     automations run on (packages/core/src/services/automationRun.mjs, processPostHogEvents).
// Events with no email (an anonymous visitor), and the workspace's own team (its domains and its
// members' sign-in emails), are acknowledged and dropped.

import crypto from 'crypto';
import { getSupabaseClient, parsePostHogDelivery, recordObservation, loadOwnDomains, advancePipelineStage, POSTHOG_DEFAULT_SIGNUP_EVENT } from '@nous/core';
import { logActivity } from '../../utils/activity.mjs';
import { resolveContact } from '../../utils/resolveContact.mjs';
import { enqueueForRetry } from '../../utils/webhookInbox.mjs';
import { logSysEvent } from '../../utils/systemLog.mjs';
import { decrypt } from '../../utils/encryption.mjs';

// Every PostHog connection in the workspace (one per project): the inbound URL is per workspace,
// so a delivery is matched to its connection by the secret it carries.
async function loadPostHogConnections(supabase, workspaceId) {
  const { data } = await supabase
    .from('workflow_provider_connections')
    .select('encrypted_credentials, workflow_providers!inner(name)')
    .eq('workspace_id', workspaceId)
    .eq('workflow_providers.name', 'posthog');
  return (data ?? []).map(conn => {
    const creds = conn.encrypted_credentials ?? {};
    let secret = null;
    try { secret = creds.webhook_secret ? decrypt(creds.webhook_secret) : null; } catch { secret = null; }
    return { secret, signupEvent: creds.signup_event || POSTHOG_DEFAULT_SIGNUP_EVENT };
  });
}

/**
 * The workspace's own people by email: its members' sign-in addresses. A teammate who signs in
 * with a personal address (gmail.com) is not caught by the own-domain rule, and is still not a
 * customer of the workspace's product.
 */
export async function memberEmails(supabase, workspaceId) {
  const { data: members } = await supabase.from('workspace_members').select('user_id').eq('workspace_id', workspaceId);
  const ids = (members ?? []).map(m => m.user_id).filter(Boolean);
  if (!ids.length) return new Set();
  const { data: users } = await supabase.from('users').select('email').in('id', ids);
  return new Set((users ?? []).map(u => String(u.email ?? '').toLowerCase()).filter(Boolean));
}

export function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** One delivery onto the graph. Pure of the request, so the retry worker can replay it. */
export async function reprocessPostHog(supabase, workspaceId, body, { signupEvent = null } = {}) {
  const ev = parsePostHogDelivery(body);
  if (!ev) return { skipped: 'not_an_event' };
  if (!ev.email) return { skipped: 'no_email', event: ev.name };
  const signup = signupEvent ?? (await loadPostHogConnections(supabase, workspaceId))[0]?.signupEvent ?? POSTHOG_DEFAULT_SIGNUP_EVENT;
  const isSignup = ev.name === signup;
  // The workspace's own team trying their own product is not a customer (the Fellow rule).
  const own = await loadOwnDomains(supabase, workspaceId).catch(() => new Set());
  const domain = ev.email.split('@')[1];
  if (own.has(domain)) return { skipped: 'own_domain', event: ev.name };
  if ((await memberEmails(supabase, workspaceId).catch(() => new Set())).has(ev.email)) return { skipped: 'own_member', event: ev.name };

  const { contact } = await resolveContact(supabase, workspaceId, {
    email: ev.email,
    first_name: ev.firstName,
    last_name: ev.lastName,
    full_name: ev.fullName,
    // The company the product put on the person, so a free-mail signup can still land on it.
    // Without one, resolveContact's enrichment looks it up from the address and name.
    company_name: ev.companyName,
    company_domain: ev.companyDomain,
    source: 'posthog',
  }, { createIfMissing: true });
  if (!contact) return { skipped: 'unresolved' };

  if (isSignup) {
    await logActivity(supabase, {
      workspaceId,
      contactId:   contact.id,
      companyId:   contact.company_id || null,
      type:        'signed_up',
      source:      'posthog',
      externalId:  `posthog_signup_${ev.uuid}`,
      occurredAt:  ev.occurredAt,
      description: 'Signed up',
      rawData:     { event: ev.name },
    });
    // The stage as of now. The activity is dated to the signup, a moment before resolveContact wrote
    // the new person as 'identified' (now), and the newest stage observation wins, so the
    // 'interested' the activity hook wrote would lose to it. Advance-only, so a later rung stays.
    await advancePipelineStage(supabase, workspaceId, contact.id, 'signed_up', { occurredAt: new Date().toISOString() }).catch(() => {});
    // A user of the product from this moment, not from the next daily pull.
    await recordObservation(supabase, {
      workspaceId, entityId: contact.id, kind: 'state', property: 'product.user', value: true,
      source: 'posthog', method: 'webhook', observedAt: new Date().toISOString(), externalId: `posthog_user_${ev.uuid}`,
    });
  }

  await recordObservation(supabase, {
    workspaceId,
    entityId:   contact.id,
    kind:       'event',
    property:   'product.event',
    value:      { name: ev.name, properties: ev.properties },
    source:     'posthog',
    method:     'webhook',
    observedAt: ev.occurredAt,
    externalId: `posthog_event_${ev.uuid}`,
    raw:        { account_id: contact.company_id || null, signup: isSignup },
  });

  await logSysEvent(supabase, {
    workspaceId, source: 'posthog', eventType: 'webhook_received',
    summary:   `${ev.name} from ${ev.email}`,
    contactId: contact.id,
    metadata:  { event: ev.name, signup: isSignup },
  });

  return { ok: true, event: ev.name, signup: isSignup };
}

export async function handlePostHog(req, res, workspaceId) {
  const supabase = getSupabaseClient();
  const conns = (await loadPostHogConnections(supabase, workspaceId)).filter(c => c.secret);
  if (!conns.length) return res.status(401).json({ error: 'posthog_not_connected' });
  const conn = conns.find(c => secretMatches(req.headers['x-nous-secret'], c.secret));
  if (!conn) return res.status(401).json({ error: 'invalid_secret' });
  try {
    const result = await reprocessPostHog(supabase, workspaceId, req.body, { signupEvent: conn.signupEvent });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[POSTHOG_WEBHOOK] processing failed, queuing for retry:', err.message);
    await enqueueForRetry(supabase, { workspaceId, source: 'posthog', req, err });
    return res.status(200).json({ ok: true, queued: true });
  }
}
