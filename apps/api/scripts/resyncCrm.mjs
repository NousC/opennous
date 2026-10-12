// One-shot CLI: full re-sync a workspace's CRM (contacts + companies + deals)
// through the shared @nous/core pipeline, then report how the accounts linked.
//
// Ignores the incremental cursor (since=null) so it re-fetches everything, then
// prints contact→company link coverage so we can confirm the Accounts board will
// populate. Reads the encrypted CRM token straight from the DB (same resolution
// as POST /api/crm/sync-now) — nothing is stored.
//
//   Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
//   Run:   node apps/api/scripts/resyncCrm.mjs --workspace=<uuid> [--provider=attio]

import { getSupabaseClient, syncCrmProvider } from '@nous/core';
import { decrypt } from '../src/providers/crypto.mjs';

const argv = process.argv.slice(2);
const arg = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WORKSPACE = arg('workspace') || process.env.WORKSPACE_ID || null;
const PROVIDER = arg('provider') || 'attio';

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
if (!WORKSPACE) die('Pass --workspace=<uuid>.');

const supabase = getSupabaseClient();

// ── resolve the CRM token (same path as the sync-now route) ──
const { data: cfg } = await supabase.from('crm_sync_configs')
  .select('id, connection_id').eq('workspace_id', WORKSPACE).eq('provider', PROVIDER).maybeSingle();
if (!cfg?.connection_id) die(`No crm_sync_config for workspace ${WORKSPACE} / ${PROVIDER}.`);
const { data: conn } = await supabase.from('workflow_provider_connections')
  .select('encrypted_credentials').eq('id', cfg.connection_id).maybeSingle();
if (!conn?.encrypted_credentials) die('Connection has no encrypted_credentials.');
const creds = {};
for (const [k, v] of Object.entries(conn.encrypted_credentials)) creds[k] = decrypt(v);
const token = creds.api_key || creds.access_token || Object.values(creds).find(Boolean);
if (!token) die('Could not decrypt a token from the connection.');
console.log(`token_len=${String(token).length}`);

// ── full re-sync ──
console.log(`\nSyncing ${PROVIDER} for workspace ${WORKSPACE} (since=null)…`);
const result = await syncCrmProvider(supabase, WORKSPACE, PROVIDER, token, null);
console.log(JSON.stringify(result, null, 2));

// ── verify contact→company linkage ──
const { count: totalContacts } = await supabase.from('contacts')
  .select('id', { count: 'exact', head: true }).eq('workspace_id', WORKSPACE);
const { count: linkedContacts } = await supabase.from('contacts')
  .select('id', { count: 'exact', head: true }).eq('workspace_id', WORKSPACE).not('company_id', 'is', null);
const { count: totalCompanies } = await supabase.from('companies')
  .select('id', { count: 'exact', head: true }).eq('workspace_id', WORKSPACE);
console.log(`\n── linkage ──`);
console.log(`contacts:            ${totalContacts}`);
console.log(`contacts w/ company: ${linkedContacts}`);
console.log(`companies:           ${totalCompanies}`);
process.exit(0);
