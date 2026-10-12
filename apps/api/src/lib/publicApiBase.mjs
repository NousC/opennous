// The API's PUBLIC address, for anything we hand to another service or show a user: inbound
// webhook URLs, provider webhook registrations, OAuth redirects (GET-666).
//
// In production API_URL is the internal Docker address (http://api:3000) the containers use to
// reach each other, so it must never leave the box. This picks the first configured address that
// is reachable from outside, and only falls back to an internal one when nothing public is set
// (local dev, where localhost is the right answer).

const isPublic = (u) => {
  const host = /^https?:\/\/([^/:]+)/i.exec(u ?? '')?.[1]?.toLowerCase();
  return !!host && host.includes('.') && host !== '127.0.0.1' && !host.endsWith('.local') && !host.endsWith('.internal');
};

export function publicApiBase() {
  const env = process.env;
  const candidates = [
    env.PUBLIC_API_URL,
    env.WORKER_URL,
    env.BACKEND_URL,
    env.API_DOMAIN ? `https://${env.API_DOMAIN}` : null,
    env.API_URL,
  ].filter(Boolean).map((u) => u.replace(/\/+$/, ''));
  return candidates.find(isPublic) ?? candidates[0] ?? `http://localhost:${env.PORT || 3000}`;
}
