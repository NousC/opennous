// One-time (GET-1016): retire the deal facts already on file for everyone marked personal before
// marking did so itself. From GET-1016 on, markEntityPersonal retires them at the moment of the mark;
// this runs the same retirement over the marks made earlier. Nothing is deleted: each fact gets
// invalid_at and `retired_for_personal`, and unmarking the person or company brings it back.
//
//   node apps/worker/scripts/retirePersonalFacts.mjs [--write] [--workspace=UUID]
//
// Dry run by default: prints what each mark would retire. Needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY.
import { getSupabaseClient, personalFactsFor, retirePersonalFacts } from '@nous/core';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const WORKSPACE = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
const supabase = getSupabaseClient();

const marks = [];
for (let from = 0; ; from += 1000) {
  let q = supabase.from('claims').select('id, workspace_id, entity_id, value')
    .eq('property', 'is_personal').is('invalid_at', null).order('id').range(from, from + 999);
  if (WORKSPACE) q = q.eq('workspace_id', WORKSPACE);
  const { data, error } = await q;
  if (error) throw error;
  marks.push(...data);
  if (data.length < 1000) break;
}

let total = 0;
for (const m of marks.filter(m => m.value === true)) {
  const n = WRITE
    ? await retirePersonalFacts(supabase, m.workspace_id, m.entity_id)
    : (await personalFactsFor(supabase, m.workspace_id, m.entity_id)).length;
  if (n) console.log(`[RETIRE_PERSONAL_FACTS] ${m.workspace_id} ${m.entity_id}: ${n}`);
  total += n;
}
console.log(`[RETIRE_PERSONAL_FACTS] ${marks.length} marks · ${total} facts ${WRITE ? 'retired' : 'to retire (dry run)'}`);
