// One-off / on demand (GET-1027): read accounts as a whole and retire the claims a later one, or
// the people now on file, settled. The nightly sweep only covers accounts that changed that day;
// this catches up everything already on file.
//
//   node apps/worker/scripts/reconcileAccounts.mjs --workspace=UUID [--company=UUID] [--active-days=60] [--write]
//
// Dry run by default: prints what it would retire and why. Needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY, and the model keys the worker uses.
import { getSupabaseClient } from '@nous/core';
import { reconcileAccount } from '../src/signals/reconcileAccount.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WS = arg('workspace'), ONE = arg('company'), DAYS = Number(arg('active-days') || 60);
const WRITE = argv.includes('--write');
if (!WS) { console.error('usage: reconcileAccounts --workspace=UUID [--company=UUID] [--active-days=60] [--write]'); process.exit(1); }
const supabase = getSupabaseClient();

let ids = ONE ? [ONE] : [];
if (!ONE) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('entity_list_rows').select('entity_id')
    .eq('workspace_id', WS).eq('kind', 'account').gte('last_activity_at', since).limit(1000);
  if (error) throw error;
  ids = data.map(r => r.entity_id);
}
console.log(`[RECONCILE] ${ids.length} account(s) · ${WRITE ? 'WRITE' : 'dry run'}`);
let retired = 0;
for (const id of ids) {
  const r = await reconcileAccount(supabase, WS, id, { dryRun: !WRITE }).catch(err => ({ skipped: err.message }));
  retired += r.retired ?? 0;
}
console.log(`[RECONCILE] ${retired} claim(s) ${WRITE ? 'retired' : 'to retire (dry run)'}`);
