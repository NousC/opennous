/**
 * Webhook registration, one entry per provider.
 *
 * The promise the product makes is: you paste an API key and the webhook wires itself
 * up. No copying a URL out of our UI and into theirs, no wondering why nothing arrived.
 * Where a provider's API lets us do that, it happens here on connect.
 *
 * This used to be four `if (name === '...')` blocks inside the connect route, which is
 * why only ONE of the three connect paths registered anything: the Integrations page
 * went through /:name/connect and got its webhook, while Settings and the MCP agent
 * went through the generic /connections endpoint and silently got none. Same key, same
 * provider, different door, different outcome.
 *
 * Now there is one door (connectProvider) and one registry (this file). A provider that
 * isn't in here has webhook: 'manual' or 'none' in the catalogue, which the UI reads to
 * decide whether to show the paste-this-URL panel.
 *
 * The contract for a subscribe():
 *   (apiKey, workspaceId) → { plain?, secret?, error?, detail?, note? }
 *
 *   plain   credentials to store as-is (ids and URIs we need to unsubscribe later)
 *   secret  credentials to ENCRYPT before storing (signing keys — the worker decrypts
 *           them to verify inbound payloads)
 *   error   we could not subscribe. The connection is still saved: a key that enriches
 *           but doesn't push is worth more than no key. The caller surfaces `note`.
 *
 * The contract for an unsubscribe():
 *   (apiKey, credentials) → void.  Best-effort. Called on disconnect so we don't leave
 *   dead webhooks pointing at us in someone else's account forever.
 */

import crypto from 'crypto';

export function workerBaseUrl() {
  return (process.env.WORKER_URL
    || process.env.API_URL
    || (process.env.API_DOMAIN ? `https://${process.env.API_DOMAIN}` : null)
    || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

/** Where a given provider's events land. The worker serves /inbound/* behind Caddy. */
export function inboundUrl(provider, workspaceId) {
  return `${workerBaseUrl()}/inbound/${provider}/${workspaceId}`;
}

const CAL_COM_API_VERSION = '2026-05-01';

// ── Calendly ────────────────────────────────────────────────────────────────
//
// Calendly signs every delivery with a signing_key WE generate and hand them, so we
// keep it (encrypted) and verify Calendly-Webhook-Signature on the way back in.
//
// The webhook API is gated to Standard and above. Free accounts get a 403, which is
// not an error worth blocking the connection over — backfill still works, they just
// don't get realtime bookings. Say so and move on.
async function subscribeCalendly(pat, workspaceId) {
  try {
    const meRes = await fetch('https://api.calendly.com/users/me', {
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    });
    if (!meRes.ok) return { error: `calendly_users_me_failed_${meRes.status}` };
    const me = await meRes.json();
    const userUri = me.resource?.uri;
    const orgUri  = me.resource?.current_organization;
    if (!userUri || !orgUri) return { error: 'calendly_user_or_org_uri_missing' };

    const signingKey = crypto.randomBytes(32).toString('hex');
    const res = await fetch('https://api.calendly.com/webhook_subscriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url:          inboundUrl('calendly', workspaceId),
        events:       ['invitee.created', 'invitee.canceled'],
        organization: orgUri,
        user:         userUri,
        scope:        'user',
        signing_key:  signingKey,
      }),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const planGated = res.status === 403
        || String(detail?.message || '').toLowerCase().includes('upgrade');
      return {
        error: `calendly_subscribe_failed_${res.status}`,
        detail,
        note: planGated
          ? 'Connected. Calendly only allows webhooks on Standard plans and above, so realtime booking notifications are off — past meetings still import.'
          : null,
      };
    }

    const body = await res.json();
    return {
      plain:  { webhook_subscription_uri: body.resource?.uri },
      secret: { webhook_signing_key: signingKey },
    };
  } catch (err) {
    return { error: 'calendly_subscribe_exception', message: err.message };
  }
}

