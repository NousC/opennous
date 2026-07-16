// Re-mine a contact's MEETING TRANSCRIPTS with the CURRENT (improved) extractor.
// The live extractor only runs once, at ingest, and older meetings were mined by
// the old prompt (2-fact cap, logistics-prone) usually over the short summary —
// so richer transcript intel was never captured. This re-runs the SAME extractor
// over the saved transcript with a higher fact cap, dedupes, and saves what's new.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to save the new facts. Contact-scoped;
// pass a contact id as the first arg (or set CONTACT_ID). For the whole workspace
// use sweepWorkspace.mjs.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/reextractMeetings.mjs [contactId] [--max N] [--apply]

import './bootEnv.mjs';
import { getSupabaseClient, listNotes } from '@nous/core';
import { extractActivitySignals } from './signals/index.mjs';

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000'; // pass a contact id as the first arg, or set CONTACT_ID

// Meeting source text is stored as note documents. Prefer the full transcript,
// then the AI meeting-notes summary. Briefs are the agent's OWN research about
// the person (not their words), so they're excluded.
const SOURCE_TYPES = ['transcript', 'meeting_notes'];

/**
 * Re-extract one contact's richest meeting source. Returns the array of result
 * facts ({content, category, action}) from that source, or [] if none.
 */
export async function reextractContact({ supabase, workspaceId, contactId, apply, maxFacts = 8, all = false }) {
  const notes = await listNotes(supabase, workspaceId, { entityId: contactId, limit: 200 });
  const sources = notes
    .filter(n => SOURCE_TYPES.includes(n.metadata?.doc_type) && (n.content || '').trim())
    .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0));
  if (!sources.length) return [];

  // Default: mine the single richest source that yields facts (transcript first),
  // to avoid cross-source duplicates. With `all`, mine EVERY meeting source — the
  // dedup step (decideMerge) drops facts already captured from an earlier source,
  // so covering all meetings is safe and captures per-meeting intel the richest
  // single transcript would miss.
  const collected = [];
  for (const doc of sources) {
    const results = await extractActivitySignals({
      supabase,
      activityId:  doc.id,
      contactId,
      workspaceId,
      type:        'meeting_held',
      source:      'reextract',
      summary:     doc.content,
      maxFactsOverride: maxFacts,
      dryRun:      !apply,
    });
    if (results?.length) {
      for (const r of results) {
        const tag = r.action === 'SKIP' ? '· already have' : (apply ? '+ saved' : '+ new  ');
        console.log(`    ${tag}  [${r.category}]  ${r.content}`);
      }
      collected.push(...results);
      if (!all) return collected;
    }
  }
  return collected;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const all = args.includes('--all');
  const maxIdx = args.indexOf('--max');
  const maxFacts = maxIdx !== -1 ? Number(args[maxIdx + 1]) : 8;
  const contactId = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || DEFAULT_CONTACT;

  const supabase = getSupabaseClient();
  const { data: contact } = await supabase
    .from('contacts').select('workspace_id, first_name, last_name').eq('id', contactId).maybeSingle();
  if (!contact) { console.error(`contact ${contactId} not found`); process.exit(1); }
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contactId;

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — re-extract ${name} (${all ? 'ALL meetings' : 'richest meeting'}, up to ${maxFacts} facts each)\n`);
  const results = await reextractContact({ supabase, workspaceId: contact.workspace_id, contactId, apply, maxFacts, all });
  if (!results.length) console.log('  (no meeting transcript, or nothing cleared the bar)');
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
