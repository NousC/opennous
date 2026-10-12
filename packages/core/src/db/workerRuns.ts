import type { SupabaseClient } from '@supabase/supabase-js';

// Worker run log — every nightly/periodic worker writes a row here so the
// Intelligence page can show whether the compound-intelligence loop is alive.
// See supabase/migrations/2026_05_25_worker_runs.sql.

export type WorkerRunStatus = 'success' | 'error' | 'no_op';

export interface WorkerRunInput {
  worker: string;                                 // 'mind_outcomes', 'scorecard_loop', etc.
  workspaceId?: string | null;                    // NULL = system-wide
  status: WorkerRunStatus;
  summary?: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
  startedAt: Date | string;                       // recorded at the top of the run
  finishedAt?: Date | string;                     // defaults to now
}

// Insert a worker_runs row. Non-fatal: a log-write failure must never break a
// worker, so this swallows errors and returns null on failure.
export async function logWorkerRun(
  supabase: SupabaseClient,
  input: WorkerRunInput,
): Promise<string | null> {
  const startedAt = input.startedAt instanceof Date
    ? input.startedAt.toISOString()
    : input.startedAt;
  const finishedAt = input.finishedAt instanceof Date
    ? input.finishedAt.toISOString()
    : (input.finishedAt ?? new Date().toISOString());
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  try {
    const { data, error } = await supabase
      .from('worker_runs')
      .insert({
        worker: input.worker,
        workspace_id: input.workspaceId ?? null,
        status: input.status,
        summary: input.summary ?? null,
        details: input.details ?? {},
        error: input.error ?? null,
        duration_ms: Math.max(0, durationMs),
        started_at: startedAt,
        finished_at: finishedAt,
      })
      .select('id')
      .single();
    if (error) {
      // Missing migration = silent skip. Anything else = warn but don't throw.
      if (error.code !== '42P01' && error.code !== 'PGRST205') {
        console.warn('[logWorkerRun]', error.message);
      }
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (err) {
    console.warn('[logWorkerRun]', (err as Error).message);
    return null;
  }
}
