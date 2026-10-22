// May we read for this workspace? (GET-531)
//
// The credit band stops a self-serve workspace at 120% of its allowance — but only the api
// enforced it, and the api does not run extraction. This is the worker's half: one question,
// asked once per workspace per few minutes, before a batch of conversations is read.
//
// THREE RULES, all of them about not breaking the product to protect the bill:
//
//   1. FAILS OPEN. No secret, no API_URL, a timeout, a 500, a body we cannot parse — all
//      answer yes. We would rather read a few conversations we are not paid for than stop a
//      paying customer because a billing query was slow.
//   2. CACHED. Extraction runs per conversation; the gate is per workspace. A five-minute
//      answer keeps a backfill of thousands of threads to one question instead of thousands.
//   3. SAYS WHY, once. A workspace that stops reading has to be findable in the log, but a
//      line per skipped conversation buries everything else.
//
// AND ONE EXCEPTION TO THE FIRST TWO, for a HARD CAP (Free's 500, GET-700). A hard cap is a stop,
// not a band, so:
//   - the answer carries `untilStop` (credits left before reading stops) and the reader caps a
//     batch to it and spends it down locally (noteCreditsSpent) instead of reading 400 threads on
//     one yes;
//   - near the cap a cached "yes" is not served — every check asks again (the api counts a hard
//     cap fresh);
//   - a cap we KNOW is exhausted stays shut when the api is unreachable or its count failed.
//     Failing open means not stopping on a billing hiccup; it does not mean forgetting a stop we
//     already measured.

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 4_000;
/** A hard cap with fewer credits than this left is re-asked on every check. */
export const HARD_CAP_NEAR_CREDITS = 100;

/** workspaceId → { at, allowed, reason, hardCap, untilStop } */
const cache = new Map();
/** workspaceId → the last reason we logged, so a stopped workspace prints once per window. */
const logged = new Map();

const OPEN = Object.freeze({ allowed: true, reason: null, hardCap: false, untilStop: null });
const view = (a) => ({ allowed: a.allowed, reason: a.reason, hardCap: !!a.hardCap, untilStop: a.untilStop ?? null });
/** A hard cap we have measured, which an outage must not reopen. */
const knownHardCap = (hit) => hit && hit.hardCap && typeof hit.untilStop === 'number';

/**
 * @param {string} workspaceId
 * @param {{ fresh?: boolean }} [opts] fresh: skip the cache and ask now.
 * @returns {Promise<{allowed: boolean, reason: string|null, hardCap: boolean, untilStop: number|null}>}
 *   allowed is the field to honour; untilStop (credits left before reading stops, null = no known
 *   stop) is what a batch reader caps itself to.
 */
export async function mayReadWorkspace(workspaceId, { fresh = false } = {}) {
  if (!workspaceId) return { ...OPEN };

  const hit = cache.get(workspaceId);
  // Near a hard cap a cached yes goes stale in a few threads, so it is not served (GET-700). An
  // exhausted cap's "no" is still served from cache: that answer does not get staler by reading.
  const nearCap = knownHardCap(hit) && hit.allowed && hit.untilStop < HARD_CAP_NEAR_CREDITS;
  if (hit && !fresh && !nearCap && Date.now() - hit.at < TTL_MS) return view(hit);

  const secret = process.env.WORKER_INTERNAL_SECRET;
  const apiUrl = process.env.API_URL;
  // Not configured is not the same as over limit. A deployment without the internal channel
  // reads exactly as it did before this existed.
  if (!secret || !apiUrl) return { ...OPEN };

  // What an outage answers: open, unless we already measured a hard cap — then the last
  // measurement, spent down by what has been read since (GET-700).
  const fallback = () => (knownHardCap(hit) ? view(hit) : { ...OPEN });

  let answer = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(`${apiUrl}/internal/credits/read-allowed?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: { 'X-Internal-Secret': secret },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) {
      const d = await r.json();
      const hardCap = d?.hardCap === true;
      const untilStop = Number.isFinite(d?.untilStop) ? Math.max(0, d.untilStop) : null;
      // Only an explicit false stops anything. A malformed body reads as yes.
      if (d && d.meterError === true) {
        // The count failed and `used` is a fail-open zero: no measurement, so no new answer.
        answer = null;
      } else if (d && d.allowed === false) {
        answer = { allowed: false, reason: d.reason ?? 'over_credit_limit', hardCap, untilStop };
        if (logged.get(workspaceId) !== answer.reason) {
          console.log(
            `[CREDIT-GATE] ws=${workspaceId} reading paused (${answer.reason}) — ` +
            `${d.used ?? '?'} of ${d.included ?? '?'} credits, ${d.percentUsed ?? '?'}%`,
          );
          logged.set(workspaceId, answer.reason);
        }
      } else {
        answer = { allowed: true, reason: null, hardCap, untilStop };
        logged.delete(workspaceId);
      }
    }
  } catch (err) {
    // Fails open — see the note above.
    if (err?.name !== 'AbortError') console.warn('[CREDIT-GATE] check failed, allowing:', err?.message || err);
  }

  if (!answer) {
    const fb = fallback();
    // An open fallback is cached as before (one question per window, not one per thread); a
    // remembered hard cap keeps its own entry and is asked about again next time.
    if (!knownHardCap(hit)) cache.set(workspaceId, { at: Date.now(), ...fb });
    return fb;
  }
  cache.set(workspaceId, { at: Date.now(), ...answer });
  return view(answer);
}

/**
 * Spend down a workspace's cached allowance by what was just read (GET-700), so the next check
 * — and the next chunk of a batch — sees it without asking the api. When a known stop reaches
 * zero the cached answer becomes a no. Only touches an answer that carried a stop.
 */
export function noteCreditsSpent(workspaceId, credits) {
  const hit = cache.get(workspaceId);
  const n = Number(credits) || 0;
  if (!hit || typeof hit.untilStop !== 'number' || n <= 0) return;
  hit.untilStop = Math.max(0, hit.untilStop - n);
  if (hit.untilStop === 0 && hit.allowed) {
    hit.allowed = false;
    hit.reason = 'over_credit_limit';
  }
}

/** Drop a workspace's cached answer — call after something that would change it. */
export function forgetCreditGate(workspaceId) {
  cache.delete(workspaceId);
  logged.delete(workspaceId);
}
