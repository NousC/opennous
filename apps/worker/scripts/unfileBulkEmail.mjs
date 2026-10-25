// One-off (GET-1029): newsletters and notifications already filed as an email FROM someone stop
// counting as them answering us. Ingest no longer files them; this moves the ones already on file
// out of `interaction.*` (to `evidence.bulk_email`), so last active, engagement, deal health and
// the stage stop reading them. Nothing is deleted.
//
//   node apps/worker/scripts/unfileBulkEmail.mjs [--workspace=UUID] [--write]
//
// Dry run by default: counts what it would move. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
import { getSupabaseClient } from '@nous/core';

const argv = process.argv.slice(2);
const WS = (argv.find(a => a.startsWith('--workspace=')) || '').split('=')[1] || null;
const WRITE = argv.includes('--write');
const supabase = getSupabaseClient();

let moved = 0;
const perWs = {};
for (;;) {
  let q = supabase.from('observations').select('id, workspace_id')
    .eq('property', 'interaction.email_received').eq('raw->>bulk', 'true').limit(500);
  if (WS) q = q.eq('workspace_id', WS);
  const { data, error } = await q;
  if (error) throw error;
  if (!data.length) break;
  for (const r of data) perWs[r.workspace_id] = (perWs[r.workspace_id] ?? 0) + 1;
  if (!WRITE) {
    let c = supabase.from('observations').select('id', { count: 'exact', head: true })
      .eq('property', 'interaction.email_received').eq('raw->>bulk', 'true');
    if (WS) c = c.eq('workspace_id', WS);
    moved = (await c).count ?? data.length;
    break;
  }
  const { error: e } = await supabase.from('observations').update({ property: 'evidence.bulk_email' }).in('id', data.map(r => r.id));
  if (e) throw e;
  moved += data.length;
  if (data.length < 500) break;
}
console.log(`[UNFILE_BULK] ${WRITE ? 'moved' : 'would move'} ${moved} · by workspace${WRITE ? '' : ' (first 500)'} ${JSON.stringify(perWs)}`);
