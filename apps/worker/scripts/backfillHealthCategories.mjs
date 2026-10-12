#!/usr/bin/env node
// Move the health signals into the categories the taxonomy now has for them (GET-401).
//
// WHAT WAS THERE
//
// Until GET-401 the customer-success reads filed every signal under a borrowed category, with the
// real kind in `metadata.signal_type`:
//
//   health_expansion   → category buying_signal        now expansion_signal, stance asked
//   health_risk        → category pain                 now risk_signal, severity at_risk
//   (mined decline)    → category objection            now expansion_signal, stance declined
//                        stance = declined, no signal_type on purpose, `mined_from` set
//
// The Intel tab read those categories literally, so a customer account showed "Corwin formally
// cancelled" as a Pain and "Add-on Scheduler" as a Buying Signal. The category is what every rollup
// filters on, and the tag was invisible to all of them.
//
// WHAT THIS DOES
//
// Rewrites `value.category` on those rows, and fills the sub-tag the category now carries where
// the row has none. Nothing else on the row changes: the tag stays (readers written before the
// categories existed still key on it, until GET-402 moves them), the content, quote, provenance
// and dates stay, `invalid_at` is not touched. Idempotent: a row already in its new category is
// skipped, so this is safe to run twice.
//
// It never scans `claims` by property. The CS handoff's first trap: `like 'note.%'` across a
// workspace is a statement timeout waiting to happen, and the first draft of this script did
// exactly that. Health signals are filed on the COMPANY entity, and the companies that can carry
// one are the customer cohort — so this reads the cohort off `entity_list_rows` the way
// `loadCustomerRows` does, then reads claims by entity id in batches of 100, the one shape of
// claims read that is known to return on the first customer's workspace.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/backfillHealthCategories.mjs            # dry run, prints the plan
//   WS_ID=<uuid> node apps/worker/scripts/backfillHealthCategories.mjs --apply
//   ... --all-workspaces                                                           # every workspace, one after another

import { pathToFileURL } from 'node:url';
import { lockScript } from '../src/lib/backfillLock.mjs';
import { getSupabaseClient } from '@nous/core';

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all-workspaces');
const WS = process.env.WS_ID;
const PAGE = 1000;

/** What a row becomes, or null when it is not a health signal (or is already moved). */
export function healthRecategorisation(value) {
  const cat = String(value?.category ?? '');
  const m = value?.metadata ?? {};
  const tag = String(m.signal_type ?? '');
  const mined = m.mined_from != null;

  if (tag === 'health_expansion') {
    if (cat === 'expansion_signal' && m.stance) return null;
    return { category: 'expansion_signal', metadata: { stance: m.stance || 'asked', product: m.product ?? null } };
  }
  if (tag === 'health_risk') {
    if (cat === 'risk_signal' && 'severity' in m) return null;
    // The verifier's re-filed asks (`reclassified_from: 'asked'`) are complaints that read as
    // interest — a problem raised with frustration, so `friction`, the grade the verifier now
    // writes itself. Everything else the miner called a risk is ungraded until GET-402 reads it
    // again, and `at_risk` is what a reader treats null as.
    const severity = m.severity ?? (m.reclassified_from === 'asked' ? 'friction' : 'at_risk');
    return { category: 'risk_signal', metadata: { severity } };
  }
  if (mined && String(m.stance ?? '') === 'declined') {
    if (cat === 'expansion_signal') return null;
    return { category: 'expansion_signal', metadata: { stance: 'declined', product: m.product ?? null } };
  }
  return null;
}

async function workspaces(supabase) {
  if (!ALL) return [WS];
  const { data, error } = await supabase.from('workspaces').select('id').order('id');
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => r.id);
}

/** Every row of a paged read. PostgREST truncates at 1000 without saying so. */
async function pageAll(make) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * The company ids a health signal can sit on: whoever the CRM tracks as an account (a `cs` bag)
 * or whoever bought something. The union, for the same reason `loadCustomerRows` takes it.
 */
async function cohort(supabase, ws) {
  const base = (cols) => supabase.from('entity_list_rows').select(cols).eq('workspace_id', ws).eq('kind', 'account');
  const ids = new Set();
  const withHealth = await pageAll((f, t) => base('entity_id').not('cs', 'is', null).order('entity_id').range(f, t))
    .catch(e => { if (/does not exist/i.test(String(e.message))) return []; throw e; });
  for (const r of withHealth) ids.add(r.entity_id);
  for (const r of await pageAll((f, t) => base('entity_id').gt('won_deals', 0).order('entity_id').range(f, t))) ids.add(r.entity_id);
  return [...ids];
}

async function run(supabase, ws) {
  const counts = { accounts: 0, scanned: 0, expansion: 0, risk: 0, declined: 0, written: 0, failed: 0 };
  const ids = await cohort(supabase, ws);
  counts.accounts = ids.length;
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase.from('claims').select('id, value')
      .eq('workspace_id', ws).is('invalid_at', null)
      .in('entity_id', ids.slice(i, i + 100))
      .like('property', 'note.%').limit(5000);
    if (error) throw new Error(error.message);
    counts.scanned += data?.length ?? 0;

    for (const row of data ?? []) {
      const next = healthRecategorisation(row.value);
      if (!next) continue;
      if (next.category === 'risk_signal') counts.risk++;
      else if (next.metadata.stance === 'declined') counts.declined++;
      else counts.expansion++;
      if (!APPLY) continue;

      const value = { ...row.value, category: next.category, metadata: { ...(row.value?.metadata ?? {}), ...next.metadata } };
      const { error: uErr } = await supabase.from('claims').update({ value }).eq('id', row.id);
      if (uErr) { counts.failed++; console.warn(`  ${row.id}: ${uErr.message}`); } else counts.written++;
    }
  }
  const found = counts.expansion + counts.risk + counts.declined;
  console.log(`${ws}: ${counts.accounts} customer accounts · scanned ${counts.scanned} note claims · ${found} to move `
    + `(${counts.expansion} expansion asks → expansion_signal, ${counts.declined} declines → expansion_signal/declined, `
    + `${counts.risk} risks → risk_signal)`
    + (APPLY ? ` · written ${counts.written}, failed ${counts.failed}` : ' · dry run, nothing written'));
}

// The pure decision above is imported by its test; the walk below runs only when this is the script.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!WS && !ALL) { console.error('WS_ID is required (or --all-workspaces)'); process.exit(1); }
  const supabase = getSupabaseClient();
  // One lock per workspace it touches, taken as it gets there.
  for (const ws of await workspaces(supabase)) {
    const lock = await lockScript(supabase, ws, 'backfillHealthCategories', { leaseMinutes: 90 });
    try { await run(supabase, ws); } finally { await lock.release(); }
  }
  if (!APPLY) console.log('re-run with --apply to write');
}
