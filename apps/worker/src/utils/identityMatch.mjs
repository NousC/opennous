// Pure identity-corroboration helpers — no DB, no env, no heavy imports, so they
// can be unit-tested in isolation. Used by resolveContact's "known contact is
// booking/replying from a new email" step.
//
// The hard lesson behind this module: matching on NAME ALONE is unsafe. Two
// different people can share a name (e.g. a "Jordan Reed" at Northwind vs a
// "Jordan Reed" at Globex). So a name match must be backed by a second signal
// before we attach a new email to an existing contact. That second signal is
// domain/company corroboration, implemented here.

// Free / consumer mailbox providers — a match on one of these domains tells us
// nothing about which company a person belongs to, so it can never corroborate.
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'zoho.com', 'pm.me', 'fastmail.com',
]);

/** Second-level label of a domain. 'northwind.io' → 'northwind'; 'mail.acme.co.uk' → 'acme'. */
export function domainRoot(domain) {
  if (!domain || typeof domain !== 'string') return null;
  const parts = domain.toLowerCase().trim().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || null;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // Handle two-part public suffixes (co.uk, com.au, co.nz, …): take the label before them.
  if (parts.length >= 3 && second.length <= 3 && last.length <= 3) return parts[parts.length - 3];
  return second;
}

/** Domain portion of an email, lowercased. 'A@Northwind.IO' → 'northwind.io'. */
export function emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

/** Collapse a company name to a comparable token: lowercased, alnum-only, common
 *  legal/industry suffixes stripped. "Globex Future Labs 🌐" → "globexfuture". */
export function normalizeCompanyToken(name) {
  if (!name || typeof name !== 'string') return null;
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Strip trailing legal/industry/TLD-ish suffixes (once).
  s = s.replace(/(incorporated|inc|llc|ltd|limited|gmbh|corp|company|labs|lab|technologies|technology|tech|software|io|ai|app|hq)$/, '');
  return s || null;
}

/**
 * Does an existing contact corroborate that `incomingDomain` is theirs?
 * Returns true only when there's a real company signal — never on name alone.
 *
 * @param {{domain?:string|null, company?:string|null, emailDomains?:string[]}} candidate
 * @param {string|null} incomingDomain  domain of the new email (e.g. 'northwind.io')
 */
export function corroboratesIdentity(candidate, incomingDomain) {
  if (!incomingDomain || FREE_EMAIL_DOMAINS.has(incomingDomain)) return false;
  const root = domainRoot(incomingDomain);
  if (!root) return false;

  // (a) the contact's stored company domain matches
  if (candidate.domain && domainRoot(candidate.domain) === root) return true;

  // (b) the contact's company NAME maps to the same root (NORTHWIND ↔ northwind.io)
  const compTok = normalizeCompanyToken(candidate.company);
  if (compTok) {
    if (compTok === root) return true;
    // Allow prefix overlap only for reasonably long tokens, to avoid 2–3 char
    // tokens matching everything.
    if (root.length >= 4 && compTok.length >= 4 && (compTok.startsWith(root) || root.startsWith(compTok))) return true;
  }

  // (c) the contact already has another email at the same domain root
  for (const d of candidate.emailDomains || []) {
    if (d && domainRoot(d) === root) return true;
  }

  return false;
}
