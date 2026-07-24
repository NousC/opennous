// Application-level tenant guard.
//
// All DB access goes through the Supabase SERVICE-ROLE client, which bypasses
// Row-Level Security — so RLS is NOT a backstop. Every route that resolves a
// resource by a bare id (rather than by a membership-checked workspaceId in the
// query/body) MUST confirm the caller belongs to that resource's workspace, or
// it's a cross-tenant IDOR. This is the single helper that check goes through.
//
// verifySupabaseAuth already validates membership when a workspaceId is present
// in the request; this covers the id-addressed routes where it isn't.

export async function isWorkspaceMember(supabase, workspaceId, internalUserId) {
  if (!workspaceId || !internalUserId) return false;
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', internalUserId)
    .maybeSingle();
  return !!data;
}
