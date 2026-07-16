// Quick verifier — prints the most recent worker_runs rows.
import { getSupabaseClient } from '@nous/core';

const supabase = getSupabaseClient();
const { data, error } = await supabase
  .from('worker_runs')
  .select('worker, workspace_id, status, summary, duration_ms, finished_at, error')
  .order('finished_at', { ascending: false })
  .limit(20);

if (error) {
  console.error('error:', error);
  process.exit(1);
}

console.log(`worker_runs rows: ${data.length}\n`);
for (const r of data) {
  const ws = r.workspace_id ? r.workspace_id.slice(0, 8) : 'system';
  const dur = r.duration_ms != null ? `${r.duration_ms}ms` : '—';
  console.log(`[${r.finished_at}] ${r.worker.padEnd(16)} ws=${ws} status=${r.status.padEnd(8)} ${dur}  ${r.summary || ''}`);
  if (r.error) console.log(`                                    ↳ error: ${r.error}`);
}
