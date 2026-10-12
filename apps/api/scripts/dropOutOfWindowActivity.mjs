#!/usr/bin/env node
// Remove conversations imported from outside the window we asked for (GET-291).
//
// When a scope resolution was rate-limited, the import fell back to "everything" — no account
// filter and no date floor — and pulled a portal's whole history: missed calls from 2020 for
// companies nobody sells to. The fallback is gone; this removes what it left.
//
// Deletes `interaction.*` observations from `source` older than SINCE. Nothing else is touched:
// records, deals, claims and in-window conversations stay exactly as they are.
//
//   WS_ID=<uuid> SINCE=2025-01-01 node apps/api/scripts/dropOutOfWindowActivity.mjs
//   WS_ID=<uuid> SINCE=2025-01-01 node apps/api/scripts/dropOutOfWindowActivity.mjs --apply

import { getSupabaseClient } from '@nous/core';

const WS = process.env.WS_ID;
const SINCE = process.env.SINCE;
const SOURCE = process.env.SOURCE || 'hubspot';
const APPLY = process.argv.includes('--apply');
if (!WS || !SINCE) { console.error('WS_ID and SINCE (YYYY-MM-DD) are required'); process.exit(1); }
const floor = new Date(SINCE).toISOString();

const supabase = getSupabaseClient();

const { count: before } = await supabase.from('observations')
  .select('id', { count: 'exact', head: true })
  .eq('workspace_id', WS).eq('source', SOURCE).like('property', 'interaction.%').lt('observed_at', floor);

console.log(JSON.stringify({ workspace: WS, source: SOURCE, older_than: floor, rows: before ?? 0, applied: APPLY }, null, 2));
if (!APPLY) { console.log('Plan only. Re-run with --apply to delete.'); process.exit(0); }

let deleted = 0;
for (;;) {
  const { data: batch } = await supabase.from('observations')
    .select('id')
    .eq('workspace_id', WS).eq('source', SOURCE).like('property', 'interaction.%').lt('observed_at', floor)
    .limit(500);
  const ids = (batch ?? []).map(r => r.id);
  if (!ids.length) break;
  const { error } = await supabase.from('observations').delete().in('id', ids);
  if (error) { console.error('delete failed:', error.message); break; }
  deleted += ids.length;
  if (deleted % 5000 === 0) console.log(`deleted ${deleted}…`);
}
console.log(JSON.stringify({ deleted }, null, 2));
