#!/usr/bin/env node
// Remove the documents a CRM sync wrote from call, meeting and note bodies (GET-282).
//
// A CRM's meeting notes are a copy of what the note-taker already wrote, and the note-taker is the
// source we read meeting notes from. Keeping both fills the Meetings tab with the same conversation
// twice and makes extraction pay for it twice. The sync no longer writes them; this removes the ones
// already filed. The conversation itself is untouched — it stays as an activity with its full body
// on the row (raw.text), which is what every reader and the extractor use.
//
// Transcripts are NOT removed: a real transcript is content in its own right, not a second copy.
// A saved document lives as a `note.<uuid>` claim, so that is what this retires.
//
// USAGE (worker image, prod env):
//   WS_ID=<uuid> node apps/worker/scripts/dropCrmEngagementDocs.mjs            # counts only
//   WS_ID=<uuid> node apps/worker/scripts/dropCrmEngagementDocs.mjs --apply    # delete

import { getSupabaseClient } from '@nous/core';

const WS = process.env.WS_ID;
const APPLY = process.argv.includes('--apply');
if (!WS) { console.error('WS_ID is required'); process.exit(1); }

const supabase = getSupabaseClient();

// A saved document is a `note.<uuid>` claim; the CRM ones carry the engagement they came from.
// Transcripts are not in this set and are left alone.
const FROM_CRM = ['notes', 'calls', 'meetings'];

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from('claims')
    .select('id, value')
    .eq('workspace_id', WS)
    .like('property', 'note.%')
    .is('invalid_at', null)
    .order('id')
    .range(from, from + 999);
  if (error) throw error;
  for (const r of data ?? []) {
    const meta = r.value?.metadata ?? {};
    if (FROM_CRM.includes(String(meta.hubspot_object ?? ''))) rows.push({ id: r.id, object: meta.hubspot_object, title: r.value?.content?.slice(0, 60) ?? null });
  }
  if (!data || data.length < 1000) break;
}

const byObject = {};
for (const r of rows) byObject[r.object] = (byObject[r.object] ?? 0) + 1;
console.log(JSON.stringify({ workspace: WS, notes_from_crm: rows.length, by_object: byObject, sample: rows.slice(0, 3), applied: APPLY }, null, 2));
if (!APPLY) { console.log('Plan only. Re-run with --apply to retire them.'); process.exit(0); }

// Retired, not erased: invalid_at hides them everywhere and can be undone if this was wrong.
const at = new Date().toISOString();
let retired = 0;
for (let i = 0; i < rows.length; i += 200) {
  const ids = rows.slice(i, i + 200).map(r => r.id);
  const { error } = await supabase.from('claims').update({ invalid_at: at }).in('id', ids);
  if (error) { console.warn('retire failed', error.message); continue; }
  retired += ids.length;
}
console.log(JSON.stringify({ retired, invalid_at: at }, null, 2));
