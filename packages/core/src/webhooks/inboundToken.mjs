// Who may post to an inbound webhook (GET-1088). The URL holds a workspace id, which is not a
// secret, and several providers can't sign anything. So the URL also carries a token derived from
// the provider, the workspace and our own key: every provider can send it, including ones whose
// URL a person pastes, and it needs no storage. The worker and the API derive the same value.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The providers whose URL carries a token. The rest prove themselves with their own signature. */
export const TOKENED_PROVIDERS = new Set([
  'aiark', 'emailbison', 'fathom', 'fireflies', 'granola', 'heyreach', 'instantly', 'lemlist',
  'linkedin', 'rb2b', 'smartlead', 'stripe',
]);

export function inboundToken(provider, workspaceId) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is required for inbound webhook tokens');
  return createHmac('sha256', key).update(`inbound|${provider}|${workspaceId}`).digest('hex').slice(0, 40);
}

export function inboundTokenValid(provider, workspaceId, token) {
  if (typeof token !== 'string' || !workspaceId) return false;
  try {
    const want = Buffer.from(inboundToken(provider, workspaceId));
    const got = Buffer.from(token);
    return want.length === got.length && timingSafeEqual(want, got);
  } catch { return false; }
}
