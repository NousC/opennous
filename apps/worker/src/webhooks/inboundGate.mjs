// The door for inbound webhooks (GET-1088). A delivery needs its URL's token. INBOUND_TOKEN_GRACE
// lists the providers still being moved onto tokened URLs: their old deliveries pass, logged, so
// a re-registration can't lose events. A provider leaves the list once its URLs carry the token.

import { inboundTokenValid } from '@nous/core';

const graced = (provider) => (process.env.INBOUND_TOKEN_GRACE || '')
  .split(',').map((s) => s.trim()).includes(provider);

/** Did this delivery prove itself? Only then may we believe what its body says. */
export function inboundTrusted(req, provider, workspaceId) {
  return inboundTokenValid(provider, workspaceId, req.query?.token);
}

/** May this delivery be processed at all? */
export function inboundAllowed(req, provider, workspaceId) {
  if (inboundTrusted(req, provider, workspaceId)) return true;
  if (req.query?.token || !graced(provider)) {
    console.warn(`[WEBHOOK/${provider}] delivery refused, no valid token: workspace=${workspaceId}`);
    return false;
  }
  console.warn(`[WEBHOOK/${provider}] tokenless delivery allowed by grace: workspace=${workspaceId}`);
  return true;
}

/** All Fireflies needs is the meeting id: the transcript comes from its API on the workspace's
 *  own key. A hydrated body skips that fetch, so only a proven sender may send one. */
export function untrustedFirefliesBody({ meetingId, meeting_id, eventType } = {}) {
  return {
    ...(meetingId ? { meetingId } : {}),
    ...(meeting_id ? { meeting_id } : {}),
    ...(eventType ? { eventType } : {}),
  };
}
