// One own-plan backfill, in its own process (GET-1085). This run lasts as long as a person's plan
// takes, and its model calls wait on that person, so it stays out of the hosted jobs' queue.
//
// Usage: node apps/worker/src/ownBackfillRun.mjs <job id>

import './bootEnv.mjs';
import { getSupabaseClient } from '@nous/core';
import { withOwnModel } from './lib/llm.mjs';
import { ownModelAsk } from './lib/ownModelBridge.mjs';
import { readOwnBackfilledEmail } from './workers/contactEnrichmentJobs.mjs';
import { flushCompanySummaries } from './signals/companySummary.mjs';

const HEARTBEAT_MS = 60_000;
const QUIET_CHECKS = 3;

export async function runOwnBackfill(supabase, jobId, deps = {}) {
  const enrich = deps.enrich ?? (await import('./services/contactHistoryEnricher.mjs')).enrichContactHistory;
  const readEmail = deps.readEmail ?? readOwnBackfilledEmail;
  const flush = deps.flushSummaries ?? flushCompanySummaries;
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  const { data: job } = await supabase.from('contact_enrichment_jobs')
    .select('job_id, workspace_id, contacts, contact_ids, window_days, state').eq('job_id', jobId).maybeSingle();
  const owner = job?.state?.own_model?.owner_user_id;
  if (!owner) throw new Error(`job ${jobId} is not an own-plan backfill`);

  const heartbeat = setInterval(() => {
    supabase.from('contact_enrichment_jobs').update({ locked_at: new Date().toISOString() }).eq('job_id', jobId).then(() => {}, () => {});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const update = (patch) => supabase.from('contact_enrichment_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('job_id', jobId);
  // Nobody came back: pause for the next `nous backfill`, and end the process with the read open.
  const away = deps.onAway ?? (async () => {
    await update({ status: 'paused_own_model', paused_reason: 'away', paused_at: new Date().toISOString() });
    process.exit(0);
  });
  try {
    const input = Array.isArray(job.contacts) && job.contacts.length ? job.contacts : (job.contact_ids ?? []);
    // A run that died left calls nobody is waiting on. Answering them would spend the plan on nothing.
    await supabase.from('own_model_calls').delete().eq('job_id', jobId);
    const ask = deps.ask ?? ownModelAsk(supabase, job, { onAway: away });
    let open = 0;
    const counted = async (call) => { open++; try { return await ask(call); } finally { open--; } };
    await withOwnModel(counted, async () => {
      await enrich(supabase, job.workspace_id, input, jobId, { windowDays: job.window_days ?? null, ownerUserId: owner, ownPlan: true, allowEmpty: input.length === 0 });
      await readEmail(supabase, job);
      // Work a read set going in the background runs here, inside the run, so it lands on this
      // person's plan. Ending the process now would drop it, or leave it for us to pay for.
      await flush(supabase);
      for (let quiet = 0; quiet < QUIET_CHECKS;) {
        await sleep(1000);
        quiet = open ? 0 : quiet + 1;
      }
    });
    await update({ status: 'done', done: true });
    return 'done';
  } finally {
    clearInterval(heartbeat);
  }
}

if (process.argv[1]?.endsWith('ownBackfillRun.mjs')) {
  runOwnBackfill(getSupabaseClient(), process.argv[2]).then(
    (r) => { console.log(`[OWN_BACKFILL] ${process.argv[2]} ${r}`); process.exit(0); },
    async (err) => {
      console.error(`[OWN_BACKFILL] ${process.argv[2]} failed:`, err?.message || err);
      await getSupabaseClient().from('contact_enrichment_jobs').update({ status: 'failed', error: String(err?.message || err).slice(0, 500) }).eq('job_id', process.argv[2]);
      process.exit(1);
    });
}
