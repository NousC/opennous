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
 *   (apiKey, workspaceId, credentials) → { plain?, secret?, error?, detail?, note? }
 *   `credentials` is the full submitted form, for providers that need more than the key
 *   (Fellow's subdomain).
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
import { publicApiBase } from '../lib/publicApiBase.mjs';

export function workerBaseUrl() {
  return (process.env.WORKER_URL
    || process.env.API_URL
    || (process.env.API_DOMAIN ? `https://${process.env.API_DOMAIN}` : null)
    || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

/** Where a given provider's events land, as the provider must call it: the PUBLIC address (GET-666).
 *  The worker serves /inbound/* behind Caddy. */
export function inboundUrl(provider, workspaceId) {
  return `${publicApiBase()}/inbound/${provider}/${workspaceId}`;
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
// No auto-subscribe. Fathom's webhook-create API (POST /external/v1/webhooks) did not
// reliably register a destination for us — connections came back with an api_key but no
// webhook_id, and Fathom's own UI showed no webhook — so 'auto' reported success while
// nothing was wired up and no meeting ever arrived. Fathom is therefore webhook: 'manual'
// in the catalogue: the connect form shows the inbound URL and the user pastes it into
// Fathom's own Add Webhook form. The worker still verifies signatures when a secret is
// present — see the FATHOM_WEBHOOK_SECRET fallback in apps/worker/src/webhooks/handlers/fathom.mjs.

// ── Granola ───────────────────────────────────────────────────────────────
//
// Granola's public API creates the webhook off the user's key. It signs every
// delivery with a signing_secret IT generates and returns ONCE on create (Standard
// Webhooks, HMAC-SHA256), so we keep it (encrypted) and verify webhook-signature on
// the way back in — see apps/worker/src/webhooks/handlers/granola.mjs.
//
// The webhook API is gated to Business/Enterprise. Personal and free plans get a
// 402/403/404, which is not an error worth blocking the connection over: the Granola
// poller imports notes on a schedule regardless. Say so and move on — same shape as
// Calendly's plan gate.
//
// scopes must be sent; 'personal' covers notes the key's owner owns or that were
// shared with them (workspace keys would need ['workspace'], but the app issues
// personal keys, which is what each rep connects).
async function subscribeGranola(apiKey, workspaceId) {
  try {
    const res = await fetch('https://public-api.granola.ai/v1/webhook-endpoints', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url:    inboundUrl('granola', workspaceId),
        scopes: ['personal'],
        events: ['note.generated', 'note.edited', 'note.access_granted'],
      }),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const planGated = res.status === 402 || res.status === 403 || res.status === 404
        || String(detail?.message || detail?.error || '').toLowerCase().includes('upgrade');
      return {
        error: `granola_subscribe_failed_${res.status}`,
        detail,
        note: planGated
          ? 'Connected. Granola only offers webhooks on Business and Enterprise plans, so realtime meeting notifications are off — your notes still import on a schedule.'
          : null,
      };
    }

    const body = await res.json().catch(() => ({}));
    const id = body?.id ?? null;
    const signingSecret = body?.signing_secret ?? null;   // shown only once — store it now
    if (!id) return { error: 'granola_webhook_id_missing', detail: body };
    return {
      plain:  { webhook_id: String(id) },
      // No secret is not fatal — the worker skips signature verification when it has
      // none, exactly like the Fathom manual-paste path.
      secret: signingSecret ? { webhook_signing_key: signingSecret } : {},
    };
  } catch (err) {
    return { error: 'granola_subscribe_exception', message: err.message };
  }
}

async function unsubscribeGranola(apiKey, creds) {
  const id = creds?.webhook_id;
  if (!apiKey || !id) return;
  try {
    await fetch(`https://public-api.granola.ai/v1/webhook-endpoints/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    console.warn('[WEBHOOK/granola] unsubscribe:', err.message);
  }
}

// ── Fellow ────────────────────────────────────────────────────────────────
//
// Fellow's API lives on the customer's own subdomain, so every call needs the subdomain
// as well as the key — which is why subscribe takes the whole credentials object (the
// third argument connect.mjs passes) rather than the key alone.
//
// Creating the webhook makes Fellow POST a `url_verification` challenge to our inbound
// URL and wait up to 10s for the raw challenge back; the worker answers it before any
// signature or DB work (handlers/fellow.mjs). So the worker must be serving
// /inbound/fellow before anyone can connect — the catalogue sanity check cannot see that.
//
// Deliveries are svix-signed with a `whsec_` secret returned ONCE on create; we keep it
// encrypted. `ai_note.generated` carries the whole call (transcript, AI notes, attendees)
// so it is the only event we need.
//
// Webhooks can be switched off for a Fellow workspace (503, or 502 "switched off for the
// account"). Not worth failing the connection over: the Fellow poller imports recordings
// for any connection with no webhook_id. Same shape as Granola's plan gate.

/**
 * `acme`, `acme.fellow.app` and `https://acme.fellow.app/…` all mean the same workspace.
 * Returns null for anything that is not a bare DNS label — the value becomes a hostname we
 * send an API key to, so it must never be able to point anywhere but *.fellow.app.
 */
export function fellowSubdomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.fellow\.(app|co|ai)$/, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

export function fellowApiBase(subdomain) {
  const sub = fellowSubdomain(subdomain);
  return sub ? `https://${sub}.fellow.app/api/v1` : null;
}

async function subscribeFellow(apiKey, workspaceId, credentials = {}) {
  const sub = fellowSubdomain(credentials?.subdomain);
  if (!sub) return { error: 'fellow_subdomain_missing' };
  const create = (scope) => fetch(`${fellowApiBase(sub)}/webhook`, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url:            inboundUrl('fellow', workspaceId),
      enabled_events: ['ai_note.generated'],
      description:    'Nous — meeting notes and transcripts',
      status:         'active',
      scope,
    }),
  });
  try {
    // Fellow is a COMPANY source: ask for every meeting in the Fellow workspace first.
    //   403 — the key is not Super Admin. Fall back to a user webhook (the owner's meetings)
    //         and say so: that key could not read the rest over the API either.
    //   503 — workspace webhooks are switched off on their Fellow workspace. Register NOTHING:
    //         a user webhook would stop the poller, and the poller reads every meeting the key
    //         can see (all of them, for a Super Admin key) on a 15-minute schedule.
    let scope = 'workspace';
    let res = await create(scope);
    let narrowed = false;
    if (res.status === 403) {
      scope = 'user';
      narrowed = true;
      res = await create(scope);
    }

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      const featureOff = res.status === 502 || res.status === 503;
      return {
        error: `fellow_subscribe_failed_${res.status}`,
        detail,
        note: featureOff
          ? 'Connected. Webhooks are not enabled on your Fellow workspace, so meetings import every 15 minutes instead of in realtime.'
          : null,
      };
    }

    const body = await res.json().catch(() => ({}));
    const id = body?.webhook?.id ?? null;
    const secret = body?.webhook?.secret ?? null;   // shown only once — store it now
    if (!id) return { error: 'fellow_webhook_id_missing', detail: body };
    return {
      // The subdomain in plain too: unsubscribe only receives the stored blob, and this
      // saves it decrypting a value that is not a secret.
      plain:  { webhook_id: String(id), fellow_subdomain: sub, webhook_scope: scope },
      secret: secret ? { webhook_signing_key: secret } : {},
      note: narrowed
        ? 'Connected, but only for the meetings this key\'s owner can see. To bring in every meeting in your Fellow workspace, reconnect with a Super Admin API key.'
        : null,
    };
  } catch (err) {
    return { error: 'fellow_subscribe_exception', message: err.message };
  }
}

async function unsubscribeFellow(apiKey, creds) {
  const id = creds?.webhook_id;
  const base = fellowApiBase(creds?.fellow_subdomain);
  if (!apiKey || !id || !base) return;
  try {
    await fetch(`${base}/webhook/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: { 'X-API-KEY': apiKey },
    });
  } catch (err) {
    console.warn('[WEBHOOK/fellow] unsubscribe:', err.message);
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
 * Cannot be here, because the provider offers no working way: fireflies, hubspot and
 * millionverifier have no webhook-creation API at all, and fathom's create API did not
 * reliably register a destination (see the Fathom note above). Those are webhook:
 * 'manual' in the catalogue, and the connect form shows the URL to paste and a link to
 * the page to paste it on. That is the ceiling, not an oversight.
 */
export const WEBHOOK_HANDLERS = {
  calendly:  { subscribe: subscribeCalendly,  unsubscribe: unsubscribeCalendly  },
  cal_com:   { subscribe: subscribeCalCom,    unsubscribe: unsubscribeCalCom    },
  heyreach:  { subscribe: subscribeHeyReach,  unsubscribe: unsubscribeHeyReach  },
  lemlist:   { subscribe: subscribeLemlist,   unsubscribe: unsubscribeLemlist   },
  instantly: { subscribe: subscribeInstantly, unsubscribe: unsubscribeInstantly },
  granola:   { subscribe: subscribeGranola,   unsubscribe: unsubscribeGranola   },
  fellow:    { subscribe: subscribeFellow,    unsubscribe: unsubscribeFellow    },
};
