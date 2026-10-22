// A self-hosted Nous on a laptop serves https://api.localhost with Caddy's own local CA, which
// Node does not trust. fetch then rejects with a bare "fetch failed" whose cause carries one of
// these codes. Name the fix in one line instead of printing a stack trace (GET-1011).
const UNTRUSTED_CERT_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export const CERT_DOCS_URL =
  "https://github.com/NousC/opennous/blob/main/docs/self-host-bundled.md#trying-it-on-a-laptop";

/** The cert code on an error or anywhere down its `cause` chain, else null. */
export function untrustedCertCode(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === "string" && UNTRUSTED_CERT_CODES.has(e.code)) return e.code;
  }
  return null;
}

/** One line telling the user how to trust their server's certificate, or null when the error is something else. */
export function certHint(err) {
  const code = untrustedCertCode(err);
  if (!code) return null;
  return `Couldn't connect: this server's TLS certificate isn't trusted by Node (${code}). ` +
    `Set NODE_EXTRA_CA_CERTS to your server's CA certificate (for a local self-host, Caddy's root.crt) and run it again. ` +
    `How: ${CERT_DOCS_URL}`;
}
