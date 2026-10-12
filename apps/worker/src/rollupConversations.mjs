// Roll a contact's WHOLE LinkedIn conversation up into durable claims.
//
// The live extractor mines one message at a time, so intel that only exists across
// the thread — a shared connection named once, a role mentioned in passing, "the
// thing you talked about the other day" — is judged as an isolated pleasantry and
// dropped. This re-reads the full two-sided conversation as one transcript and
// extracts the facts that only make sense in aggregate (extractConversationThread).
//
// ADDITIVE and safe to re-run: persistFacts dedups against what the per-message
// pass already saved, so overlap collapses to SKIP and only new facts are written.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to save. Contact-scoped, or sweep a whole
// workspace with --workspace <id>.
//
// Options:
//   <contactId>          roll up one contact (or set CONTACT_ID)
//   --workspace <uuid>   sweep every contact in a workspace that has a LinkedIn thread
//   --limit <n>          only the first N contacts of a sweep (test on a few first)
//   --min <n>            minimum messages before a thread is worth rolling up (default 4)
//   --max <n>            fact ceiling per contact (default: the extractor's own)
//   --apply              commit (otherwise dry-run)
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/rollupConversations.mjs <contactId>
//   docker compose exec -T worker node apps/worker/src/rollupConversations.mjs --workspace <id> --limit 5
//   docker compose exec -T worker node apps/worker/src/rollupConversations.mjs --workspace <id> --apply

import './bootEnv.mjs';
import { getSupabaseClient } from '@nous/core';
import { extractConversationThread } from './signals/index.mjs';

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

async function rollupOne(supabase, workspaceId, contactId, { apply, minMessages, maxFacts }) {
  const results = await extractConversationThread({
    supabase, workspaceId, contactId,
    source: 'conversation_rollup',
    minMessages,
    maxFactsOverride: maxFacts,
    dryRun: !apply,
  });
  for (const r of results) {
    const tag = r.action === 'SKIP' ? '· already have' : (apply ? '+ saved' : '+ new  ');
    console.log(`    ${tag}  [${r.category}]  ${r.content}`);
  }
  return results.filter(r => r.action !== 'SKIP').length;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const workspaceId = arg('--workspace', null);
  const limit = Number(arg('--limit', 0)) || 0;
  const minMessages = Number(arg('--min', 0)) || undefined;   // undefined → extractor default
  const maxFacts = Number(arg('--max', 0)) || undefined;
  const contactArg = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a));

  const supabase = getSupabaseClient();

  // Single-contact mode.
  if (!workspaceId) {
    const contactId = contactArg || DEFAULT_CONTACT;
    const { data: contact } = await supabase
      .from('contacts').select('workspace_id, first_name, last_name').eq('id', contactId).maybeSingle();
    if (!contact) { console.error(`contact ${contactId} not found`); process.exit(1); }
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contactId;
    console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — roll up LinkedIn thread for ${name}\n`);
    const added = await rollupOne(supabase, contact.workspace_id, contactId, { apply, minMessages, maxFacts });
    console.log(`\n${apply ? 'saved' : 'would add'} ${added} fact(s)${added ? '' : ' (thin thread, or nothing cleared the bar)'}\n`);
    return;
  }

  // Workspace sweep — only contacts that actually hold a LinkedIn conversation.
  // The extractor's own message-count floor drops threads too thin to be worth it.
  const { data: rows, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, channels')
    .eq('workspace_id', workspaceId)
    .not('channels->linkedin', 'is', null);
  if (error) { console.error('failed to list contacts:', error.message); process.exit(1); }

  let targets = (rows || []).filter(c => {
    const li = c.channels?.linkedin || {};
    return (li.messages_received || 0) + (li.messages_sent || 0) > 0;
  });
  if (limit) targets = targets.slice(0, limit);

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — rolling up ${targets.length} LinkedIn conversation(s) in ${workspaceId}\n`);
  let totalAdded = 0, touched = 0;
  let n = 0;
  for (const c of targets) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.id;
    const added = await rollupOne(supabase, workspaceId, c.id, { apply, minMessages, maxFacts });
    if (added) { console.log(`[${++n}/${targets.length}] ${name} — ${apply ? 'saved' : 'would add'} ${added}`); touched++; }
    else n++;
    totalAdded += added;
  }

  const verb = apply ? 'added' : 'would add';
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`${apply ? 'DONE' : 'DRY-RUN COMPLETE'} — ${targets.length} conversations, ${touched} with new intel, ${verb} ${totalAdded} fact(s)`);
  if (!apply) console.log(`\nRe-run with --apply to commit.\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
