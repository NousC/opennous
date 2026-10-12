/**
 * Where to send someone after they sign in.
 *
 * The CLI login flow opens /cli-login?code=… in the browser. If the visitor has no
 * session, that page can't just error — it has to send them to sign up and bring them
 * BACK to the exact same URL, code and all, or the terminal never finishes and the whole
 * "one command from zero" story falls apart on the account-creation step.
 *
 * So Login and Signup read a `redirect` query param and honour it, on the email path, the
 * OTP path, AND across the Google OAuth round-trip. This is the same mechanism the invite
 * flow already relies on to carry its token through Google.
 */

const DEFAULT_AFTER_AUTH = '/';

/**
 * Read `redirect` from a query string and return a SAFE internal path, or the default.
 *
 * Open-redirect guard: only same-origin, path-absolute targets. A value that doesn't start
 * with a single "/", or that starts with "//" or "/\" (both of which browsers treat as a
 * protocol-relative URL to another host), is rejected — otherwise `?redirect=//evil.com`
 * would walk our own login page into sending a freshly-authenticated user to an attacker.
 */
export function safeRedirect(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AFTER_AUTH;
  if (raw[0] !== '/') return DEFAULT_AFTER_AUTH;      // must be path-absolute
  if (raw[1] === '/' || raw[1] === '\\') return DEFAULT_AFTER_AUTH; // not protocol-relative
  return raw;
}

/** Build a link to the auth page that returns here afterwards. */
export function authPathWithRedirect(page: '/login' | '/signup', returnTo: string): string {
  return `${page}?redirect=${encodeURIComponent(returnTo)}`;
}
