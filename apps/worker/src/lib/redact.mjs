// Mask an email address for logs: keep the first character and the domain,
// hide the rest. "alice@acme.example" -> "a***@acme.example". Null-safe.
// Keeps logs useful for debugging (domain + first char) without writing the full
// PII of a data subject to stdout.
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return email[0] + '***' + email.slice(at);
}
