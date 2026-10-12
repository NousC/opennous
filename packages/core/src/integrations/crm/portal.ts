// Links from Nous into the customer's own HubSpot ("Open in HubSpot").
//
// A HubSpot record URL needs two things we did not keep: the portal (account) id and the UI
// domain the portal lives on. The domain is NOT always app.hubspot.com: some portals live on
// a regional host such as app-na2.hubspot.com, and EU portals are on app-eu1, so a hard-coded
// host would send people to a login page. Both come from one read, GET /account-info/v3/details,
// with the token the sync already holds; we ask once per connection and keep the answer on
// crm_sync_configs (crm_portal_id, crm_ui_domain).
//
// Read-only against HubSpot. Best-effort everywhere: a link is a convenience, so a missing column
// (migration not applied yet), a refused scope or a network error leaves the link absent and
// never fails a sync or a page.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CrmPortal { portalId: string; uiDomain: string }

/** HubSpot's object type ids, as the record URL spells them. */
const HUBSPOT_TYPE = { contact: '0-1', company: '0-2', deal: '0-3' } as const;
export type CrmRecordKind = keyof typeof HUBSPOT_TYPE;

/** https://app-na2.hubspot.com/contacts/12345678/record/0-3/10000000001 — or null. */
export function hubspotRecordUrl(portal: CrmPortal | null, kind: CrmRecordKind, hubspotId: string | number | null | undefined): string | null {
  const id = hubspotId == null ? '' : String(hubspotId).trim();
  if (!portal?.portalId || !portal.uiDomain || !/^\d+$/.test(id)) return null;
  const host = portal.uiDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `https://${host}/contacts/${portal.portalId}/record/${HUBSPOT_TYPE[kind]}/${id}`;
}

/** The workspace's HubSpot portal, when we have learned it. Null when not (yet) known. */
export async function getHubspotPortal(supabase: SupabaseClient, workspaceId: string): Promise<CrmPortal | null> {
  try {
    const { data, error } = await supabase.from('crm_sync_configs')
      .select('crm_portal_id, crm_ui_domain')
      .eq('workspace_id', workspaceId).eq('provider', 'hubspot').maybeSingle();
    if (error || !data) return null;
    const row = data as { crm_portal_id?: string | null; crm_ui_domain?: string | null };
    return row.crm_portal_id && row.crm_ui_domain ? { portalId: row.crm_portal_id, uiDomain: row.crm_ui_domain } : null;
  } catch { return null; }
}

/**
 * Learn and keep the portal id + UI domain for one HubSpot sync config, once. Called by the sync
 * worker with the token it already decrypted; a config that already knows its portal costs one
 * small select and no HubSpot call.
 */
export async function ensureHubspotPortal(supabase: SupabaseClient, configId: string, token: string): Promise<CrmPortal | null> {
  try {
    const { data, error } = await supabase.from('crm_sync_configs')
      .select('crm_portal_id, crm_ui_domain').eq('id', configId).maybeSingle();
    if (error) return null; // most likely the columns do not exist yet: no link, no harm
    const row = (data ?? {}) as { crm_portal_id?: string | null; crm_ui_domain?: string | null };
    if (row.crm_portal_id && row.crm_ui_domain) return { portalId: row.crm_portal_id, uiDomain: row.crm_ui_domain };

    const r = await fetch('https://api.hubapi.com/account-info/v3/details', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json() as { portalId?: number | string; uiDomain?: string };
    if (d.portalId == null || !d.uiDomain) return null;
    const portal = { portalId: String(d.portalId), uiDomain: String(d.uiDomain) };
    await supabase.from('crm_sync_configs')
      .update({ crm_portal_id: portal.portalId, crm_ui_domain: portal.uiDomain })
      .eq('id', configId);
    return portal;
  } catch { return null; }
}