async function unsubscribeCalendly(pat, creds) {
  const uri = creds?.webhook_subscription_uri;
  if (!pat || !uri) return;
  try {
    await fetch(uri, { method: 'DELETE', headers: { Authorization: `Bearer ${pat}` } });
  } catch (err) {
    console.warn('[WEBHOOK/calendly] unsubscribe:', err.message);
  }
}

// ── Cal.com ─────────────────────────────────────────────────────────────────

async function subscribeCalCom(pat, workspaceId) {
  try {
    const signingKey = crypto.randomBytes(32).toString('hex');
    const res = await fetch('https://api.cal.com/v2/webhooks', {
      method: 'POST',
      headers: {
        Authorization:      `Bearer ${pat}`,
        'Content-Type':     'application/json',
        'cal-api-version':  CAL_COM_API_VERSION,
      },
      body: JSON.stringify({
        subscriberUrl: inboundUrl('cal_com', workspaceId),
        active:        true,
        triggers:      ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'],
        secret:        signingKey,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `cal_com_subscribe_failed_${res.status}`, detail };
    }
    const body = await res.json().catch(() => ({}));
    const id = body?.data?.id ?? body?.id ?? null;
    if (!id) return { error: 'cal_com_webhook_id_missing', detail: body };
    return {
      plain:  { webhook_id: String(id) },
      secret: { webhook_signing_key: signingKey },
    };
  } catch (err) {
    return { error: 'cal_com_subscribe_exception', message: err.message };
  }
}

async function unsubscribeCalCom(pat, creds) {
  const id = creds?.webhook_id;
  if (!pat || !id) return;
  try {
    await fetch(`https://api.cal.com/v2/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${pat}`, 'cal-api-version': CAL_COM_API_VERSION },
    });
  } catch (err) {
    console.warn('[WEBHOOK/cal_com] unsubscribe:', err.message);
  }
}

// ── HeyReach ────────────────────────────────────────────────────────────────
//
// HeyReach has no "all events" webhook — one subscription per event type, so we create
// eight and keep every id. If any single create fails we roll back the ones already
// made, because a half-subscribed account delivers a confusing subset of the timeline
// and looks like a bug in us rather than a failed setup.
//
// No signing secret in their API, so the worker leans on the workspace-scoped URL plus
// the optional HEYREACH_WEBHOOK_SECRET shared secret.
const HEYREACH_EVENTS = [
  { type: 'CONNECTION_REQUEST_SENT', name: 'Nous · CR Sent' },
  { type: 'MESSAGE_SENT',            name: 'Nous · Msg Sent' },
  { type: 'INMAIL_SENT',             name: 'Nous · InMail Sent' },
  { type: 'FOLLOW_SENT',             name: 'Nous · Follow' },
  { type: 'LIKED_POST',              name: 'Nous · Liked Post' },
  { type: 'VIEWED_PROFILE',          name: 'Nous · Viewed Profile' },
  { type: 'CAMPAIGN_COMPLETED',      name: 'Nous · Campaign Done' },
  { type: 'LEAD_TAG_UPDATED',        name: 'Nous · Tag Updated' },
];

async function subscribeHeyReach(apiKey, workspaceId) {
  const url = inboundUrl('heyreach', workspaceId);
  const created = [];
  for (const { type, name } of HEYREACH_EVENTS) {
    try {
      const res = await fetch('https://api.heyreach.io/api/public/webhooks/CreateWebhook', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookName: name,
          webhookUrl:  url,
          eventType:   type,
          campaignIds: [],   // required by HeyReach; [] means "every campaign"
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        for (const id of created) await deleteHeyReachWebhook(apiKey, id);
        return { error: `heyreach_subscribe_failed_${res.status}`, detail, eventType: type };
      }
      const body = await res.json().catch(() => ({}));
      const id = body?.id ?? body?.webhookId ?? body?.data?.id;
      if (id != null) created.push(String(id));
    } catch (err) {
      for (const id of created) await deleteHeyReachWebhook(apiKey, id);
      return { error: 'heyreach_subscribe_exception', message: err.message, eventType: type };
    }
  }
  // An array, not a JSON string — encrypted_credentials is JSONB and `plain` values are
  // stored as-is, so the disconnect path can Array.isArray() this back out.
  return { plain: { webhook_ids: created } };
}

