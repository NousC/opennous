// One-off (GET-1023): correct the kind of a claim about us the model filed wrong, e.g. a "build your
// own X, get us off the others" request filed as a friction. Setting a row to feature sends its
// Feature requested event, as filing it as one would have.
//
//   node apps/worker/scripts/reclassifyAboutUs.mjs --contact=UUID            list their claims about us
//   node apps/worker/scripts/reclassifyAboutUs.mjs --id=UUID [--kind=feature] [--write]
//
// Dry run by default: prints the row and the change. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { getSupabaseClient, ABOUT_US_KINDS, emitFeatureRequests } from '@nous/core';

const argv = process.argv.slice(2);
const arg = name => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || null;
const WRITE = argv.includes('--write');
const ID = arg('id'), CONTACT = arg('contact'), KIND = arg('kind') || 'feature';
const COLS = 'id, workspace_id, kind, company_id, contact_id, what, content, quote, quote_private, speaker, use_case, source_ref, source_system, occurred_at';
const supabase = getSupabaseClient();

if (CONTACT) {
  const { data, error } = await supabase.from('about_us_claims').select(COLS)
    .eq('contact_id', CONTACT).is('retired_at', null).order('created_at', { ascending: false }).limit(30);
  if (error) throw error;
  for (const r of data) console.log(`[RECLASSIFY] ${r.id} ${r.kind} · ${r.what} · ${r.source_system}\n  ${r.content}\n  "${r.quote ?? ''}"`);
  process.exit(0);
}
if (!ID) throw new Error('pass --contact=UUID to list, or --id=UUID to change one');
if (!ABOUT_US_KINDS.includes(KIND)) throw new Error(`--kind must be one of ${ABOUT_US_KINDS.join(', ')}`);

const { data: row, error } = await supabase.from('about_us_claims').select(COLS).eq('id', ID).maybeSingle();
if (error) throw error;
if (!row) throw new Error(`no claim about us ${ID}`);
console.log(`[RECLASSIFY] ${row.id} ${row.kind} → ${KIND} · ${row.what}\n  ${row.content}`);
if (row.kind === KIND) process.exit(0);
if (!WRITE) { console.log('[RECLASSIFY] dry run: pass --write to change it'); process.exit(0); }

const { error: upErr } = await supabase.from('about_us_claims').update({ kind: KIND }).eq('id', ID);
if (upErr) throw upErr;
await emitFeatureRequests(supabase, row.workspace_id, [{ ...row, kind: KIND }]);
console.log(`[RECLASSIFY] changed${KIND === 'feature' ? '; Feature requested event sent' : ''}`);
