// Is the worker still alive?
//
// The worker writes one unconditional heartbeat row a minute (apps/worker/src/workers/heartbeat.mjs).
// This turns the newest one into a readiness verdict for GET /readyz/workers, which an external
// uptime monitor polls. Kept out of the route so the judgement itself can be tested: the route is
// a database read and a status code around this.
//
// Tolerance is generous on purpose. A minute's cadence against a five-minute window rides out a
// slow tick, a deploy and a restart without paging anyone, and still catches a real stop inside
// six minutes. The outage this exists for lasted three hours.

/** Default staleness window. WORKER_STALE_AFTER_MINUTES overrides it; two minutes is the floor. */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

export function staleAfterMsFromEnv(env = process.env) {
  return Math.max(2, Number(env.WORKER_STALE_AFTER_MINUTES) || 5) * 60_000;
}

/**
 * The verdict on one heartbeat timestamp.
 *
 * @param lastSeen  ISO string of the newest heartbeat, or null when there has never been one
 * @param now       millis
 * @param staleMs   how old a heartbeat may be before the worker counts as stopped
 * @returns {{ ok: boolean, last_seen: string|null, age_seconds: number|null, error?: string }}
 */
export function heartbeatVerdict(lastSeen, now = Date.now(), staleMs = DEFAULT_STALE_AFTER_MS) {
  if (!lastSeen) {
    // Never recorded. On a first deploy this clears within a minute of the worker booting; if it
    // does not clear, the worker has never started, which is exactly the outage worth reporting.
    return { ok: false, last_seen: null, age_seconds: null, error: 'no heartbeat recorded' };
  }
  const t = Date.parse(lastSeen);
  if (!Number.isFinite(t)) {
    return { ok: false, last_seen: lastSeen, age_seconds: null, error: 'heartbeat timestamp unreadable' };
  }
  // A clock skew that puts the heartbeat slightly in the future is not a stopped worker.
  const ageMs = Math.max(0, now - t);
  const ok = ageMs <= staleMs;
  return {
    ok,
    last_seen: lastSeen,
    age_seconds: Math.round(ageMs / 1000),
    ...(ok ? {} : { error: `no heartbeat for ${Math.round(ageMs / 60_000)} minute(s)` }),
  };
}