async function deleteHeyReachWebhook(apiKey, webhookId) {
  if (!webhookId) return;
  try {
    await fetch(`https://api.heyreach.io/api/public/webhooks/DeleteWebhook?webhookId=${encodeURIComponent(webhookId)}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': apiKey },
    });
  } catch (err) {
    console.warn('[WEBHOOK/heyreach] unsubscribe:', err.message);
  }
}

async function unsubscribeHeyReach(apiKey, creds) {
  if (!apiKey) return;
  const ids = creds?.webhook_ids;
  for (const id of Array.isArray(ids) ? ids : []) await deleteHeyReachWebhook(apiKey, id);
}

// ── Lemlist ─────────────────────────────────────────────────────────────────
//
// POST /api/hooks takes an optional `type`. Omit it and Lemlist sends every event on
// the one webhook, so unlike HeyReach a single subscription covers the account.
// Lemlist echoes our secret back in body.secret on each delivery; the worker checks it.
function lemlistAuth(apiKey) {
  return `Basic ${Buffer.from(`:${apiKey}`).toString('base64')}`;
}

async function subscribeLemlist(apiKey, workspaceId) {
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    const res = await fetch('https://api.lemlist.com/api/hooks', {
      method: 'POST',
      headers: { Authorization: lemlistAuth(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUrl: inboundUrl('lemlist', workspaceId),
        secret,
        // `type` omitted on purpose — that is what makes this one hook catch everything.
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `lemlist_subscribe_failed_${res.status}`, detail };
    }
    const body = await res.json().catch(() => ({}));
    const id = body?._id ?? body?.id ?? null;
    if (!id) return { error: 'lemlist_webhook_id_missing', detail: body };
    return {
      plain:  { webhook_id: String(id) },
      secret: { webhook_secret: secret },
    };
  } catch (err) {
    return { error: 'lemlist_subscribe_exception', message: err.message };
  }
}

async function unsubscribeLemlist(apiKey, creds) {
  const id = creds?.webhook_id;
  if (!apiKey || !id) return;
  try {
    await fetch(`https://api.lemlist.com/api/hooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: lemlistAuth(apiKey) },
    });
  } catch (err) {
    console.warn('[WEBHOOK/lemlist] unsubscribe:', err.message);
  }
}

// ── Instantly ───────────────────────────────────────────────────────────────
//
// Instantly's v2 API creates webhooks with nothing but the user's key, so the manual
// paste we were asking for was never necessary. This is the one people set up most, and
// it was the most annoying.
//
// `event_type` is a scalar, not an array — one webhook per event, or 'all_events' for
// the lot. We take the lot: every one of those events is a fact the graph wants, and one
// subscription is one thing to clean up.
//
// `campaign: null` means account-level, which is what we want. The alternative binds the
// webhook to one campaign and silently misses every campaign made afterwards.
//
// The key must carry a webhooks scope. A narrow key connects fine and then 403s here,
// which we surface as a note rather than swallow — see webhookNote in the catalogue.
//
// NOTE ON AUTH: we register the plain workspace-scoped URL with no shared secret,
// because Instantly cannot produce the HMAC our worker's verifyHmac expects. The worker
// only enforces that when INSTANTLY_WEBHOOK_SECRET is set, which it is not — set it and
// inbound Instantly events start 401ing. Instantly does support custom `headers` on the
// subscription, so a static-header check is the way to lock this down later.
async function subscribeInstantly(apiKey, workspaceId) {
  try {
    const res = await fetch('https://api.instantly.ai/api/v2/webhooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:            'Nous',
        target_hook_url: inboundUrl('instantly', workspaceId),
        event_type:      'all_events',
        campaign:        null,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        error:  `instantly_subscribe_failed_${res.status}`,
        detail,
        note: res.status === 403
          ? 'Connected, but your Instantly key is not allowed to create webhooks. Recreate it with webhook access and reconnect, or replies will not flow in.'
          : null,
      };
    }
    const body = await res.json().catch(() => ({}));
    const id = body?.id ?? null;
    if (!id) return { error: 'instantly_webhook_id_missing', detail: body };
    return { plain: { webhook_id: String(id) } };
  } catch (err) {
    return { error: 'instantly_subscribe_exception', message: err.message };
  }
}

