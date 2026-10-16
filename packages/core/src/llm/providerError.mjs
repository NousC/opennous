// What a failed model call means, for a person and for ops (GET-885).
//
// On 2026-10-15 the Anthropic account ran out of credit again. A chat that calls Anthropic
// directly showed "hit an error. Try again." and nobody was told. Trying again could not help: the account was empty. This sorts a provider failure into
// the few kinds that need different words and different action:
//
//   billing     the account is out of credit (Anthropic says it as a 400, others as 402)
//   auth        the key is missing, wrong or revoked (401/403)
//   rate_limit  too many requests or the provider is overloaded (429/529, overloaded_error);
//               waiting a minute helps
//   other       anything else: a bug, a bad request, an outage we cannot name
//
// Pure: no I/O, no env. Works on what the Anthropic SDK throws (status, the parsed body on
// .error, the body in the message), on modelDoor's ModelUnavailableError, and on the
// "model call failed: 402 {...}" errors of the OpenAI-compatible harness.

const BILLING = /credit balance|insufficient[ _-]?(credit|credits|funds|balance|quota)|requires more credits|out of credits|billing_error|payment required|exceeded your current quota/i;
const AUTH = /authentication_error|permission_error|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|no auth credentials|invalid bearer|unauthori[sz]ed/i;
const BUSY = /overloaded_error|rate_limit_error|rate[ _-]?limit(ed)?\b|too many requests/i;

function statusOf(err) {
  const s = Number(err?.status);
  if (Number.isInteger(s) && s >= 100 && s < 600) return s;
  // "400 {...}" (Anthropic SDK) or "model call failed: 402 {...}" (the harness).
  const m = /(?:^|failed:\s*|\s)([45]\d\d)(?=\s|$|[:{])/.exec(String(err?.message ?? ''));
  return m ? Number(m[1]) : null;
}

function typeOf(err) {
  const body = err?.error;
  const t = body?.error?.type ?? body?.type ?? null;
  return typeof t === 'string' && t !== 'error' ? t : null;
}

/**
 * A model provider's failure -> { kind: 'billing'|'auth'|'rate_limit'|'other', status, type }.
 * `status` is the HTTP status when one is known, `type` the provider's error type.
 */
export function classifyProviderError(err) {
  const status = err ? statusOf(err) : null;
  const type = err ? typeOf(err) : null;
  const text = `${type ?? ''} ${err?.error?.error?.message ?? ''} ${err?.message ?? ''}`;
  let kind = 'other';
  if (status === 402 || type === 'billing_error' || BILLING.test(text)) kind = 'billing';
  else if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error' || AUTH.test(text)) kind = 'auth';
  else if (status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error' || BUSY.test(text)) kind = 'rate_limit';
  return { kind, status, type };
}

const SECRETISH = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,                 // Anthropic / OpenRouter / OpenAI keys
  /\b(Bearer|Basic)\s+[^\s"',)]+/gi,          // an Authorization header value
  /\b[A-Za-z0-9_-]{32,}\b/g,                  // any other long token-looking run
];

/**
 * The provider's own message, safe to log or send to an ops channel: the inner message when the
 * body has one, key-like strings removed, at most 300 characters. Never shown to users.
 */
export function providerErrorSummary(err) {
  if (!err) return '';
  let s = String(err?.error?.error?.message ?? err?.message ?? err);
  for (const re of SECRETISH) s = s.replace(re, '[redacted]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}
