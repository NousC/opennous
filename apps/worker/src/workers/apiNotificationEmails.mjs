// API-plan notification emails (GET-635): webhook failures, a key about to expire, credits low.
//
// The api decides who is due one and reserves it (POST /internal/api-notifications/sweep, see
// apps/api/src/lib/apiNotifications.mjs); this worker only writes the email and sends it, like
// opsLimitEmails.mjs. Dormant unless WORKER_INTERNAL_SECRET is set; sendEmail no-ops without
// RESEND_API_KEY.

import { sendEmail } from '@nous/core';

const n = (x) => Number(x || 0).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function appUrl(path) {
  return `${process.env.APP_URL || 'https://app.opennous.cloud'}${path}`;
}

/** The day a key expires, written out ("9 October"). */
function day(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** Subject, plain text and html for one queued alert. Pure, so the copy can be pinned. */
export function template(item) {
  let subject, intro, cta, path;
  if (item.kind === 'webhook_failures') {
    const name = item.subscriptionName || item.url || 'your webhook';
    const last = item.lastStatus ? `The last attempt got a ${item.lastStatus}.` : item.lastError ? `The last attempt failed: ${item.lastError}.` : '';
    subject = `Your webhook "${name}" keeps returning errors`;
    intro = item.deadLettered && item.failures < 3
      ? `Nous stopped retrying an event for "${name}" (${item.url}) after it was rejected. ${last}`
      : `The last ${item.failures} deliveries to "${name}" (${item.url}) failed. ${last}`;
    intro = `${intro.trim()} You can resend any delivery from the Webhooks page.`;
    cta = 'View deliveries';
    path = '/webhooks';
  } else if (item.kind === 'key_expiring') {
    subject = `Your API key "${item.keyName}" expires on ${day(item.expiresAt)}`;
    intro = `The API key "${item.keyName}" stops working on ${day(item.expiresAt)}. Anything using it will get a 401 after that. Create a new key and swap it in before then.`;
    cta = 'Manage keys';
    path = '/keys';
  } else { // credits_low
    subject = `You've used ${item.percentUsed}% of this month's credits`;
    intro = `You've used ${n(item.used)} of the ${n(item.included)} credits on your plan this month (${item.percentUsed}%). Nothing changes yet.`;
    cta = 'View usage';
    path = '/usage';
  }

  const link = appUrl(path);
  const text = `${intro}\n\n${cta}: ${link}\n\nNous`;
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:520px">` +
    `<p>${esc(intro)}</p>` +
    `<p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;font-size:13px">${cta}</a></p>` +
    `<p style="color:#888;font-size:12px;margin-top:24px">Nous</p>` +
    `</div>`;
  return { subject, text, html };
}

/** Ask the api what is due for `kinds` and send it. Never throws. */
export async function runApiNotificationEmails(kinds, { fetchImpl = fetch, send = sendEmail } = {}) {
  const secret = process.env.WORKER_INTERNAL_SECRET;
  if (!secret) return; // dormant until activated
  const apiUrl = process.env.API_URL;
  if (!apiUrl) { console.warn('[API-NOTIFY] API_URL unset, skipping'); return; }

  let queued = [];
  try {
    const r = await fetchImpl(`${apiUrl}/internal/api-notifications/sweep`, {
      method: 'POST',
      headers: { 'X-Internal-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kinds }),
    });
    if (!r.ok) { console.error('[API-NOTIFY] sweep failed:', r.status); return; }
    ({ queued = [] } = await r.json());
  } catch (e) {
    console.error('[API-NOTIFY] sweep error:', e?.message);
    return;
  }

  for (const item of queued) {
    const t = template(item);
    for (const to of item.to ?? []) {
      try {
        await send({ to, subject: t.subject, text: t.text, html: t.html, tag: 'API_NOTIFY' });
        console.log(`[API-NOTIFY] sent ${item.kind} → ${to}`);
      } catch (e) {
        console.error(`[API-NOTIFY] send failed ${item.kind} ${to}:`, e?.message);
      }
    }
  }
}
