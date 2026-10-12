#!/usr/bin/env node
// Repair the Gmail rows filed before GET-244 / GET-245. Idempotent; plans without --apply.
//
// What it fixes, in order:
//   1. Rows filed on a TEAMMATE's own record. Direction used to be relative to the mailbox, so a
//      teammate's email to a prospect, read from a cc'd founder's inbox, landed on the teammate.
//      Team mail is no longer filed; these rows are removed.
//   2. Rows from a connected Composio mailbox get their RFC headers: Message-ID, participants
//      (from / to / cc), mailbox holders, bulk and reply flags — what the privacy rule reads.
//   3. The same email filed once per mailbox collapses to one row: the earliest is kept, every
//      mailbox that held a copy is recorded on it, the rest are removed, and its external id moves
//      to the Message-ID key so a future copy merges instead of duplicating.
//   4. Reply labels. A label on an email that is not a reply to our outreach (a newsletter, a
//      message that answers nothing we sent) is cleared; a real reply with no label is classified
//      (model door, extraction tier). Each touched person's reply_signal claim is recomputed from
//      what remains. Suppression happens only for a real reply classified as an opt-out.
//
// Older rows from the retired native Gmail sync have no connection to read headers from; they keep
// their stored from/to and are only touched by step 1.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/repairGmailEmailIdentity.mjs          # plan only
//   WS_ID=<uuid> node apps/worker/scripts/repairGmailEmailIdentity.mjs --apply

import { getSupabaseClient, getInternalEntityIds, getInternalIdentities, addSuppression, replySignalToSentiment } from '@nous/core';
import { fetchMessageHeaders } from '../src/webhooks/handlers/gmailBody.mjs';
import { emailExternalId, isBulkEmail, isReply, participantsOf } from '../src/utils/emailIdentity.mjs';
import { classifyReplySignal } from '../src/signals/replySentiment.mjs';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID required'); process.exit(1); }
const sb = getSupabaseClient();
const log = (...a) => console.log(...a);
const SUPPRESSING = new Set(['unsubscribe', 'do_not_contact']);

