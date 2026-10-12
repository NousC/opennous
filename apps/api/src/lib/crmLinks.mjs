// "Open in HubSpot" links for API responses. The portal and its UI domain are learned by the CRM
// sync (ensureHubspotPortal) and kept on crm_sync_configs; record ids come from the account row
// (hubspot_company_id) and, for deals, the `deal_hubspot` identifier the sync writes. Everything
// here degrades to null: a page without the link is fine, a page that fails over it is not.
import { getHubspotPortal, hubspotRecordUrl } from '@nous/core';

/** A linker for one workspace: `link('deal', '10000000001')` → URL or null. Null when no portal. */
export async function hubspotLinker(supabase, workspaceId) {
  const portal = await getHubspotPortal(supabase, workspaceId);
  if (!portal) return null;
  return (kind, hubspotId) => hubspotRecordUrl(portal, kind, hubspotId);
}

/** Deal entity id → HubSpot deal id, for a batch of deals (the `deal_hubspot` identifier). */
export async function hubspotDealIds(supabase, workspaceId, dealEntityIds) {
  const ids = [...new Set((dealEntityIds ?? []).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('entity_identifiers').select('entity_id, value')
      .eq('workspace_id', workspaceId).eq('kind', 'deal_hubspot').in('entity_id', ids.slice(i, i + 200));
    for (const r of data ?? []) if (!out.has(r.entity_id)) out.set(r.entity_id, r.value);
  }
  return out;
}

/** Stamp `hubspot_url` on deal-shaped rows (`id` = the deal entity id). Rows keep their shape. */
export async function withDealLinks(supabase, workspaceId, rows, idOf = (r) => r.id) {
  const list = rows ?? [];
  try {
    const link = list.length ? await hubspotLinker(supabase, workspaceId) : null;
    if (!link) return list.map((r) => ({ ...r, hubspot_url: null }));
    const hs = await hubspotDealIds(supabase, workspaceId, list.map(idOf));
    return list.map((r) => ({ ...r, hubspot_url: link('deal', hs.get(idOf(r))) }));
  } catch {
    return list.map((r) => ({ ...r, hubspot_url: null }));
  }
}
