export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// NOTE (context-graph decouple #3): the pipeline funnel is a PRODUCT concept and no longer
// re-exported here — identity resolution is substrate and must not depend on the sales ladder.
// Consumers import the enum straight from ../pipeline.js (a product module).

export function isUUID(value: string): boolean {
  return UUID_RE.test(value);
}

export function isEmail(value: string): boolean {
  return value.includes('@');
}

// Returns 'uuid' | 'email' | null
export function identifierType(value: string): 'uuid' | 'email' | null {
  if (isUUID(value)) return 'uuid';
  if (isEmail(value)) return 'email';
  return null;
}

export function normaliseLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const m = u.pathname.match(/\/in\/([^/]+)/);
    if (!m) return null;
    // A vanity handle is case-insensitive, so it folds. A member URN in the same
    // position (/in/ACoAA…) is NOT — it is base64-ish, and lowercasing it turns a real
    // LinkedIn id into a string that matches nothing. Hundreds of identifiers in production
    // were stored lowercased this way. MUST agree with normalise_identifier() in the
    // database, which a trigger applies to every write.
    const handle = /^acoa/i.test(m[1]) ? m[1] : m[1].toLowerCase();
    return `https://www.linkedin.com/in/${handle}`;
  } catch {
    return null;
  }
}

// Free / consumer mailbox providers. A personal mailbox tells us how to REACH a
// person but says nothing about the company they work for — so its domain must
// never populate the company `domain` field or spawn a company row. (Kept in
// sync with apps/worker/src/utils/identityMatch.mjs, which uses the same set to
// refuse free domains as an identity-corroboration signal.)
export const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'zoho.com', 'pm.me', 'fastmail.com',
]);

export function isFreeEmailDomain(domain: string | null | undefined): boolean {
  if (!domain || typeof domain !== 'string') return false;
  return FREE_EMAIL_DOMAINS.has(domain.toLowerCase().trim().replace(/^www\./, ''));
}

// Company domain derived from an email address — returns null for personal/free
// mailboxes (gmail.com, gmx.de, …) and for malformed input. Use this everywhere
// a `domain` field is filled from an email so we never record a mailbox provider
// as an employer. The email itself stays a valid identifier; only the company
// domain is suppressed.
export function companyDomainFromEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim().replace(/^www\./, '') || null;
  if (!domain || isFreeEmailDomain(domain)) return null;
  return domain;
}

