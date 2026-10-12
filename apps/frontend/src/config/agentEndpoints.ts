// Where an operator's agent talks to us (API plan, GET-620/626/627). One place, so the sidebar's
// docs link, the Connect agent dialogs and Get started never quote three different URLs.

/** The hosted MCP server (apps/mcp/src/http.js, POST /mcp). Overridable for self-host. */
export const MCP_URL: string = import.meta.env.VITE_MCP_URL || "https://mcp.opennous.cloud/mcp";

/** Public docs. Same override the rest of the app documents in nous.env.example. */
export const DOCS_URL: string = (import.meta.env.VITE_DOCS_URL || "https://docs.opennous.cloud").replace(/\/+$/, "");

/** The REST base the /v2 Context API is served from. VITE_API_URL is empty behind the
 *  same-domain nginx proxy, so the page's own origin is the API then. */
export function apiBaseUrl(): string {
  const v = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
  if (v) return v;
  return typeof window !== "undefined" ? window.location.origin : "https://api.opennous.cloud";
}
