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
//   docker compose exec -T worker node apps/worker/src/reextractMeetings.mjs [contactId] [--max N] [--apply] [--include-research]

import './bootEnv.mjs';
import { getSupabaseClient, listNotes } from '@nous/core';
import { extractActivitySignals } from './signals/index.mjs';

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000'; // pass a contact id as the first arg, or set CONTACT_ID

// Meeting source text is stored as note documents. Prefer the full transcript,
// then the AI meeting-notes summary — these are the CONTACT's own words.
const MEETING_SOURCE_TYPES = ['transcript', 'meeting_notes'];

// Research documents are the agent's OWN research about the person (their public
// LinkedIn posts, their company site, prior context) — not their words. They were
// historically excluded, which left real, durable intel (role, company, who they
// know, what they're building) trapped in the document blob, never scored, never
// read as claims. With --include-research they're mined too, under a research
// provenance (extractActivitySignals type 'research_brief') that tells the model
// this is second-hand so it frames the facts as such. Dry-run by default, like the
// rest of this tool — an operator reviews before --apply writes anything.
const RESEARCH_SOURCE_TYPES = ['meeting_brief', 'pre_meeting', 'research'];

/**
 * Re-extract one contact's richest source. Returns the array of result facts
 * ({content, category, action}) from that source, or [] if none. Meeting sources
 * are always considered; research/brief docs only when `includeResearch` is set.
 */
export async function reextractContact({ supabase, workspaceId, contactId, apply, maxFacts = 8, all = false, includeResearch = false }) {
  const notes = await listNotes(supabase, workspaceId, { entityId: contactId, limit: 200 });
  const pick = (types, extractionType) => notes
    .filter(n => types.includes(n.metadata?.doc_type) && (n.content || '').trim())
    .map(n => ({ doc: n, extractionType }));
  const sources = [
    ...pick(MEETING_SOURCE_TYPES, 'meeting_held'),
    ...(includeResearch ? pick(RESEARCH_SOURCE_TYPES, 'research_brief') : []),
  ].sort((a, b) => (b.doc.content?.length || 0) - (a.doc.content?.length || 0));
  if (!sources.length) return [];

  // Default: mine the single richest source that yields facts, to avoid cross-source
  // duplicates. With `all`, mine EVERY source — the dedup step (decideMerge) drops
  // facts already captured from an earlier source, so covering all of them is safe
  // and captures per-source intel the richest single doc would miss.
  const collected = [];
  for (const { doc, extractionType } of sources) {
    const results = await extractActivitySignals({
      supabase,
      activityId:  doc.id,
      contactId,
      workspaceId,
      type:        extractionType,
      source:      extractionType === 'research_brief' ? 'brief_reextract' : 'reextract',
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
  const includeResearch = args.includes('--include-research');
  const maxIdx = args.indexOf('--max');
  const maxFacts = maxIdx !== -1 ? Number(args[maxIdx + 1]) : 8;
  const contactId = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || DEFAULT_CONTACT;

  const supabase = getSupabaseClient();
  const { data: contact } = await supabase
    .from('contacts').select('workspace_id, first_name, last_name').eq('id', contactId).maybeSingle();
  if (!contact) { console.error(`contact ${contactId} not found`); process.exit(1); }
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contactId;

  const scope = all ? 'ALL sources' : 'richest source';
  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — re-extract ${name} (${scope}${includeResearch ? ' + research/briefs' : ''}, up to ${maxFacts} facts each)\n`);
  const results = await reextractContact({ supabase, workspaceId: contact.workspace_id, contactId, apply, maxFacts, all, includeResearch });
  if (!results.length) console.log('  (no eligible source, or nothing cleared the bar)');
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