// A human-readable company NAME derived from a company domain — a fallback for the
// display name when a source gives us a domain but no company name (e.g. a cold
// reply from mkade@northpine.example → "Northpine"). Takes the second-level label,
// splits on separators, and title-cases. Returns null for free/malformed domains.
// Never authoritative — a real company name from enrichment/CRM should win.
export function companyNameFromDomain(domain: string | null | undefined): string | null {
  if (!domain || typeof domain !== 'string') return null;
  const d = domain.toLowerCase().trim().replace(/^www\./, '');
  if (!d || isFreeEmailDomain(d)) return null;
  const labels = d.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  // Second-level label, accounting for two-part TLDs (co.uk, com.au, …).
  const twoPart = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
  const sld = (labels.length >= 3 && twoPart.has(labels[labels.length - 2]))
    ? labels[labels.length - 3]
    : labels[labels.length - 2];
  if (!sld) return null;
  return sld
    .split(/[-_]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || null;
}

// Normalise an email's local part to a stable identity key: lowercase, drop the
// plus-tag, then strip everything a human treats as noise (digits, dots,
// underscores, hyphens) down to letters only. `fakelenaquist9` and `fakelenaquist15` both
// collapse to `fakelenaquist`; `jordan.lee+work` → `jordanlee`. Returns null when the
// result is shorter than 4 letters — too generic to anchor an identity on. This
// is an EXACT key after normalisation, not fuzzy matching: there is no
// similarity threshold, only equality on the normalised value.
export function normalizeEmailLocalPart(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const base = email.slice(0, at).toLowerCase().split('+')[0];
  const letters = base.replace(/[^a-z]/g, '');
  return letters.length >= 4 ? letters : null;
}

// Bare, lowercased domain of an email address. null on malformed input.
export function emailDomain(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const d = email.slice(at + 1).toLowerCase().trim().replace(/^www\./, '');
  return d || null;
}

// Given the incoming email(s) and every (entity_id, email) already active in the
// workspace, pick the UNIQUE existing person a bare-email record should attach to,
// per the normalised-local-part tier (docs/identity-resolution.md §Planned).
// The identity key is (normalised local part, domain): a record forks into a
// duplicate only when Step 1 (shared identifier) and Step 2 (name) both miss, and
// this is the tier that catches `fakelenaquist9@gmail.com` vs `fakelenaquist15@gmail.com`.
//
// Gates, matching the rest of the resolution layer's "never guess" philosophy:
//   - Same domain required (baked into the key), so gmail↔acme never collapse.
//   - FREE email domains are excluded entirely: on gmail/outlook/etc. a shared
//     domain is NOT corroboration, and the local-part normalisation means
//     `test.user.0088@gmail.com` and `test.user.2024@gmail.com` (two different
//     people; obviously fake local parts, gmail.com because the point is a free
//     domain) would collapse to the same key. Only a private/company domain makes
//     a normalised local-part match trustworthy. (Mirrors the worker's
//     identityMatch.mjs, which also refuses free domains as a corroborator.)
//   - The exact same email is skipped — Step 1 already owns that case.
//   - UNIQUE candidate only: zero or more-than-one existing entity sharing the
//     key is ambiguous, so it returns null and the caller creates a fresh record
//     (a duplicate is a cheap, reversible merge; a wrong fuse is not).
// Pure and side-effect free so the decision is unit-testable without a database.
export function pickLocalPartMatch(
  incomingEmails: string[],
  existing: { entity_id: string; email: string }[],
): string | null {
  const keys = new Map<string, string>(); // "norm|domain" -> the raw incoming email (lowercased)
  for (const e of incomingEmails) {
    const norm = normalizeEmailLocalPart(e);
    const dom = emailDomain(e);
    if (norm && dom && !isFreeEmailDomain(dom)) keys.set(`${norm}|${dom}`, e.toLowerCase().trim());
  }
  if (keys.size === 0) return null;

  const candidates = new Set<string>();
  for (const row of existing) {
    const norm = normalizeEmailLocalPart(row.email);
    const dom = emailDomain(row.email);
    if (!norm || !dom) continue;
    const key = `${norm}|${dom}`;
    if (!keys.has(key)) continue;
    if (keys.get(key) === row.email.toLowerCase().trim()) continue; // identical email → Step 1's job
    candidates.add(row.entity_id);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

// A LinkedIn "member URN" URL (/in/ACoAA…) wraps LinkedIn's internal, opaque
// member id. It resolves in a logged-in browser but is NOT a stable public
// vanity handle and is NOT scrapeable by post-search actors. Never treat it as
// a usable linkedin_url identifier.
export function isMemberUrnLinkedInUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const slug = String(raw).match(/\/in\/([^/?#]+)/i)?.[1];
  return !!slug && /^acoaa/i.test(slug);
}

/**
 * A stable key for a company NAME, for the case where we have no domain.
 *
 * Company entities resolve on `domain`. A company created without one carries no
 * identifier at all, so `getOrCreateEntity` can never match it and mints a fresh
 * entity on every mention — which is how one workspace ended up with
 * "Harborline.app" and "Harborline" as two separate companies, both with a null domain,
 * while the person's own observations carried `domain: harborline.example` all along.
 *
 * The existing name fallback is an exact `ilike`, so those two never met. This
 * folds the differences that are spelling rather than identity:
 *
 *   "Harborline.app"  "Harborline"  "HARBORLINE"  "Harborline, Inc."  →  "harborline"
 *
 * Deliberately aggressive about the brand-TLD suffix (.ai / .io / .com as part of
 * a display name), because that is the single most common way one company gets
 * written two ways. A real domain always wins over this — the key is only reached
 * when there is no domain to key on.
 */
const COMPANY_LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'l l c', 'ltd', 'limited', 'plc', 'gmbh', 'ag', 'bv', 'nv',
  'sa', 'sas', 'srl', 'spa', 'ab', 'as', 'oy', 'kk', 'pty', 'pte', 'co', 'corp', 'corporation',
  'company', 'holdings', 'group', 'labs', 'technologies', 'the',
]);

export function companyNameKey(name: string | null | undefined): string | null {
  if (!name || typeof name !== 'string') return null;
  const s = name.toLowerCase().trim();
  if (!s) return null;
  // Strip a brand TLD from the end of any WORD, not just the end of the string,
  // so "Web.com" and "Web.com Group" agree. An internal dot that isn't a TLD
  // ("a.b.consulting") is left alone.
  const words = s.split(/\s+/)
    .map(w => w.replace(/\.(ai|io|com|co|app|dev|xyz|net|org|sh|so|tech)$/i, ''))
    .map(w => w.replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
    .filter(w => !COMPANY_LEGAL_SUFFIXES.has(w));
  // Nothing but legal suffixes ("Inc", "The Group") is not a name. Returning a
  // key here would collapse every such record onto one stub company.
  if (!words.length) return null;
  const key = words.join('');
  // One or two characters is not a name either — refuse rather than guess.
  return key.length >= 3 ? key : null;
}
