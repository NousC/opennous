// Per-member privacy: the viewer context threaded into read resolvers, and the
// single filter that decides whether a raw row is visible to that viewer.
// See PRIVACY_MODEL.md. This is the one audited chokepoint — every leak-critical
// reader routes its raw rows through `rawVisible`, so the rule lives in one place.

export type ViewerScope = 'admin' | 'member';

export interface ReadContext {
  /** The workspace being read. */
  workspaceId: string;
  /** The member doing the reading (their users.id), or null for a legacy/
   *  workspace-wide caller that predates per-member identity. */
  viewerUserId: string | null;
  /** 'admin' = owner/admin/legacy key, sees all raw. 'member' = scoped to own. */
  viewerScope: ViewerScope;
}

/** Build a ReadContext from the fields the auth middleware sets on the request.
 *  Fail-closed default: if no scope was resolved, treat as a scoped member (never
 *  silently admin) so a misconfigured path under-shares rather than leaks. */
export function readContextFromReq(req: {
  workspaceId?: string;
  memberUserId?: string | null;
  viewerScope?: string;
}): ReadContext {
  return {
    workspaceId: req.workspaceId ?? '',
    viewerUserId: req.memberUserId ?? null,
    viewerScope: req.viewerScope === 'admin' ? 'admin' : 'member',
  };
}

/** An admin-scoped context (sees all raw). For system/worker callers that are not
 *  acting as a specific member (ingestion, scoring, cron) — they are not a
 *  privacy boundary and must see everything to do their job. */
export function systemReadContext(workspaceId: string): ReadContext {
  return { workspaceId, viewerUserId: null, viewerScope: 'admin' };
}

/**
 * Whether a raw row (an observation or a document carrying an owner_user_id) is
 * visible to the viewer.
 *
 * - admin/owner: everything.
 * - null owner: a system/derived/shared row (enrichment, a non-channel event, an
 *   un-attributed legacy row) — not a private conversation, so shared.
 * - otherwise: only if the viewer owns it.
 *
 * The absence of a ReadContext (undefined) means an old caller that hasn't been
 * migrated yet — treat as admin so behaviour is unchanged until it's threaded,
 * NOT as a leak of a specific member's data (there's no member to leak to).
 */
export function rawVisible(ownerUserId: string | null | undefined, ctx?: ReadContext): boolean {
  if (!ctx || ctx.viewerScope === 'admin') return true;
  if (ownerUserId == null) return true;
  return ownerUserId === ctx.viewerUserId;
}
