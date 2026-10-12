#!/usr/bin/env node
// Check every mined expansion ask against its own quote, and retire the ones that do not hold up.
//
// WHY A SECOND PASS
//
// The miner reads a year of an account's conversations at once, which is what lets it find "could
// we roll this out to the second office too" buried in call forty. The cost of that width is precision: it
// sees a product named near a question and sometimes calls that intent, and the worst miss is
// wrong in the direction that does damage. An invented example of the shape:
//
//   Pemberton Cycles, flagged as wanting Lumen Alerts. The quote:
//   "Can we turn the alerts off? The team finds them noisy."
//
// That is a complaint filed as a buying signal. A rep who opens with it looks like they have not
// read their own account. Others are quotes with no ask in them at all — "Call me back when
// you have a minute."
//
// So each ask is re-read ALONE, with nothing but its own quote and the product claimed. Narrow
// context, one question, no room to reach: does this sentence show the customer wanting this
// product? It is the cheap half of an expensive job — many short calls against fewer, far longer ones.
//
// WHAT IT DOES TO A FAILURE
//
// Invalidates the claim rather than deleting it: `invalid_at` set, so it leaves the page and the
// evidence chain survives. A verdict of `complaint` is rewritten as a RISK instead, because
// "they want Lumen Alerts switched off" is not nothing — it is the wrong list, not the wrong
// fact.
//
// 2026-10-01: the check itself lives in apps/worker/src/services/csSignalCheck.mjs, shared with
// the miner, and an ask is kept only when TWO independent re-reads both say yes. A single verdict
// moved between runs on the same quote (support questions flipped in and out), and the second
// read is cheap. Support and pitch verdicts (a request for access, our rep presenting the product)
// are retired like NO: those were most of what the first pass let through.
//
// USAGE:
//   WS_ID=<uuid> node apps/worker/scripts/verifyExpansionSignals.mjs
//   WS_ID=<uuid> node apps/worker/scripts/verifyExpansionSignals.mjs --apply
//   WS_ID=<uuid> node apps/worker/scripts/verifyExpansionSignals.mjs --restore <backup file>   undo an --apply

import { getSupabaseClient } from '@nous/core';
import { createMessage, messageText } from '../src/lib/llm.mjs';
import { checkAsk } from '../src/services/csSignalCheck.mjs';
import { lockScript } from '../src/lib/backfillLock.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const WS = process.env.WS_ID;
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const APPLY = process.argv.includes('--apply');
const MODEL = arg('model', 'claude-haiku-4-5-20251001');
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();
const lock = await lockScript(supabase, WS, 'verifyExpansionSignals', { leaseMinutes: 60 });

// UNDO A RUN. Puts every claim in the backup file back exactly as it was before --apply touched it.
const RESTORE = arg('restore', null);
if (RESTORE) {
  const backup = JSON.parse(readFileSync(RESTORE, 'utf8'));
  if (backup.workspace !== WS) { console.error(`backup is for ${backup.workspace}, not ${WS}`); await lock.exit(1); }
  let restored = 0;
  for (const r of backup.rows) {
    const { error } = await supabase.from('claims').update({ value: r.value, invalid_at: r.invalid_at })
      .eq('id', r.id).eq('workspace_id', WS);
    if (error) console.error(`  ${r.id}: ${error.message}`); else restored++;
  }
  console.log(`restored ${restored} of ${backup.rows.length} claims from ${RESTORE}`);
  await lock.exit(0);
}

// Every mined ask, asked for BY ENTITY.
//
// Not `like 'note.%'` across the workspace: `claims` is large here and a property scan over it
// hits the statement timeout, exactly as it did for the health read that put the `cs` bag on the
// account row in the first place. The cohort is the accounts that carry a health bag, which is
// the only place a mined ask can live, and entity ids are indexed.
const cohort = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('entity_list_rows').select('entity_id')
    .eq('workspace_id', WS).eq('kind', 'account').not('cs', 'is', null)
    .order('entity_id').range(from, from + 999);
  if (error) throw new Error(`cohort: ${error.message}`);
  cohort.push(...(data ?? []).map(r => r.entity_id));
  if (!data || data.length < 1000) break;
}
console.log(`accounts carrying health: ${cohort.length}`);

const asks = [];
for (let i = 0; i < cohort.length; i += 100) {
  const { data, error } = await supabase.from('claims')
    .select('id, entity_id, value')
    .eq('workspace_id', WS).is('invalid_at', null)
    .in('entity_id', cohort.slice(i, i + 100))
    .like('property', 'note.%').limit(4000);
  if (error) throw new Error(error.message);
  for (const c of data ?? []) {
    const m = c.value?.metadata ?? {};
    if (m.stance !== 'asked' || !m.mined_from || !m.quote || !m.product) continue;
    asks.push({ id: c.id, entityId: c.entity_id, product: String(m.product), quote: String(m.quote), text: String(c.value?.content ?? '') });
  }
}
console.log(`mined expansion asks to verify: ${asks.length}`);
if (!asks.length) await lock.exit(0);

