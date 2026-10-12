// Mask an email address for logs: keep the first character and the domain,
// hide the rest. "alice@acme.com" -> "a***@acme.com". Null-safe.
export function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return email[0] + '***' + email.slice(at);
}
