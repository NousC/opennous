// The door for inbound webhooks (GET-1088). A delivery needs its URL's token. INBOUND_TOKEN_GRACE
// lists the providers still being moved onto tokened URLs: their old deliveries pass, logged, so
// a re-registration can't lose events. A provider leaves the list once its URLs carry the token.

import { inboundTokenValid, getSupabaseClient } from '@nous/core';
import { workspaceTrialLapsed } from '../lib/trialGate.mjs';

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

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace a delivery names, in its path (/source/:id) or as ?workspace_id=. Pure. */
export function webhookWorkspaceId(req) {
  const id = String(req.path ?? '').split('/')[2] || req.query?.workspace_id;
  return WORKSPACE_ID.test(String(id ?? '')) ? String(id) : null;
}

/**
 * A lapsed trial's pushes are answered 200 and dropped (GET-1087): syncing has stopped, and an error
 * would only have the provider retry, or switch the webhook off for when they pay. A provider's
 * handshake still gets through. Routes with no workspace in the URL decide inside the handler.
 */
export function dropForLapsedTrial(req, res, next, { lapsed = workspaceTrialLapsed, db = null } = {}) {
  const workspaceId = webhookWorkspaceId(req);
  if (!workspaceId || req.body?.challenge || req.body?.type === 'url_verification') return next();
  return lapsed(db ?? getSupabaseClient(), workspaceId).then((stop) => {
    if (!stop) return next();
    console.log(`[WEBHOOK] dropped, trial ended: workspace=${workspaceId}`);
    return res.status(200).json({ ok: true, dropped: 'trial_ended' });
  }, () => next());
}
