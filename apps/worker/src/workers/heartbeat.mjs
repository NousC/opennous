// Proof of life, written once a minute.
//
// On 2026-09-17 the worker stopped at 02:05 and nobody noticed for three hours. Everything it
// does had silently stopped with it — claim derivation, ICP scoring, embeddings — and the outage
// was found by someone querying the database about something else.
//
// Nothing caught it because nothing was looking. /readyz on the API checks the DATABASE, and the
// database was fine; the API answered 200 the whole time. The worker's own checker (invariants)
// runs INSIDE the worker, so it died with the thing it was meant to watch — a smoke detector
// bolted inside the room that catches fire.
//
// The missing half is a fact only the worker can state and something else can read. worker_runs
// is nearly that already, except every other worker logs only when it did something, so a quiet
// system is indistinguishable from a dead one and any alarm built on it cries wolf. This one
// writes UNCONDITIONALLY: the row means "the process was alive at this time", nothing more.
//
// Read by GET /readyz/workers on the API, which an external uptime monitor polls.

import { getSupabaseClient, logWorkerRun } from '@nous/core';

export const HEARTBEAT_WORKER = 'heartbeat';

export async function writeHeartbeat() {
  const startedAt = new Date();
  try {
    await logWorkerRun(getSupabaseClient(), {
      worker: HEARTBEAT_WORKER,
      status: 'success',
      summary: 'alive',
      startedAt,
    });
  } catch (err) {
    // A heartbeat that throws would take the cron's tick with it. The absence of the row is
    // already the signal, so failing to write one needs no further handling than a line in the log.
    console.warn('[HEARTBEAT] not written:', err?.message || err);
  }
}
