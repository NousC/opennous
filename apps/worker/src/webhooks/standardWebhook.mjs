// Standard Webhooks signatures, the scheme Fathom and Granola share. No key on the connection
// means nothing to check. A key with a missing header is refused: skipping the check then would
// let anyone bypass it by leaving the header out (GET-247).

import { createHmac, timingSafeEqual } from 'crypto';

/** A key is stored but can't be decrypted. That is not "no key": nothing can pass. */
export const UNREADABLE_KEY = Object.freeze({ unreadable: true });

export function verifyStandardWebhook(secret, rawBody, webhookId, webhookTimestamp, signatureHeader) {
  if (!secret) return true;
  if (secret === UNREADABLE_KEY) return false;
  if (!signatureHeader || !webhookId || !webhookTimestamp) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(webhookTimestamp, 10)) > 300) return false;           // 5-min replay window

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const secretKey = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const want = Buffer.from(createHmac('sha256', Buffer.from(secretKey, 'base64')).update(signedContent).digest('base64'));

  // Header is space-separated `v1,<sig>` pairs.
  return signatureHeader.split(' ').map((s) => Buffer.from(s.split(',').slice(1).join(',')))
    .some((got) => got.length === want.length && timingSafeEqual(got, want));
}
