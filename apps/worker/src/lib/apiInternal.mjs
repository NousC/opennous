// Where the worker calls the API's /internal/* routes (and its other worker-to-API calls).
//
// NOUS_API_INTERNAL_URL is the API on the compose network (http://api:3000, set in
// docker-compose.yaml), so the call never leaves the host. The public API_URL is the fallback:
// on a localhost self-host `api.localhost` resolves to the worker container itself, and on a
// real server the call would go out and back in through Caddy, which no longer routes
// /internal/* (deploy/selfhost/Caddyfile). Same idea as the API's NOUS_WORKER_URL.
//
// API_URL stays the PUBLIC address for anything a third party or a browser is given (webhook
// callbacks, links). Only server-to-server calls use this.
export function apiInternalBase(env = process.env) {
  const raw = String(env.NOUS_API_INTERNAL_URL || env.API_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}
