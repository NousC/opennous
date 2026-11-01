// The worker's side of an own-plan backfill (GET-1085): one model call becomes a row the person's
// CLI answers. The caller waits for as long as the person is away. A closed laptop is a pause, not
// an outage: a read that failed would be marked and skipped, a read that waits loses nothing. So
// when the wait runs out the run stops outright (`onAway`); reads catch model errors and carry on,
// so an error here could never stop it.

export const POLL_MS = 1000;
export const WAIT_LIMIT_MS = 8 * 60 * 60_000;

/** The `ask` for withOwnModel: write the call, wait, take the answer, delete the row. */
export function ownModelAsk(supabase, job, { onAway, pollMs = POLL_MS, waitLimitMs = WAIT_LIMIT_MS, sleep = (ms) => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  return async ({ feature, system, messages, max_tokens, temperature }) => {
    const { data: call, error } = await supabase.from('own_model_calls').insert({
      job_id: job.job_id, workspace_id: job.workspace_id, owner_user_id: job.state.own_model.owner_user_id,
      feature, request: { system, messages, max_tokens, temperature },
    }).select('id').single();
    if (error) throw new Error(`own model: ${error.message}`);
    const started = now();
    for (;;) {
      const { data: row } = await supabase.from('own_model_calls')
        .select('status, answer, model, usage, error').eq('id', call.id).maybeSingle();
      if (row?.status === 'done' || row?.status === 'failed') {
        await supabase.from('own_model_calls').delete().eq('id', call.id);
        if (row.status === 'failed') throw new Error(row.error || 'own model failed');
        return { text: row.answer ?? '', model: row.model, usage: row.usage };
      }
      if (now() - started > waitLimitMs) await onAway();
      await sleep(pollMs);
    }
  };
}
