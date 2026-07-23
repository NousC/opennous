// Unipile LinkedIn profile fetch + headline parsing.
//
// Unipile's GET /api/v1/users/{provider_id} returns a UserProfile with headline,
// websites, profile_picture_url, contact_info, location — but NO structured work
// history. So title + company are parsed out of the free-text headline, which on
// LinkedIn overwhelmingly follows a "Role @ Company" / "Role at Company" convention.
// We only extract when that pattern is present (high precision) — better to leave a
// field empty than to write a guess that pollutes the record and the ICP score.

// Parse "Co-Founder @ Prospect Engine | We run GTM ..." → { jobTitle, company }.
// Returns nulls when no Role@Company segment is found.
export function parseHeadline(headline) {
  if (!headline || typeof headline !== 'string') return { jobTitle: null, company: null };
  const segments = headline.split(/[|·•–—\n]+/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    // "<role> @ <company>" or "<role> at <company>" — 'at' must be a whole word.
    const m = seg.match(/^(.{2,60}?)\s+(?:@|at)\s+(.{2,80})$/i);
    if (m) {
      const jobTitle = m[1].trim().replace(/[,;:]+$/, '');
      const company  = m[2].trim().replace(/[,;:.]+$/, '');
      if (jobTitle && company) return { jobTitle, company };
    }
  }
  return { jobTitle: null, company: null };
}

// Fetch a member's profile from Unipile and return the fields we can use.
// Any field may be null. Returns null on transport/HTTP failure (caller no-ops).
export async function fetchLinkedInProfile(accountId, memberId) {
  const dsn = process.env.UNIPILE_DSN;
  const key = process.env.UNIPILE_API_KEY;
  if (!dsn || !key || !accountId || !memberId) return null;
  try {
    const url = `https://${dsn}/api/v1/users/${encodeURIComponent(memberId)}?account_id=${encodeURIComponent(accountId)}`;
    const res = await fetch(url, { headers: { 'X-API-KEY': key, accept: 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();

    const headline = d.headline || null;
    const { jobTitle, company } = parseHeadline(headline);
    const photoUrl = d.profile_picture_url || d.profile_picture_url_large || null;
    const companyDomain = Array.isArray(d.websites) && d.websites[0]
      ? d.websites[0].replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase() || null
      : null;
    const phone = d.contact_info?.phones?.[0] || null;
    // First-degree connections often expose their real email(s) in the profile —
    // the reliable source, no Gmail name-matching needed. A profile can list BOTH
    // a work and a personal address; keep ALL valid ones (deduped) so every one
    // becomes an identifier downstream, not just the first. `email` stays the
    // first for back-compat; `emails` carries the full set.
    const emails = [...new Set(
      (d.contact_info?.emails || [])
        .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || ''))
        .map(e => e.toLowerCase().trim()),
    )];
    const email = emails[0] || null;
    const location = d.location || null;
    // The real public vanity handle (e.g. "jordan-lee"). This is what makes a
    // contact scrapeable/enrichable — unlike the member-URN we usually start with.
    // Guard against Unipile echoing the URN back as the identifier.
    const rawId = d.public_identifier || null;
    const publicIdentifier = rawId && !/^acoaa/i.test(rawId) ? rawId : null;

    return { headline, jobTitle, company, companyDomain, photoUrl, phone, email, emails, location, publicIdentifier };
  } catch (e) {
    console.warn('[LINKEDIN_PROFILE] fetch failed (non-fatal):', e.message);
    return null;
  }
}
