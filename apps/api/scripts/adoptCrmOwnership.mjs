#!/usr/bin/env node
// Give every member of a workspace the imported records their CRM owner email already names
// (GET-284). Joining does this automatically from now on; this is for the members who were
// already there when the CRM was imported, and for checking what a join would do.
//
//   WS_ID=<uuid> node apps/api/scripts/adoptCrmOwnership.mjs            # what it would stamp
//   WS_ID=<uuid> node apps/api/scripts/adoptCrmOwnership.mjs --apply
import { getSupabaseClient, adoptCrmOwnership } from '@nous/core';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const { data: members } = await supabase.from('workspace_members').select('user_id, role').eq('workspace_id', WS);
const out = [];
for (const m of members ?? []) {
  const r = await adoptCrmOwnership(supabase, WS, m.user_id, { apply: APPLY });
  out.push({ user_id: m.user_id, role: m.role, ...r });
}
console.log(JSON.stringify({ workspace: WS, members: out, applied: APPLY }, null, 2));
if (!APPLY) console.log('Plan only. Re-run with --apply to stamp.');
