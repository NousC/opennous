import { inTouchEntityIds } from '@nous/core';

// Workspace account-visibility policy.
//
// open (default)           : every member reads every account and its CLAIMS. Nous never
//                            stores raw data (transcripts/emails live in the operator's
//                            git) — it holds only structured claims (deal stage, objections,
//                            facts), which are safe for the whole team to read. A 5-person
//                            team needs the full pipeline, not just its own 10 accounts.
// open === false (opt-in)  : a member sees only the accounts they own / are in touch with.
//                            Owners and admins (viewerScope 'admin') always see all.
//
// Default is OPEN: only an explicit `open_account_visibility = false` closes a workspace.
// Ownership is still tracked (relationship_owner / owner_user_id) — we always know WHO owns
// an account; open just means everyone can READ it.
//
// `restrict` is the per-request answer: whether THIS caller's account/people reads should be
// narrowed to their own book. Only true for a scoped member in an explicitly-closed workspace.

export async function getVisibilityScope(supabase, workspaceId, req) {
  const viewerUserId = req.internalUserId ?? req.memberUserId ?? null;
  const { data: ws } = await supabase
    .from('workspaces').select('open_account_visibility').eq('id', workspaceId).maybeSingle();
  const open = ws?.open_account_visibility !== false; // default OPEN unless explicitly closed
  const restrict = !open && req.viewerScope === 'member' && !!viewerUserId;
  return { open, restrict, viewerUserId };
}

// Can THIS member see THIS account? The same Access-control dial the account reads use,
// resolved for one entity — so the engine (memory, watches, autopilot) obeys governance too.
// Open workspace, an admin, or no viewer (legacy) → always visible; otherwise the entity must
// be in the member's own book.
export async function entityVisibleToMember(supabase, workspaceId, viewerUserId, entityId, { isAdmin = false } = {}) {
  if (!entityId) return false;
  if (isAdmin || !viewerUserId) return true;
  const { data: ws } = await supabase
    .from('workspaces').select('open_account_visibility').eq('id', workspaceId).maybeSingle();
  if (ws?.open_account_visibility !== false) return true;   // everyone sees all accounts
  const { companyIds, contactIds } = await memberVisibleAccounts(supabase, workspaceId, viewerUserId);
  return companyIds.has(entityId) || contactIds.has(entityId);
}

// The viewer's visible-account set as ONE resolved value, for callers that must test
// many entities at once (e.g. redacting a whole shared transcript). Returns
// { unrestricted: true } for an admin / open workspace / no viewer, else { ids: Set }.
// Computed once so the caller doesn't hit entityVisibleToMember per row.
export async function viewerVisibleAccountSet(supabase, workspaceId, viewerUserId, { isAdmin = false } = {}) {
  if (isAdmin || !viewerUserId) return { unrestricted: true };
  const { data: ws } = await supabase
    .from('workspaces').select('open_account_visibility').eq('id', workspaceId).maybeSingle();
  if (ws?.open_account_visibility !== false) return { unrestricted: true };
  const { companyIds, contactIds } = await memberVisibleAccounts(supabase, workspaceId, viewerUserId);
  return { unrestricted: false, ids: new Set([...companyIds, ...contactIds]) };
}

// A webhook is a team destination: it is sent every account's events, whoever made it. On a closed
// workspace that is more than a member may read, so only an admin may create or test one there
// (GET-1066). Sends the 403 and returns true when the caller is such a member.
export async function refuseTeamFeedToMember(supabase, workspaceId, req, res) {
  const { restrict } = await getVisibilityScope(supabase, workspaceId, req);
  if (!restrict) return false;
  res.status(403).json({
    error: 'admin_key_required',
    detail: 'This workspace is closed: a webhook is sent every account\'s events, so only an admin can create or test one.',
  });
  return true;
}

// The caller's book as a Set of account and person ids, or null when they read the whole
// workspace (admin, open workspace, no viewer). For readers that filter many rows at once: the
// events feed, the graph, the observations log (GET-1066).
export async function requestBook(supabase, workspaceId, req) {
  const viewerId = req.memberUserId ?? req.internalUserId ?? null;
  const set = await viewerVisibleAccountSet(supabase, workspaceId, viewerId, { isAdmin: req.viewerScope === 'admin' });
  return set.unrestricted ? null : set.ids;
}

// The accounts a restricted member may see: the people they are in touch with (their
// relationship_owner membership), plus the companies those people belong to. Only
// called when getVisibilityScope().restrict is true.
export async function memberVisibleAccounts(supabase, workspaceId, viewerUserId) {
  const contactIds = await inTouchEntityIds(supabase, workspaceId, viewerUserId);
  const companyIds = new Set();
  // A company entity the member is directly attributed to is visible too.
  for (const id of contactIds) companyIds.add(id);
  if (contactIds.size) {
    const ids = [...contactIds];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase
        .from('contacts').select('company_id')
        .in('id', ids.slice(i, i + 200)).not('company_id', 'is', null);
      for (const c of data || []) if (c.company_id) companyIds.add(c.company_id);
    }
  }
  return { contactIds, companyIds };
}
