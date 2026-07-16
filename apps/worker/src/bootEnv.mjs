// Boot-time env normalization — MUST be the first import in the entry file,
// before any module captures process.env.API_URL / APP_URL at load time.
//
// Self-hosters set the bare domains (APP_DOMAIN / API_DOMAIN) because Caddy
// needs them. Worker code reads the full-URL forms (APP_URL for onboarding /
// drip links, API_URL for webhook callbacks) and otherwise falls back to our
// cloud. Derive the URL forms from the domains here so setting the domains is
// enough. An explicit *_URL always wins, so cloud is unaffected.
const e = process.env;
if (!e.APP_URL && e.APP_DOMAIN) e.APP_URL = `https://${e.APP_DOMAIN}`;
if (!e.API_URL && e.API_DOMAIN) e.API_URL = `https://${e.API_DOMAIN}`;
