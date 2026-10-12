// Viewer role — the manager/rep axis for role-gated surfaces (Reporting is
// manager-only; My Studio is rep-only).
//
// Distinct from PLAN gating on purpose: a plan-locked item renders greyed with
// an upsell (you can buy your way in); the wrong ROLE simply doesn't see the
// surface (a rep can't upgrade into being a manager).
//
// Source of truth: `userData.workspace_role` off /me (me.mjs selects `role`
// from workspace_members and echoes it). A session with no resolvable role
// keeps BOTH surfaces visible — the same "show everything, then settle" rule
// usePlan follows. Preview mode injects the field via the role switcher.
//
// This split is a UI axis, NOT an access boundary — deliberate product
// decision (2026-08-05): the browser declutters by role, while agents and
// API-key callers (MCP tools, GTM engineers) read everything. me.mjs carries
// the same note on the server side.

export type ViewerRole = "manager" | "rep";

// workspace_members.role → viewer role. owner/admin run the team; member/viewer
// work the book.
export function roleOf(userData: any): ViewerRole | null {
  const raw = (userData?.workspace_role ?? "").toString().toLowerCase();
  if (raw === "owner" || raw === "admin" || raw === "founder") return "manager";
  if (raw === "member" || raw === "viewer") return "rep";
  return null;
}

/**
 * Workspace owner/admin (or the founder): may rotate webhook secrets, sees every key's usage.
 * The same rule as Settings' admin sections. The API enforces its own checks; this only decides
 * what to show.
 */
export function isWorkspaceAdmin(userData: { is_founder?: unknown; workspace_role?: unknown } | null | undefined): boolean {
  if (userData?.is_founder) return true;
  const raw = (userData?.workspace_role ?? "").toString().toLowerCase();
  return raw === "owner" || raw === "admin" || raw === "founder";
}
