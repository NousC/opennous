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
  /** Open workspace: every member reads every account + its CLAIMS. Nous holds only
   *  structured claims (raw lives in the operator's git), so claims are safe for the
   *  whole team. Default OPEN — only an explicit closed workspace narrows a member to
   *  their own book. Ownership is still tracked; open just means everyone can read. */
  openVisibility?: boolean;
  /** Read as the whole team: only what every member may read. Aggregates (summaries, coaching,
   *  graph labels) are shown to everyone, so they are built from team-readable material (GET-253). */
  teamOnly?: boolean;
}

/** Read as the whole team (GET-253): for a job whose OUTPUT every member sees — a summary, a
 *  score's reasons, a coaching note. Honoured by listNotes, listAccountNotes, getClaims,
 *  searchClaims and listActivities; it names no member, so anything else reads it as system. */
export function teamReadContext(workspaceId: string): ReadContext {
  return { workspaceId, viewerUserId: null, viewerScope: 'admin', teamOnly: true };
}

/** Build a ReadContext from the fields the auth middleware sets on the request.
 *  Visibility defaults OPEN (claims are team-readable); a caller that must honour an
 *  explicitly-closed workspace passes req.openVisibility=false (see /v2/query). */
export function readContextFromReq(req: {
  workspaceId?: string;
  memberUserId?: string | null;
  viewerScope?: string;
  openVisibility?: boolean;
}): ReadContext {
  return {
    workspaceId: req.workspaceId ?? '',
    viewerUserId: req.memberUserId ?? null,
    viewerScope: req.viewerScope === 'admin' ? 'admin' : 'member',
    openVisibility: req.openVisibility !== false,
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
  if (!ctx || ctx.viewerScope === 'admin' || ctx.openVisibility) return true;
  if (ownerUserId == null) return true;
  return ownerUserId === ctx.viewerUserId;
}

/**
 * The single rule for whether a viewer may see a CLAIM — the claim-level twin of `rawVisible`.
 * A claim is a DERIVED fact about an entity, so its visibility is the account dial PLUS the
 * Phase-4 promotion:
 *
 *   - admin (or no ctx): every claim.
 *   - member: a claim for an entity in their visible set, OR a claim an admin has explicitly
 *     promoted (`derived_visibility === 'shared'`) — the one way a fact crosses the account gate.
 *
 * FAIL-CLOSED: a member with an UNKNOWN visible set (null) sees ONLY promoted claims, never a
 * whole-workspace fallback — a misconfigured caller under-shares, it never leaks. Callers pass the
 * viewer's visible entity ids (computed once via memberVisibleAccounts) so this stays a pure,
 * synchronous filter with no DB access of its own — route every member-facing claim read through it.
 */
export function claimVisible(
  claim: { entity_id: string; derived_visibility?: string | null },
  ctx: ReadContext | undefined,
  visibleEntityIds: Set<string> | null,
): boolean {
  if (!ctx || ctx.viewerScope === 'admin' || ctx.openVisibility) return true;
  if (claim.derived_visibility === 'shared') return true;
  return visibleEntityIds != null && visibleEntityIds.has(claim.entity_id);
}

/** Filter a list of claims to those the viewer may see. See `claimVisible`. */
export function filterClaimsForViewer<T extends { entity_id: string; derived_visibility?: string | null }>(
  claims: T[],
  ctx: ReadContext | undefined,
  visibleEntityIds: Set<string> | null,
): T[] {
  if (!ctx || ctx.viewerScope === 'admin' || ctx.openVisibility) return claims;
  return claims.filter((c) => claimVisible(c, ctx, visibleEntityIds));
}
