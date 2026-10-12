#!/usr/bin/env node
// Import a CHOSEN set of HubSpot companies into a workspace, and everything that belongs to them
// (GET-273): contacts, deals with stage history and rosters, reason fields, line items,
// subscriptions and invoices, and the calls, emails, meetings and notes on them since a date floor.
//
// Why a script and not "connect HubSpot": connecting pulls the whole portal and queues the
// workspace history backfill. A client import is a list of accounts, run once, dry-run first.
//
// The token comes from the environment only and is never stored: no connection row is written, so
// nothing syncs again on its own afterwards. Plans without --apply (HubSpot reads only).
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> HUBSPOT_TOKEN=... COMPANY_IDS=101,102 [SINCE_DAYS=365] \
//     node apps/worker/scripts/hubspotScopedImport.mjs            # counts only
//   ... node apps/worker/scripts/hubspotScopedImport.mjs --apply  # writes

import { getSupabaseClient, syncCrmProvider, resolveHubspotScope } from '@nous/core';

const WS = process.env.WS_ID;
const TOKEN = process.env.HUBSPOT_TOKEN;
const COMPANY_IDS = String(process.env.COMPANY_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 365);
const APPLY = process.argv.includes('--apply');

if (!WS || !TOKEN || !COMPANY_IDS.length) {
  console.error('WS_ID, HUBSPOT_TOKEN and COMPANY_IDS are required');
  process.exit(1);
}
const engagementsSince = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString();

const scope = await resolveHubspotScope(TOKEN, COMPANY_IDS);
console.log(JSON.stringify({
  workspace: WS, companies: COMPANY_IDS.length, engagements_since: engagementsSince,
  // Engagement counts are BEFORE the date floor; the import drops older ones as it reads them.
  records_in_scope: Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, v.length])),
}, null, 2));

if (!APPLY) {
  console.log('Plan only. Re-run with --apply to import.');
  process.exit(0);
}

const supabase = getSupabaseClient();
const { data: ws } = await supabase.from('workspaces').select('id, name').eq('id', WS).maybeSingle();
if (!ws) { console.error(`workspace ${WS} not found`); process.exit(1); }

const started = Date.now();
const result = await syncCrmProvider(supabase, WS, 'hubspot', TOKEN, null, {
  scope: { hubspotCompanyIds: COMPANY_IDS, engagementsSince },
});
const { closedDeals, ...report } = result;
console.log(JSON.stringify({ workspace: ws.name, seconds: Math.round((Date.now() - started) / 1000), closed_deals_seen: closedDeals.length, ...report }, null, 2));
process.exit(result.errors.length ? 2 : 0);
