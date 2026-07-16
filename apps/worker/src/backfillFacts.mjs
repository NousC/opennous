// One-off backfill: purge low-value "facts" that the OLD signal extractor saved
// before the durable/decision-relevant/specific quality bar landed. It judges
// each signal_extraction `note.*` claim against the SAME standard the live
// extractor now enforces, and soft-deletes (invalid_at) the ones that fail.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to invalidate the PURGE rows.
// Contact-scoped; pass a contact id as the first arg (or set CONTACT_ID). For the
// whole workspace use sweepWorkspace.mjs (which calls backfillContact below).
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/backfillFacts.mjs [contactId] [--apply]

import './bootEnv.mjs';
import Anthropic from 'useleak';
import { getSupabaseClient, listNotes, deleteNote } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000'; // pass a contact id as the first arg, or set CONTACT_ID

// Mirror of the live extractor's "NEVER record" rules — judge an EXISTING fact
// by the same bar so the backfill and the writer agree on what a fact is.
async function judge(content) {
  const msg = await anthropic.messages.create({
    feature: 'facts-backfill-judge',
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: `You are cleaning a CRM's atomic-fact store. Judge ONE existing fact about a person.

FACT: "${content}"

PURGE it ONLY if it clearly is one of:
- Meeting logistics: scheduling, availability ("available next week"), a reschedule, "has a call on X", an invite sent or pending.
- Generic sentiment or pleasantry with no specifics ("interested in learning more", "excited to chat", "loves the product").
- Non-durable: true today but meaningless in a few weeks.

KEEP it if it carries durable, decision-relevant signal — this INCLUDES:
- What tools or vendors they use, don't use, or are evaluating (e.g. "uses Clay", "not using Clay", "started evaluating Clay") — competitive/stack intel.
- Budget, authority, team/headcount, goals, pain points, or a real buying/project timeline.
- A genuine preference or opinion with substance ("prefers reliable workflows over AI agents").
- A concrete fact about their company or business.

When in doubt, KEEP. Reply with ONLY one word: KEEP or PURGE` }],
  });
  return (msg.content[0]?.text || '').toUpperCase().includes('PURGE') ? 'PURGE' : 'KEEP';
}

/** Backfill one contact. Returns { total, purged }. Logs per-fact verdicts. */
export async function backfillContact({ supabase, workspaceId, contactId, apply }) {
  const notes = await listNotes(supabase, workspaceId, { entityId: contactId, limit: 200 });
  const facts = notes.filter(n => n.source === 'signal_extraction' && !n.metadata?.doc_type);

  let purged = 0;
  for (const f of facts) {
    const verdict = await judge(f.content);
    console.log(`    ${verdict === 'PURGE' ? '✗ PURGE' : '✓ keep '}  [${f.category}]  ${f.content}`);
    if (verdict === 'PURGE') {
      purged++;
      if (apply) await deleteNote(supabase, workspaceId, f.id);
    }
  }
  return { total: facts.length, purged };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const contactId = args.find(a => !a.startsWith('--')) || DEFAULT_CONTACT;

  const supabase = getSupabaseClient();
  const { data: contact } = await supabase
    .from('contacts').select('workspace_id, first_name, last_name').eq('id', contactId).maybeSingle();
  if (!contact) { console.error(`contact ${contactId} not found`); process.exit(1); }
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contactId;

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — backfill ${name}\n`);
  const { total, purged } = await backfillContact({ supabase, workspaceId: contact.workspace_id, contactId, apply });
  console.log(`\n${apply ? `Invalidated ${purged}` : `Would invalidate ${purged}`} of ${total} facts.`);
  if (!apply && purged) console.log('Re-run with --apply to commit.\n');
}

// Run as a CLI only when invoked directly (not when imported by sweepWorkspace).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