let yes = 0, complaint = 0, no = 0, failed = 0;
const verdicts = [];
const llm = { createMessage, messageText, model: MODEL };
for (let i = 0; i < asks.length; i += 8) {
  const batch = await Promise.all(asks.slice(i, i + 8).map(async (a) => {
    const [x, y] = await Promise.all([checkAsk(a, llm), checkAsk(a, llm)]);
    // A failed check is not a failed signal: leave it alone rather than retiring something on a
    // network error. Otherwise both reads must say yes; a complaint from either is a complaint.
    const v = (x.verdict === 'SKIP' || y.verdict === 'SKIP') ? 'SKIP'
      : (x.verdict === 'YES' && y.verdict === 'YES') ? 'YES'
      : (x.verdict === 'COMPLAINT' || y.verdict === 'COMPLAINT') ? 'COMPLAINT'
      : 'NO';
    return { ...a, verdict: v, reads: [x.verdict, y.verdict] };
  }));
  for (const v of batch) {
    verdicts.push(v);
    if (v.verdict === 'YES') yes++; else if (v.verdict === 'COMPLAINT') complaint++; else if (v.verdict === 'NO') no++; else failed++;
  }
  process.stdout.write(`\r  ${verdicts.length}/${asks.length} · kept ${yes} · complaints ${complaint} · dropped ${no} · errors ${failed}   `);
}
console.log(`\n\nverdicts: ${yes} hold up, ${complaint} are complaints, ${no} do not hold up, ${failed} could not be checked`);
console.log(`precision on the mined asks: ${Math.round((100 * yes) / (yes + complaint + no))}%`);

console.log('\n--- a sample of what would be DROPPED ---');
for (const v of verdicts.filter(x => x.verdict === 'NO').slice(0, 6)) {
  console.log(`  [${v.product}] ${v.reads.join("/")} "${v.quote.replace(/\s+/g, ' ').slice(0, 120)}"`);
}
console.log('\n--- a sample of what becomes a RISK instead ---');
for (const v of verdicts.filter(x => x.verdict === 'COMPLAINT').slice(0, 6)) {
  console.log(`  [${v.product}] "${v.quote.replace(/\s+/g, ' ').slice(0, 120)}"`);
}

if (!APPLY) { console.log('\nDry run. Re-run with --apply to retire the failures.'); await lock.exit(0); }

// Retire the failures. `invalid_at` rather than a delete: the page stops showing it, the evidence
// chain survives, and a verdict can be revisited.
const now = new Date().toISOString();

// A BACKUP BEFORE ANY WRITE. Every claim this is about to touch, exactly as it is now, so the run
// can be undone row for row: `--restore <file>` puts `value` and `invalid_at` back.
const touching = verdicts.filter(v => v.verdict === 'NO' || v.verdict === 'COMPLAINT').map(v => v.id);
const before = [];
for (let i = 0; i < touching.length; i += 100) {
  const { data, error } = await supabase.from('claims').select('id, value, invalid_at')
    .eq('workspace_id', WS).in('id', touching.slice(i, i + 100));
  if (error) { console.error(`backup read failed, writing nothing: ${error.message}`); await lock.exit(1); }
  before.push(...(data ?? []));
}
const backupFile = `cs-verify-backup-${WS}-${now.replace(/[:.]/g, '-')}.json`;
writeFileSync(backupFile, JSON.stringify({ workspace: WS, at: now, rows: before }, null, 1));
console.log(`\nbackup of ${before.length} claims written to ${backupFile} (undo: --restore ${backupFile})`);

let retired = 0, converted = 0;
for (const v of verdicts) {
  if (v.verdict === 'NO') {
    const { error } = await supabase.from('claims').update({ invalid_at: now }).eq('id', v.id).eq('workspace_id', WS);
    if (!error) retired++;
  } else if (v.verdict === 'COMPLAINT') {
    // The wrong list, not the wrong fact. Re-file as a risk: drop the stance and product so no
    // reader can take it for an ask, and tag it so the standing engine counts it. The category
    // is the taxonomy's own since GET-401 (it was `pain` with the kind hidden in the tag); a
    // complaint that reads as an ask is a problem raised with frustration, so it is `friction`.
    const { data: row } = await supabase.from('claims').select('value').eq('id', v.id).eq('workspace_id', WS).maybeSingle();
    const value = row?.value ?? {};
    const meta = { ...(value.metadata ?? {}), stance: null, product: null, severity: 'friction', signal_type: 'health_risk', reclassified_from: 'asked' };
    const { error } = await supabase.from('claims')
      .update({ value: { ...value, category: 'risk_signal', metadata: meta } })
      .eq('id', v.id).eq('workspace_id', WS);
    if (!error) converted++;
  }
}
console.log(`\nretired ${retired} asks, reclassified ${converted} as risks`);
console.log(`${yes} expansion asks remain, each one checked against its own quote.`);
await lock.release();
