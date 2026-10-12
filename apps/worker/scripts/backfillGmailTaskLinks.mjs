// Stamp source_url on the Gmail tasks written before gmailThreadUrl existed (GET-424).
//
// The thread id is already in the claim's own property — action_item.gmail_<threadId>_<n> — so
// this costs nothing: no model, no Gmail call, just the link the row should have carried. Rows
// keyed by a subject hash (subj-…) point at nothing and are left alone.
//
//   node apps/worker/scripts/backfillGmailTaskLinks.mjs --ws <id> [--apply]
import { getSupabaseClient } from '@nous/core';

const WS = process.argv[process.argv.indexOf('--ws') + 1];
const APPLY = process.argv.includes('--apply');
if (!WS || WS.startsWith('--')) { console.error('usage: --ws <workspace> [--apply]'); process.exit(2); }
const sb = getSupabaseClient();

const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('claims').select('id, property, value').eq('workspace_id', WS)
    .gte('property', 'action_item.').lt('property', 'action_item/').is('invalid_at', null)
    .order('property').range(from, from + 999);
  if (error) { console.error('read failed:', error.message); process.exit(1); }
  rows.push(...data); if (data.length < 1000) break;
}

// The half-open range above is the whole action_item space and the Gmail ones are picked out
// here, not narrowed in the query: a tighter upper bound would have to be a punctuation
// character, and under this database's collation punctuation sorts BEFORE digits, so the range
// would match nothing and the script would cheerfully report zero rows to fix.
const isGmail = (property) => property.startsWith('action_item.gmail_');
const threadIdOf = (property) => property.slice('action_item.gmail_'.length).replace(/_\d+$/, '');
const gmail = rows.filter(t => isGmail(t.property));
const todo = gmail.filter(t => !t.value?.source_url && !threadIdOf(t.property).startsWith('subj-'));
const unlinkable = gmail.filter(t => !t.value?.source_url && threadIdOf(t.property).startsWith('subj-'));
console.log(`gmail tasks ${gmail.length} of ${rows.length} action items — ${gmail.length - todo.length - unlinkable.length} already linked · ${todo.length} to link · ${unlinkable.length} unlinkable (subject-grouped)`);
for (const t of todo.slice(0, 5)) console.log(`  ${String(t.value?.title).slice(0, 70)}\n      → https://mail.google.com/mail/u/0/#all/${threadIdOf(t.property)}`);
if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

let done = 0;
for (const t of todo) {
  const url = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadIdOf(t.property))}`;
  const { error } = await sb.from('claims').update({ value: { ...t.value, source_url: url } }).eq('id', t.id);
  if (error) { console.error(`failed on ${t.id}:`, error.message); process.exit(1); }
  done++;
}
console.log(`\nlinked ${done}`);