async function all(query, page = 1000) {
  const out = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await query().range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function main() {
  log(`\n=== Gmail identity repair — ws ${WS} — ${APPLY ? 'APPLY' : 'PLAN'} ===`);
  const internalIds = new Set(await getInternalEntityIds(sb, WS));
  const internalEmails = new Set((await getInternalIdentities(sb, WS)).filter(i => i.kind === 'email').map(i => String(i.value).toLowerCase()));

  const { data: conns } = await sb.from('workflow_provider_connections')
    .select('id, workspace_id, owner_user_id, account_email, composio_connection_id, workflow_providers!inner(name)')
    .eq('workspace_id', WS).eq('managed_by', 'composio').eq('is_verified', true)
    .not('composio_connection_id', 'is', null).eq('workflow_providers.name', 'gmail_oauth');
  const connByOwner = new Map((conns || []).map(c => [c.owner_user_id, c]));
  for (const c of conns || []) if (c.account_email) internalEmails.add(c.account_email.toLowerCase());

  const rows = await all(() => sb.from('observations')
    .select('id, entity_id, property, value, raw, owner_user_id, external_id, observed_at, ingested_at')
    .eq('workspace_id', WS).eq('source', 'gmail').like('property', 'interaction.email_%')
    .order('ingested_at', { ascending: true }));
  log(`${rows.length} Gmail email rows; ${internalIds.size} internal people; ${connByOwner.size} connected mailboxes.`);

  const deletes = new Map();          // id → reason
  const updates = new Map();          // id → { raw, external_id? }
  const touchedEntities = new Set();

  // 1. Rows on a teammate's own record.
  for (const r of rows) {
    if (!internalIds.has(r.entity_id)) continue;
    deletes.set(r.id, 'filed on a teammate');
    if (r.raw?.reply_signal) touchedEntities.add(r.entity_id);   // its chip must go too
  }
  log(`1. teammate-record rows to remove: ${deletes.size}`);

  // 2. Headers for Composio-era rows.
  const enriched = [];
  let fetched = 0, noHeaders = 0;
  for (const r of rows) {
    if (deletes.has(r.id)) continue;
    const raw = r.raw || {};
    const conn = connByOwner.get(r.owner_user_id);
    if (!conn || !raw.message_id) continue;
    let h = null;
    if (raw.rfc_message_id) h = { rfcMessageId: raw.rfc_message_id, ...(raw.participants || {}), cc: raw.cc || [], inReplyTo: raw.in_reply_to, references: null, fromCache: true };
    else { h = await fetchMessageHeaders(sb, WS, conn, raw.message_id); fetched++; }
    if (!h) { noHeaders++; continue; }
    const participants = participantsOf(h, { from: raw.from, to: raw.to, cc: raw.cc });
    const sentByTeam = internalEmails.has(String(participants.from || '').toLowerCase());
    const bulk = h.fromCache ? Boolean(raw.bulk) : isBulkEmail(h, participants.from);
    enriched.push({ r, rfc: h.rfcMessageId || null, participants, bulk, isReplyMsg: h.fromCache ? raw.reply_eligible !== false : isReply(h), sentByTeam });
  }
  log(`2. headers fetched: ${fetched}, unavailable: ${noHeaders}, rows with identity: ${enriched.length}`);

  // 3. Collapse copies of one email on one person.
  const groups = new Map();
  for (const e of enriched) {
    const key = e.rfc ? `${e.r.entity_id}|${e.rfc}` : `${e.r.entity_id}|id:${e.r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let merged = 0;
  const priorOutboundCache = new Map();
  const hasPriorOutbound = async (entityId, before) => {
    const k = `${entityId}|${before}`;
    if (priorOutboundCache.has(k)) return priorOutboundCache.get(k);
    const { data } = await sb.from('observations').select('id').eq('workspace_id', WS).eq('entity_id', entityId)
      .in('property', ['interaction.email_sent', 'interaction.linkedin_message_sent', 'interaction.linkedin_connection_sent', 'interaction.outbound_sent'])
      .lt('observed_at', before).limit(1);
    const v = Boolean(data?.length);
    priorOutboundCache.set(k, v);
    return v;
  };
  for (const [, members] of groups) {
    const keep = members[0];
    const owners = new Set(); const copies = [];
    for (const m of members) {
      const raw = m.r.raw || {};
      for (const o of [m.r.owner_user_id, ...(raw.mailbox_owner_ids || [])]) if (o) owners.add(o);
      for (const c of [{ owner_user_id: m.r.owner_user_id, message_id: String(raw.message_id) }, ...(raw.gmail_copies || [])]) {
        if (c?.message_id && !copies.some(x => x.message_id === c.message_id)) copies.push(c);
      }
      if (m !== keep) { deletes.set(m.r.id, `copy of ${keep.r.id}`); merged++; }
    }
    const raw = keep.r.raw || {};
    const inbound = !keep.sentByTeam && keep.r.property === 'interaction.email_received';
    const replyEligible = inbound && !keep.bulk && keep.isReplyMsg && await hasPriorOutbound(keep.r.entity_id, keep.r.observed_at);
    const nextRaw = {
      ...raw,
      rfc_message_id: keep.rfc,
      from: keep.participants.from, to: keep.participants.to, cc: keep.participants.cc,
      participants: keep.participants,
      mailbox_owner_ids: [...owners],
      gmail_copies: copies,
      bulk: keep.bulk,
      reply_eligible: replyEligible,
    };
    if (!replyEligible && (raw.reply_signal || raw.sentiment)) {
      delete nextRaw.reply_signal; delete nextRaw.sentiment;
      touchedEntities.add(keep.r.entity_id);
    }
    const newExternalId = keep.rfc ? emailExternalId({ rfcMessageId: keep.rfc, gmailMessageId: raw.message_id, contactId: keep.r.entity_id }) : null;
    updates.set(keep.r.id, { raw: nextRaw, external_id: newExternalId && newExternalId !== keep.r.external_id ? newExternalId : undefined, row: keep.r });
  }
  log(`3. duplicate copies to remove: ${merged}; rows to update: ${updates.size}`);

  const labelsCleared = [...updates.values()].filter(u => (u.row.raw?.reply_signal) && !u.raw.reply_signal).length;
  const toLabel = [...updates.values()].filter(u => u.raw.reply_eligible && !u.raw.reply_signal);
  log(`4. reply labels to clear: ${labelsCleared}; real replies to classify: ${toLabel.length}`);
  for (const [id, why] of deletes) {
    const r = rows.find(x => x.id === id);
    log(`   - remove ${r.property.replace('interaction.', '')} ${r.observed_at.slice(0, 16)} ${String(r.raw?.subject || '').slice(0, 50)} (${why})`);
  }
  for (const u of toLabel) log(`   ? classify ${u.row.observed_at.slice(0, 16)} ${String(u.raw.subject || '').slice(0, 60)}`);

  if (!APPLY) { log('\nPLAN only — rerun with --apply to write.'); return; }

  // ── Apply ──
  let deleted = 0, updated = 0, rekeyed = 0, labelled = 0, suppressed = 0;
  for (const [id] of deletes) {
    const { error } = await sb.from('observations').delete().eq('id', id).eq('workspace_id', WS);
    if (!error) deleted++; else log('  delete failed', id, error.message);
  }
  for (const [id, u] of updates) {
    if (u.raw.reply_eligible && !u.raw.reply_signal) {
      const body = u.row.value?.summary || u.row.value?.description || '';
      const sig = await classifyReplySignal(body, sb, WS);
      if (sig) { u.raw.reply_signal = sig; u.raw.sentiment = replySignalToSentiment(sig); labelled++; touchedEntities.add(u.row.entity_id); }
    }
    const patch = { raw: u.raw };
    const { error } = await sb.from('observations').update(patch).eq('id', id).eq('workspace_id', WS);
    if (error) { log('  update failed', id, error.message); continue; }
    updated++;
    if (u.external_id) {
      const { error: kErr } = await sb.from('observations').update({ external_id: u.external_id }).eq('id', id).eq('workspace_id', WS);
      if (!kErr) rekeyed++; else log('  rekey skipped', id, kErr.message);
    }
    if (u.raw.reply_eligible && SUPPRESSING.has(u.raw.reply_signal)) {
      const { data: c } = await sb.from('contacts').select('email').eq('id', u.row.entity_id).maybeSingle();
      if (c?.email) { await addSuppression(sb, WS, c.email, `${u.raw.reply_signal} reply via gmail (repair)`).catch(() => {}); suppressed++; }
    }
  }

  // reply_signal claim per touched person: the newest remaining label from any source, or none.
  let claimsSet = 0, claimsCleared = 0;
  for (const entityId of touchedEntities) {
    const { data: latest } = await sb.from('observations').select('raw, observed_at')
      .eq('workspace_id', WS).eq('entity_id', entityId).not('raw->>reply_signal', 'is', null)
      .order('observed_at', { ascending: false }).limit(1);
    const sig = latest?.[0]?.raw?.reply_signal;
    if (sig) {
      const at = latest[0].observed_at;
      await sb.from('claims').upsert([{
        workspace_id: WS, entity_id: entityId, property: 'reply_signal', value: sig,
        distribution: null, confidence: 0.9, epistemic_class: 'inferred', freshness: 'fresh',
        valid_from: at, invalid_at: null, supporting_observation_ids: [], observation_count: 0,
        last_observed_at: at, computed_at: new Date().toISOString(),
      }], { onConflict: 'workspace_id,entity_id,property' });
      claimsSet++;
    } else {
      await sb.from('claims').update({ invalid_at: new Date().toISOString() })
        .eq('workspace_id', WS).eq('entity_id', entityId).eq('property', 'reply_signal').is('invalid_at', null);
      claimsCleared++;
    }
  }
  log(`\nAPPLIED: removed ${deleted}, updated ${updated}, re-keyed ${rekeyed}, labelled ${labelled}, suppressed ${suppressed}, reply_signal claims set ${claimsSet} / cleared ${claimsCleared}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
