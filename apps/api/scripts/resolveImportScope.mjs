#!/usr/bin/env node
// Work out which accounts an import covers, once, and write them to a file the runs share.
//
// The answer costs dozens of searches and HubSpot limits searches per SECOND across the whole portal,
// so several runs splitting the work must not each pay it (GET-291). Resolve here, pass
// SCOPE_FILE to every run.
//
//   WS_ID=<uuid> OUT=/tmp/scope.json node apps/api/scripts/resolveImportScope.mjs

import { writeFile } from 'node:fs/promises';
import { getSupabaseClient, hubspotImportScope } from '@nous/core';
import { crmState } from '../src/lib/connectIngest.mjs';
import { decrypt } from '../src/providers/crypto.mjs';

const WS = process.env.WS_ID;
const OUT = process.env.OUT || '/tmp/scope.json';
const MONTHS = Number(process.env.MONTHS ?? 12);
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const crm = await crmState(supabase, WS);
if (!crm) { console.error('no CRM connected'); process.exit(1); }

const { data: conn } = await supabase.from('workflow_provider_connections')
  .select('encrypted_credentials').eq('id', crm.connectionId).maybeSingle();
const creds = {};
for (const [k, v] of Object.entries(conn?.encrypted_credentials ?? {})) {
  if (typeof v !== 'string') continue;
  try { creds[k] = decrypt(v); } catch { creds[k] = v; }
}
const token = creds.access_token || creds.api_key || Object.values(creds).find(v => typeof v === 'string');
if (!token) { console.error('no token on the connection'); process.exit(1); }

const started = Date.now();
const { companyIds } = await hubspotImportScope(token, { months: MONTHS });
await writeFile(OUT, JSON.stringify(companyIds));
console.log(JSON.stringify({ accounts: companyIds.length, months: MONTHS, out: OUT, seconds: Math.round((Date.now() - started) / 1000) }, null, 2));
