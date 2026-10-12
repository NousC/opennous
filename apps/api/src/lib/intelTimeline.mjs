// The account page's intel timeline (GET-794): the request side. The shaping lives in core
// (accountIntelTimeline); this reads the account's people and the window from the query.
import { accountIntelTimeline } from '@nous/core';

/** `?days=` → a window in days, or null for all time. Unknown values fall back to 90. */
export function timelineDays(raw) {
  if (raw === 'all' || raw === '0') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 3650) : 90;
}

export async function loadIntelTimeline(supabase, workspaceId, companyId, days, ctx) {
  const { data: contacts } = await supabase.from('contacts').select('id')
    .eq('workspace_id', workspaceId).eq('company_id', companyId);
  const contactIds = (contacts || []).map(c => c.id);
  const timeline = await accountIntelTimeline(supabase, workspaceId, companyId, contactIds, { sinceDays: days }, ctx);
  return { days, ...timeline };
}
