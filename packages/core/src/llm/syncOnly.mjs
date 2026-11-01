// Sync-only runs (GET-1087): a workspace's history lands in the graph with ZERO model calls.
//
// The pulls share their code with live ingest, and live ingest reads as it files. Threading a flag
// through every handler would leave one missed call site spending money nobody agreed to, so the
// run carries the fact in its async context instead: the signal entry points return early when
// they see it, and the model door refuses anything that gets past them. What it refused is counted
// on the store, so a run can prove it spent nothing.
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export class SyncOnlyModelCall extends Error {
  constructor(feature) {
    super(`model call refused in a sync-only run (${feature || 'unnamed'})`);
    this.name = 'SyncOnlyModelCall';
    this.feature = feature ?? null;
  }
}

/** Run `fn` as a sync-only run. `store` keeps what the run needs across its handlers. */
export function withSyncOnly(store, fn) {
  store.refused ??= [];
  store.discovered ??= new Map();
  return storage.run(store, fn);
}

/** The run's store, or null outside a sync-only run. */
export const syncOnlyStore = () => storage.getStore() ?? null;
export const isSyncOnly = () => storage.getStore() != null;

/** The door's check. Throws inside a sync-only run, and notes what was refused. */
export function refuseInSyncOnly(feature) {
  const store = storage.getStore();
  if (!store) return;
  store.refused.push(feature ?? null);
  throw new SyncOnlyModelCall(feature);
}
