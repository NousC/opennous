#!/usr/bin/env node
// Replies Instantly received while its webhook was gone (GET-1025). Each one is filed exactly as the
// webhook would have filed it, dated when it arrived, with Instantly's own interest status as the
// disposition when someone set one. A reply already on file is skipped by the handler's dedup.
//
//   node apps/worker/src/scripts/backfillInstantlyReplies.mjs --workspace=UUID [--since=2026-09-05] [--positive] [--write]
//
// --positive : only replies Instantly marks interested, meeting booked, meeting completed or won.
// Dry run by default: prints what it would file, writes nothing. Without --positive a reply with
// no status is classified by us, as a plain webhook reply is.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY (from nous.env).
import { getSupabaseClient } from '@nous/core';
import { fetchInstantlyEmails, getInstantlyApiKey } from '../services/instantlyEmails.mjs';
import { reprocessInstantly, instantlyInterestEvent, isPositiveInterest } from '../webhooks/handlers/instantly.mjs';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WS = arg('workspace');
const SINCE = arg('since') || new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const WRITE = argv.includes('--write');
const POSITIVE = argv.includes('--positive');
if (!WS) { console.error('usage: backfillInstantlyReplies --workspace=UUID [--since=YYYY-MM-DD] [--positive] [--write]'); process.exit(1); }

const supabase = getSupabaseClient();
const apiKey = await getInstantlyApiKey(supabase, WS);
if (!apiKey) { console.error('no verified Instantly connection on that workspace'); process.exit(1); }

const replies = (await fetchInstantlyEmails(apiKey, { emailType: 'received', max: 5000 }))
  .filter(e => e.ts && e.ts >= SINCE && e.lead && !e.isOutbound)
  .filter(e => !POSITIVE || isPositiveInterest(e.interest));
console.log(`[INSTANTLY_REPLIES] ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'} since ${SINCE}${POSITIVE ? ' marked positive' : ''} · ${WRITE ? 'WRITE' : 'dry run'}`);

const tally = {};
let filed = 0;
for (const e of replies.sort((a, b) => a.ts.localeCompare(b.ts))) {
  const event = instantlyInterestEvent(e.interest);
  tally[event] = (tally[event] ?? 0) + 1;
  console.log(`  ${e.ts.slice(0, 10)} ${event.padEnd(20)} ${e.lead} · ${(e.subject || '').slice(0, 60)}`);
  if (!WRITE) continue;
  const out = await reprocessInstantly(supabase, WS, {
    event_type: event, lead_email: e.lead, campaign_id: e.campaignId, message_id: e.messageId,
    reply_subject: e.subject, reply_text: e.text, timestamp: e.ts,
  }, { backfill: true }).catch(err => ({ skipped: err.message }));
  if (out?.contactId) filed++;
  else console.log(`    skipped: ${out?.skipped ?? 'unknown'}`);
}
console.log(`[INSTANTLY_REPLIES] ${JSON.stringify(tally)}${WRITE ? ` · ${filed} filed` : ''}`);
