/**
 * OAuth discovery for the hosted MCP server (GET-762).
 *
 * The MCP server is the protected resource; the API is the authorization
 * server. A client that calls /mcp without a token gets a 401 whose
 * WWW-Authenticate header points at /.well-known/oauth-protected-resource
 * (RFC 9728), which names the authorization server. From there the client
 * registers, sends the user to sign in, and comes back with a nat_ access
 * token, which this server forwards to the API exactly like a pk_ key.
 *
 * Env (all optional; cloud defaults):
 *   MCP_URL / MCP_DOMAIN       — public origin of this server
 *   OAUTH_ISSUER / API_URL / API_DOMAIN — public origin of the authorization server
 */

const strip = (s) => s.replace(/\/$/, "");

export function publicOrigin(req) {
  if (process.env.MCP_URL) return strip(process.env.MCP_URL);
  if (process.env.MCP_DOMAIN) return `https://${process.env.MCP_DOMAIN}`;
  const host = req?.headers?.host;
  if (host) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  return "https://mcp.opennous.cloud";
}

export function issuer() {
  if (process.env.OAUTH_ISSUER) return strip(process.env.OAUTH_ISSUER);
  if (process.env.API_DOMAIN) return `https://${process.env.API_DOMAIN}`;
  // API_URL is often the in-cluster http://api:3000, which clients can't reach.
  if (process.env.API_URL?.startsWith("https://")) return strip(process.env.API_URL);
  return "https://api.opennous.cloud";
}

export const PROTECTED_RESOURCE_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

// RFC 9728 protected-resource metadata.
export function protectedResourceMetadata(req) {
  return {
    resource: `${publicOrigin(req)}/mcp`,
    authorization_servers: [issuer()],
    scopes_supported: ["nous"],
    bearer_methods_supported: ["header"],
    resource_name: "OpenNous",
    resource_documentation: "https://docs.opennous.cloud/mcp",
  };
}

// The header every 401 carries, so clients can discover how to sign in.
export function wwwAuthenticate(req, error) {
  const parts = [`resource_metadata="${publicOrigin(req)}/.well-known/oauth-protected-resource"`];
  if (error) parts.unshift(`error="${error}"`);
  return `Bearer ${parts.join(", ")}`;
}

// An OAuth access token is checked up front, so an expired one gets an HTTP 401
// (which makes the client refresh) instead of a tool error inside a 200.
// pk_ keys skip this: they keep today's behaviour and cost no extra round-trip.
export const isOAuthToken = (token) => typeof token === "string" && token.startsWith("nat_");

export async function checkOAuthToken(apiUrl, token, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${strip(apiUrl)}/oauth/token-status`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 204) return { ok: true };
    if (r.status === 401) return { ok: false, status: 401 };
    return { ok: false, status: 503 };
  } catch {
    return { ok: false, status: 503 };
  }
}
