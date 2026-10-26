// On demand (GET-1034): read the open deal signals already on file again, in context, and correct
// or retire the ones that do not hold. New conversations are checked as they are read; this catches
// up what was filed before.
//
//   node apps/worker/scripts/recheckSignals.mjs --workspace=UUID [--company=UUID] [--active-days=60] [--write]
//
// Dry run by default: prints what it would rewrite or retire. Needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY, and the model keys the worker uses.
import { getSupabaseClient } from '@nous/core';
import { recheckAccount } from '../src/signals/recheckSignals.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WS = arg('workspace'), ONE = arg('company'), DAYS = Number(arg('active-days') || 60);
const WRITE = argv.includes('--write');
if (!WS) { console.error('usage: recheckSignals --workspace=UUID [--company=UUID] [--active-days=60] [--write]'); process.exit(1); }
const supabase = getSupabaseClient();

let ids = ONE ? [ONE] : [];
if (!ONE) {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('entity_list_rows').select('entity_id')
    .eq('workspace_id', WS).eq('kind', 'account').gte('last_activity_at', since).limit(1000);
  if (error) throw error;
  ids = data.map(r => r.entity_id);
}
console.log(`[RECHECK] ${ids.length} account(s) · ${WRITE ? 'WRITE' : 'dry run'}`);
const total = { checked: 0, rewritten: 0, retired: 0 };
for (const id of ids) {
  const r = await recheckAccount(supabase, WS, id, { dryRun: !WRITE }).catch(err => { console.warn(`[RECHECK] ${id}: ${err.message}`); return null; });
  if (r) for (const k of Object.keys(total)) total[k] += r[k];
}
console.log(`[RECHECK] ${total.checked} signal(s) read · ${total.rewritten} ${WRITE ? 'rewritten' : 'to rewrite'} · ${total.retired} ${WRITE ? 'retired' : 'to retire'}`);
