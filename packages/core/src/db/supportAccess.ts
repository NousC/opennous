// Expiring operator support access — the sweep, shared by the API and the worker.
//
// Support access is granted as a REAL `workspace_members` row carrying `support_until`, so
// every existing membership check works unchanged and there is no second access path to keep
// correct. What makes that safe rather than a backdoor is that it expires on its own: access
// we have to remember to remove is access nobody removes.
//
// The sweep lives here rather than in the API because the WORKER runs it on a clock and the
// two containers cannot import each other. One definition, both callers.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Delete every support membership whose window has passed. Returns how many. */
export async function sweepSupportAccess(supabase: SupabaseClient): Promise<{ swept: number }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('workspace_members')
    .delete()
    .not('support_until', 'is', null)
    .lt('support_until', now)
    .select('workspace_id, user_id');

  if (error) {
    console.error('[SUPPORT] sweep failed:', error.message);
    return { swept: 0 };
  }

  // Logged where the CUSTOMER reads it, not only where we do — the end of a support session
  // is as much their business as the start of one.
  for (const row of (data ?? []) as { workspace_id: string; user_id: string }[]) {
    await supabase.from('workspace_system_log').insert({
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      source: 'system',
      event_type: 'support.access_expired',
      summary: 'OpenNous support access expired',
    }).then(() => {}, () => {});
  }

  if (data?.length) console.log(`[SUPPORT] swept ${data.length} expired session(s)`);
  return { swept: data?.length ?? 0 };
}
