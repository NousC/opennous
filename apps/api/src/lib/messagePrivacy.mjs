// The API's handle on message privacy (GET-244). The rule itself lives in @nous/core
// (privacy/messagePrivacy.mjs) and in visible_observations_v2; this only builds the viewer from
// a request so no route can forget to name who is reading.

import { readContextFromReq, loadMessageViewer } from '@nous/core';

/**
 * A ReadContext that always names the signed-in person when there is one. `memberUserId` is set
 * only when the request carries a workspace; a route fetched by id alone would otherwise read as
 * a system caller — and a system caller sees every message's content.
 */
export function viewerReadContext(req, workspaceId) {
  const ctx = readContextFromReq(req);
  return {
    ...ctx,
    workspaceId: workspaceId || ctx.workspaceId,
    viewerUserId: req.memberUserId ?? req.internalUserId ?? null,
  };
}

/** The message viewer for a request, or null for an unauthenticated/system caller. */
export function requestMessageViewer(supabase, req, workspaceId) {
  const userId = req.memberUserId ?? req.internalUserId ?? null;
  return userId ? loadMessageViewer(supabase, workspaceId || req.workspaceId, userId) : Promise.resolve(null);
}
