// One-off dedup sweep: collapse near-duplicate facts on a contact, keeping the
// single most complete/specific one and soft-deleting the thinner restatements.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to soft-delete the redundant ones. Only
// touches signal_extraction facts. Contact-scoped; pass a contact id as the first
// arg (or set CONTACT_ID). For the whole workspace use sweepWorkspace.mjs.
//
// Usage (worker container):
//   docker compose exec -T worker node apps/worker/src/dedupFacts.mjs [contactId] [--apply]

import './bootEnv.mjs';
import Anthropic from 'useleak';
import { getSupabaseClient, listNotes, deleteNote } from '@nous/core';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DEFAULT_CONTACT = process.env.CONTACT_ID || '00000000-0000-0000-0000-000000000000'; // pass a contact id as the first arg, or set CONTACT_ID

// Ask Haiku to group facts that restate the SAME underlying fact and pick the
// richest survivor. Facts are referenced by 1-based number to avoid UUID
// hallucination; we map back to real ids.
async function findDuplicateGroups(facts) {
  const numbered = facts.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
  const msg = await anthropic.messages.create({
    feature: 'facts-dedup-sweep',
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: `You are deduplicating a CRM's atomic facts about ONE person. Some facts restate the SAME underlying fact at different levels of detail or wording.

Group together facts that express the same underlying fact. For each group of 2 or more, KEEP the single most complete and specific fact and mark the OTHERS for removal. Facts about genuinely different things must stay separate — never merge distinct facts, and when unsure, keep them separate.

Facts:
${numbered}

Output ONLY valid JSON: [{"keep": <number>, "remove": [<numbers>], "why": "<short>"}]
Include a group ONLY if it has real duplicates (a non-empty "remove"). If there are no duplicates, return [].` }],
  });
  try {
    const text = msg.content[0]?.text ?? '[]';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    return s !== -1 && e !== -1 ? JSON.parse(text.slice(s, e + 1)) : [];
  } catch { return []; }
}

/** Dedup one contact's facts. Returns { total, removed }. Logs keep/remove. */
export async function dedupContact({ supabase, workspaceId, contactId, apply }) {
  const notes = await listNotes(supabase, workspaceId, { entityId: contactId, limit: 200 });
  const facts = notes.filter(n => n.source === 'signal_extraction' && !n.metadata?.doc_type);
  if (facts.length < 2) return { total: facts.length, removed: 0 };

  const groups = (await findDuplicateGroups(facts)).filter(g =>
    Number.isInteger(g.keep) && Array.isArray(g.remove) && g.remove.length);

  let removed = 0;
  for (const g of groups) {
    const keep = facts[g.keep - 1];
    const dropped = g.remove.map(n => facts[n - 1]).filter(Boolean).filter(f => f.id !== keep?.id);
    if (!keep || !dropped.length) continue;
    console.log(`    ✓ keep    ${keep.content}`);
    for (const d of dropped) {
      console.log(`    ✗ remove  ${d.content}`);
      removed++;
      if (apply) await deleteNote(supabase, workspaceId, d.id);
    }
    if (g.why) console.log(`              ↳ ${g.why}`);
  }
  return { total: facts.length, removed };
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

  console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — dedup ${name}\n`);
  const { total, removed } = await dedupContact({ supabase, workspaceId: contact.workspace_id, contactId, apply });
  if (!removed) console.log('  No duplicates found — all facts are distinct.');
  console.log(`\n${apply ? `Invalidated ${removed}` : `Would invalidate ${removed}`} of ${total} facts.`);
  if (!apply && removed) console.log('Re-run with --apply to commit.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
