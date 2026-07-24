export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const VALID_PIPELINE_STAGES = [
  'identified', 'aware', 'connected', 'interested', 'evaluating', 'client',
  'lost', 'disqualified', 'churned',
] as const;

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
    return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
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

// Normalise an email's local part to a stable identity key: lowercase, drop the
// plus-tag, then strip everything a human treats as noise (digits, dots,
// underscores, hyphens) down to letters only. `sarahwig9` and `sarahwig15` both
// collapse to `sarahwig`; `jordan.lee+work` → `jordanlee`. Returns null when the
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
// this is the tier that catches `sarahwig9@gmail.com` vs `sarahwig15@gmail.com`.
//
// Gates, matching the rest of the resolution layer's "never guess" philosophy:
//   - Same domain required (baked into the key), so gmail↔acme never collapse.
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
    if (norm && dom) keys.set(`${norm}|${dom}`, e.toLowerCase().trim());
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