async function unsubscribeInstantly(apiKey, creds) {
  const id = creds?.webhook_id;
  if (!apiKey || !id) return;
  try {
    await fetch(`https://api.instantly.ai/api/v2/webhooks/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.warn('[WEBHOOK/instantly] unsubscribe:', err.message);
  }
}

// ── Fathom ──────────────────────────────────────────────────────────────────
//
// Fathom DOES let a third party create a webhook with nothing but the user's API key,
// so the manual paste we were asking for was never necessary.
//
// Two things about their API shape:
//   - at least one include_* flag must be true or the create is rejected. We take the
//     transcript, because a meeting with no transcript adds nothing to the graph.
//   - the 201 hands back a svix-style secret (whsec_…) that WE do not choose. It is
//     per-connection, so the worker has to read it off the connection rather than out
//     of the environment — see the fallback in apps/worker/src/webhooks/handlers/fathom.mjs.
//
// Keys are USER-scoped, not workspace-scoped: this only ever sees meetings that this
// user recorded or that were shared with them. Connecting a second rep means a second
// key, which is the same shape as our LinkedIn connections.
async function subscribeFathom(apiKey, workspaceId) {
  try {
    const res = await fetch('https://api.fathom.ai/external/v1/webhooks', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        destination_url:    inboundUrl('fathom', workspaceId),
        triggered_for:      ['my_recordings'],
        include_transcript: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { error: `fathom_subscribe_failed_${res.status}`, detail };
    }
    const body = await res.json().catch(() => ({}));
    const id = body?.id ?? null;
    if (!id) return { error: 'fathom_webhook_id_missing', detail: body };
    return {
      plain:  { webhook_id: String(id) },
      secret: { webhook_signing_key: body.secret || '' },
    };
  } catch (err) {
    return { error: 'fathom_subscribe_exception', message: err.message };
  }
}

async function unsubscribeFathom(apiKey, creds) {
  const id = creds?.webhook_id;
  if (!apiKey || !id) return;
  try {
    await fetch(`https://api.fathom.ai/external/v1/webhooks/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: { 'X-Api-Key': apiKey },
    });
  } catch (err) {
    console.warn('[WEBHOOK/fathom] unsubscribe:', err.message);
  }
}

/**
 * The registry. A provider here is `webhook: 'auto'` in the catalogue; the two must
 * agree, and assertCatalogueIsSane() fails the boot if they don't.
 *
 * Deliberately NOT here, though their APIs would allow it: pipedrive, attio and apify.
 * The worker serves no /inbound route for any of them, so registering would point a
 * live webhook at a 404 and call it success. Add the handler first, then the entry.
 *
 * Cannot be here, because the provider offers no way: fireflies, hubspot and
 * millionverifier have no webhook-creation API at all. Those are webhook: 'manual' in
 * the catalogue, and the connect form shows the URL to paste and a link to the page to
 * paste it on. That is the ceiling, not an oversight.
 */
export const WEBHOOK_HANDLERS = {
  calendly:  { subscribe: subscribeCalendly,  unsubscribe: unsubscribeCalendly  },
  cal_com:   { subscribe: subscribeCalCom,    unsubscribe: unsubscribeCalCom    },
  heyreach:  { subscribe: subscribeHeyReach,  unsubscribe: unsubscribeHeyReach  },
  lemlist:   { subscribe: subscribeLemlist,   unsubscribe: unsubscribeLemlist   },
  fathom:    { subscribe: subscribeFathom,    unsubscribe: unsubscribeFathom    },
  instantly: { subscribe: subscribeInstantly, unsubscribe: unsubscribeInstantly },
};
