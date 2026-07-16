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

// A LinkedIn "member URN" URL (/in/ACoAA…) wraps LinkedIn's internal, opaque
// member id. It resolves in a logged-in browser but is NOT a stable public
// vanity handle and is NOT scrapeable by post-search actors. Never treat it as
// a usable linkedin_url identifier.
export function isMemberUrnLinkedInUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const slug = String(raw).match(/\/in\/([^/?#]+)/i)?.[1];
  return !!slug && /^acoaa/i.test(slug);
}
