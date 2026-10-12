// Resolve which member owns a workspace's connection to a given provider — the
// member we attribute that provider's op-log events to, so they land in that
// person's own Activity feed (/connect › Activity), not only the company op log.
//
// Used by webhook handlers for personal-connection providers (cal.com, calendly,
// …) where the connection is one row per workspace with an owner. Returns null
// when nothing is connected or no owner is stamped — the event stays owner-less
// (company-level), which fails safe. Never throws.
export async function providerConnectionOwner(supabase, workspaceId, providerName) {
  try {
    const { data } = await supabase
      .from('workflow_provider_connections')
      .select('owner_user_id, workflow_providers!inner(name)')
      .eq('workspace_id', workspaceId)
      .eq('workflow_providers.name', providerName)
      .eq('is_verified', true)
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return data?.owner_user_id ?? null;
  } catch {
    return null;
  }
}
