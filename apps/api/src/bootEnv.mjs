// Boot-time env normalization — MUST be the first import in the entry file,
// before any module captures process.env.API_URL / APP_URL at load time
// (e.g. services/linkedin.mjs reads them into a module-level const).
//
// Self-hosters set the bare domains (APP_DOMAIN / API_DOMAIN) because Caddy
// needs them. Most app code reads the full-URL forms (APP_URL / API_URL) and
// otherwise falls back to our cloud — which would silently break OAuth
// redirects, webhook callbacks, and email links on a self-host install.
// Derive the URL forms from the domains here so setting the domains is enough.
// An explicit *_URL always wins, so cloud (which sets them directly) is
// unaffected. WORKER_URL already falls back to API_URL at its call sites.
const e = process.env;
if (!e.APP_URL && e.APP_DOMAIN) e.APP_URL = `https://${e.APP_DOMAIN}`;
if (!e.API_URL && e.API_DOMAIN) e.API_URL = `https://${e.API_DOMAIN}`;
