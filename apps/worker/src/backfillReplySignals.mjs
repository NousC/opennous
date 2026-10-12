// One-off, idempotent backfill for cold-email reply intent.
//
// Historical replies predate the reply-disposition fixes: some were never
// classified (an unsubscribe read as "engaged"), none carry a reply_signal claim
// (so no Reply chip), auto-replies inflated intent, and opt-outs never suppressed.
// This reprocesses every reply observation in a workspace through the CURRENT
// logic, then re-scores intent. Safe to re-run.
//
// Usage (from apps/worker, prod env sourced):
//   WS_ID=<uuid> node src/backfillReplySignals.mjs            # DRY RUN — prints, writes nothing
//   WS_ID=<uuid> node src/backfillReplySignals.mjs --apply    # WRITE
//   WS_ID=<uuid> DAYS=365 node src/backfillReplySignals.mjs --apply

import { getSupabaseClient, addSuppression, replySignalToSentiment, stageRank, STAGE_RANK } from '@nous/core';
import { detectOptOut, classifyReplySignal } from './signals/replySentiment.mjs';
import { runIntentScoring } from './intentScore.mjs';

const WS = process.env.WS_ID;
const DAYS = Number(process.env.DAYS || 180);
const APPLY = process.argv.includes('--apply');

// Inbound reply channels. email_received is how Instantly/Smartlead/etc. land.
const REPLY_PROPS = [
  'interaction.email_received', 'interaction.email_reply', 'interaction.email_replied',
  'interaction.linkedin_replied', 'interaction.linkedin_reply',
];
const OPTOUT = new Set(['unsubscribe', 'do_not_contact']);

async function main() {
  if (!WS) { console.error('WS_ID env var required'); process.exit(1); }
  const supabase = getSupabaseClient();
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  console.log(`\n=== Reply-signal backfill — ws ${WS} — last ${DAYS}d — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  const { data: obs, error } = await supabase.from('observations')
    .select('id, entity_id, property, value, raw, observed_at')
    .eq('workspace_id', WS).in('property', REPLY_PROPS)
    .gte('observed_at', since).order('observed_at', { ascending: true });
  if (error) { console.error('load failed:', error.message); process.exit(1); }
  const replies = (obs || []).filter(o => o.raw?.is_outbound !== true);
  console.log(`Loaded ${replies.length} inbound reply observation(s).`);

  // 1. Classify anything still unclassified; update the observation raw so intent
  //    reads the right sentiment. Opt-outs are caught deterministically first.
  let classified = 0;
  for (const o of replies) {
    let sig = o.raw?.reply_signal ?? o.raw?.provider_signal ?? null;
    if (sig) continue;
    const body = o.value?.summary || o.value?.description || '';
    sig = detectOptOut(body) || await classifyReplySignal(body, supabase, WS);
    if (!sig) { console.log(`  · unclassified (left as-is): ${o.entity_id} "${body.slice(0, 50)}"`); continue; }
    const raw = { ...(o.raw || {}), reply_signal: sig, sentiment: replySignalToSentiment(sig) };
    if (APPLY) await supabase.from('observations').update({ raw }).eq('id', o.id);
    o.raw = raw;
    classified++;
    console.log(`  ✓ classified ${sig.padEnd(14)} ${o.entity_id} "${body.slice(0, 50)}"`);
  }
  console.log(`Classified ${classified} previously-unlabelled repl${classified === 1 ? 'y' : 'ies'}.`);

  // 2. Newest reply per entity → the reply_signal claim (the chip). Newest wins.
  const newest = new Map();
  const optOutEntities = new Set();
  for (const o of replies) {
    const sig = o.raw?.reply_signal ?? o.raw?.provider_signal ?? null;
    if (!sig) continue;
    if (OPTOUT.has(sig)) optOutEntities.add(o.entity_id);
    const prev = newest.get(o.entity_id);
    if (!prev || o.observed_at > prev.at) newest.set(o.entity_id, { sig, at: o.observed_at });
  }
  const nowIso = new Date().toISOString();
  let claims = 0;
  for (const [eid, { sig, at }] of newest) {
    if (APPLY) {
      await supabase.from('claims').upsert([{
        workspace_id: WS, entity_id: eid, property: 'reply_signal', value: sig,
        distribution: null, confidence: 0.9, epistemic_class: 'inferred', freshness: 'fresh',
        valid_from: at, invalid_at: null, supporting_observation_ids: [], observation_count: 0,
        last_observed_at: at, computed_at: nowIso,
      }], { onConflict: 'workspace_id,entity_id,property' });
    }
    claims++;
  }
  console.log(`Staked ${claims} reply_signal claim(s) (the Reply chip).`);

  // 3. Opt-outs → suppress the address, and disqualify a COLD prospect (never an
  //    active deal or a won account — same guard as the live path: nothing at
  //    meeting_booked or above).
  let suppressed = 0, disq = 0;
  for (const eid of optOutEntities) {
    const { data: c } = await supabase.from('contacts').select('email').eq('id', eid).maybeSingle();
    if (c?.email && APPLY) { await addSuppression(supabase, WS, c.email, 'unsubscribe reply (backfill)').catch(() => {}); }
    if (c?.email) suppressed++;

    const { data: sc } = await supabase.from('claims').select('value')
      .eq('workspace_id', WS).eq('entity_id', eid).eq('property', 'pipeline_stage').is('invalid_at', null).maybeSingle();
    const cur = typeof sc?.value === 'string' ? sc.value : 'identified';
    // stageRank normalizes, so a row still holding a pre-migration stage ('aware',
    // 'evaluating', 'proposal', 'client') ranks where it belongs instead of falling
    // to 0 and getting disqualified out from under an active deal.
    if (stageRank(cur) < STAGE_RANK.meeting_booked) {
      if (APPLY) {
        await supabase.from('contacts').update({ pipeline_stage: 'disqualified' }).eq('id', eid).then(() => {}, () => {});
        await supabase.from('observations').insert({
          workspace_id: WS, entity_id: eid, kind: 'state', property: 'pipeline_stage',
          value: 'disqualified', source: 'system', method: 'backfill', observed_at: nowIso,
        }).then(() => {}, () => {});
      }
      disq++;
      console.log(`  ⨯ disqualify ${eid} (was ${cur})`);
    }
  }
  console.log(`Suppressed ${suppressed} opt-out address(es); disqualified ${disq} cold prospect(s).`);

  // 4. Re-score intent for every touched entity so auto-replies/opt-outs stop
  //    inflating and positive floors apply.
  const ids = [...newest.keys()];
  const persons = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs } = await supabase.from('contacts').select('id, email, domain').in('id', ids.slice(i, i + 200));
    for (const c of (cs || [])) persons.push({ entity_id: c.id, domain: (c.domain || (c.email || '').split('@')[1] || '').toLowerCase() || null });
  }
  const missing = ids.filter(id => !persons.some(p => p.entity_id === id));
  for (const id of missing) persons.push({ entity_id: id, domain: null });
  if (APPLY) {
    const r = await runIntentScoring(supabase, WS, { persons, write: true });
    console.log(`Re-scored intent for ${persons.length} entities — staked ${r.staked}.`);
  } else {
    console.log(`Would re-score intent for ${persons.length} entities.`);
  }

  console.log(`\nDone.${APPLY ? '' : ' (dry run — re-run with --apply to write)'}\n`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
