#!/usr/bin/env node
// One-off / on-demand backfill of Instantly email bodies onto email_sent rows.
//
//   node apps/worker/src/scripts/backfillInstantlyEmailBodies.mjs "Fernpoint" --dry
//   node apps/worker/src/scripts/backfillInstantlyEmailBodies.mjs "Fernpoint"
//
// --dry  : fetch + match + print samples, write NOTHING (safe, read-only).
// no flag: perform the enrichment writes.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY (from nous.env).

import { getSupabaseClient } from '@nous/core';
import { decrypt } from '../utils/encryption.mjs';
import { enrichInstantlyEmailBodies, backfillReplierSentEmails } from '../services/instantlyEmails.mjs';

const DAY = 86_400_000;
const wsName = process.argv[2];
const dry = process.argv.includes('--dry');
if (!wsName) { console.error('usage: backfillInstantlyEmailBodies "<workspace name>" [--dry]'); process.exit(1); }

const supabase = getSupabaseClient();

const { data: ws } = await supabase.from('workspaces').select('id, name').eq('name', wsName).single();
if (!ws) { console.error(`workspace not found: ${wsName}`); process.exit(1); }
console.log(`workspace: ${ws.name} (${ws.id})  mode: ${dry ? 'DRY (no writes)' : 'WRITE'}`);

const { data: conns } = await supabase
  .from('workflow_provider_connections')
  .select('encrypted_credentials, workflow_providers!inner(name)')
  .eq('workspace_id', ws.id).eq('is_verified', true);
const conn = (conns || []).find(c => c.workflow_providers?.name === 'instantly');
if (!conn) { console.error('no verified instantly connection'); process.exit(1); }
const apiKey = conn.encrypted_credentials?.api_key ? decrypt(conn.encrypted_credentials.api_key) : null;
if (!apiKey) { console.error('could not decrypt instantly api key'); process.exit(1); }

const { data: obs } = await supabase.from('observations')
  .select('raw')
  .eq('workspace_id', ws.id).eq('kind', 'event').eq('source', 'instantly')
  .not('raw->>campaign_id', 'is', null)
  .gte('observed_at', new Date(Date.now() - 180 * DAY).toISOString())
  .limit(5000);
const campaignIds = [...new Set((obs || []).map(o => o.raw?.campaign_id).filter(Boolean))];
console.log(`campaigns: ${campaignIds.length}`);

let shown = 0;
const res = await enrichInstantlyEmailBodies(supabase, {
  workspaceId: ws.id, apiKey, campaignIds, dryRun: dry,
  onMatch: ({ obsId, lead, subject, deltaMin, preview }) => {
    if (shown++ < 25) {
      console.log(`\n── MATCH obs=${obsId}  →  ${lead}  (Δ${deltaMin}m)`);
      console.log(`   subject: ${subject}`);
      console.log(`   body:    ${preview}${preview.length >= 240 ? '…' : ''}`);
    }
  },
});
console.log(`\n${dry ? 'DRY ' : ''}ENRICH SUMMARY:`, res);

// Replier-driven: for everyone who replied, pull + save the exact sent thread.
console.log('\n--- replier sent-thread backfill ---');
const rep = await backfillReplierSentEmails(supabase, { workspaceId: ws.id, apiKey, dryRun: dry });
console.log(`${dry ? 'DRY ' : ''}REPLIER SUMMARY:`, rep);

if (dry) console.log('\nNo writes performed. Re-run without --dry to apply.');
process.exit(0);
