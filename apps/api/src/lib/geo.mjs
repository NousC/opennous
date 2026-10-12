// ─────────────────────────────────────────────────────────────────────────────
// Geo helpers — derive ISO 3166-1 alpha-2 country code from a request IP.
//
// Uses geoip-lite (self-contained, no external API calls). Country DB ships
// with the package and is loaded into memory on first lookup.
//
// IMPORTANT: requires `app.set('trust proxy', 1)` upstream so `req.ip` is the
// real client IP, not the immediate proxy hop (Caddy).
// ─────────────────────────────────────────────────────────────────────────────

import geoip from 'geoip-lite';

/** Pull the most-likely client IP off a request, honouring trust-proxy. */
function getClientIp(req) {
  // Express's req.ip respects the `trust proxy` setting.
  if (req?.ip) return req.ip;
  const fwd = req?.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req?.socket?.remoteAddress || null;
}

/**
 * Returns the ISO-3166 alpha-2 country code for the request's client IP,
 * or null if it can't be determined (localhost, private ranges, lookup
 * miss, etc.). Always defensive — never throws.
 */
export function getCountryFromRequest(req) {
  try {
    const ip = getClientIp(req);
    if (!ip) return null;
    // geoip-lite rejects IPv6-mapped IPv4 with the ::ffff: prefix.
    const cleaned = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    const lookup = geoip.lookup(cleaned);
    return lookup?.country || null;
  } catch {
    return null;
  }
}
