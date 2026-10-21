// One-time: give existing signals the chip their claim reads with now (GET-959).
//
// A signal's title is copied from its claim's label once, when the signal is written. Claims read
// their label through claimLabel now (code-built for competitor, tech stack, budget and
// stakeholders), so their chips are right without touching them; the signals already written still
// say "Quillbox vs Our Data". This rewrites those titles from the claim. No model, idempotent: a title
// that already matches is left alone. Next steps (action_item.*) keep their own titles.
//
//   node apps/worker/scripts/relabelSignals.mjs [--write] [--workspace=UUID]
//
// Dry run by default: prints what would change. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { getSupabaseClient, claimLabel, isIntelClaim } from '@nous/core';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const WORKSPACE = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
const PAGE = 500;

const supabase = getSupabaseClient();

let seen = 0, changed = 0;
for (let from = 0; ; from += PAGE) {
  let q = supabase.from('account_signals').select('id, workspace_id, entity_id, claim_property, title')
    .like('claim_property', 'note.%').order('id').range(from, from + PAGE - 1);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data: signals, error } = await q;
  if (error) throw error;
  if (!signals?.length) break;
  seen += signals.length;

  const props = [...new Set(signals.map(s => s.claim_property))];
  const claims = new Map();
  for (let i = 0; i < props.length; i += 100) {
    const { data, error: e } = await supabase.from('claims').select('workspace_id, entity_id, property, value')
      .in('property', props.slice(i, i + 100));
    if (e) throw e;
    for (const c of data ?? []) claims.set(`${c.workspace_id}|${c.property}`, c);
  }

  for (const s of signals) {
    const c = claims.get(`${s.workspace_id}|${s.claim_property}`);
    if (!c || !isIntelClaim(c.value)) continue;
    const v = c.value ?? {};
    const title = claimLabel({ category: v.category, label: v.label, content: v.content, metadata: v.metadata });
    if (!title || title === s.title) continue;
    changed++;
    console.log(`${WRITE ? 'set' : 'would set'} ${s.id}: ${JSON.stringify(s.title)} → ${JSON.stringify(title)}`);
    if (WRITE) {
      const { error: u } = await supabase.from('account_signals').update({ title }).eq('id', s.id);
      if (u) console.warn(`  failed: ${u.message}`);
    }
  }
  if (signals.length < PAGE) break;
}
console.log(`${seen} signals read, ${changed} ${WRITE ? 'retitled' : 'to retitle (dry run; --write to apply)'}`);
