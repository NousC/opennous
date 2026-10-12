// What the Connect agent dialogs tell you to paste (GET-626, GET-627). Pure, so
// tests/connectSnippets.test.ts pins every line against how the servers actually authenticate.
//
// How the MCP server authenticates (checked against apps/mcp/src/http.js + client.js, 2026-10-02):
// the hosted server at /mcp takes the workspace API key as `Authorization: Bearer pk_…` on every
// request. There is no OAuth on it. The stdio package (`npx -y @opennous/mcp`) reads the same key
// from NOUS_API_KEY, or from ~/.nous/config.json, which the plugin's /opennous:login writes after a
// browser sign-in that mints a key. Either way it is a pk_ key, so every snippet carries one.
//
// A key's secret is shown once, when it is made, and the list endpoint never returns it — so the
// snippets read it from NOUS_API_KEY or leave a pk_… placeholder, never a key we pretend to know.

import { when } from "./format.ts";

export type McpClient = "claude" | "cursor" | "codex" | "other";
export type Step = { label: string; code?: string; mono?: string };

export const KEY_PLACEHOLDER = "pk_…";
const SERVER_NAME = "opennous";

export function mcpSteps(client: McpClient, mcpUrl: string): Step[] {
  switch (client) {
    case "claude":
      return [
        {
          label: "Add the server with your key",
          code: `export NOUS_API_KEY=${KEY_PLACEHOLDER}\nclaude mcp add --transport http ${SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer $NOUS_API_KEY"`,
        },
        { label: "Run /mcp in Claude Code and check opennous shows connected", mono: "/mcp" },
      ];
    case "cursor":
      return [
        {
          label: "Add this to ~/.cursor/mcp.json",
          mono: "~/.cursor/mcp.json",
          code: JSON.stringify(
            { mcpServers: { [SERVER_NAME]: { url: mcpUrl, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } },
            null,
            2,
          ),
        },
        { label: "Open Cursor settings, MCP, and check opennous is on" },
      ];
    case "codex":
      // Codex runs the stdio package, which takes the key from NOUS_API_KEY.
      return [
        { label: "Add the server with your key", code: `codex mcp add ${SERVER_NAME} --env NOUS_API_KEY=${KEY_PLACEHOLDER} -- npx -y @opennous/mcp` },
        { label: "Run codex mcp list and check opennous is there", mono: "codex mcp list" },
      ];
    case "other":
      return [
        { label: "Server URL", code: mcpUrl },
        { label: "Header", code: `Authorization: Bearer ${KEY_PLACEHOLDER}` },
      ];
  }
}

/** The live line under the steps: has the chosen key been used yet. */
export function keyStatus(lastUsedAt: string | null | undefined, now: number = Date.now()):
  { connected: boolean; text: string } {
  if (!lastUsedAt) return { connected: false, text: "Waiting for the first call" };
  const t = new Date(lastUsedAt).getTime();
  if (Number.isNaN(t)) return { connected: false, text: "Waiting for the first call" };
  return { connected: true, text: `Connected · ${when(t, now)}` };
}

// ── REST (GET-627) ───────────────────────────────────────────────────────────
// The /v2 Context API takes the same key as `Authorization: Bearer pk_…` (apps/api/src/middleware/
// apiKey.mjs; x-api-key works too). The lookup is GET /v2/accounts/:id, which resolves a domain,
// an email, a LinkedIn URL or an entity id to one account (resolveFocus).

export type RestLang = "curl" | "js" | "py";
export const SAMPLE_DOMAIN = "acme.com";

export function restLookup(lang: RestLang, base: string): string {
  const url = `${base}/v2/accounts/${SAMPLE_DOMAIN}`;
  switch (lang) {
    case "curl":
      return `curl ${url} \\\n  -H "Authorization: Bearer $NOUS_API_KEY"`;
    case "js":
      return `const res = await fetch(\n  "${url}",\n  { headers: { Authorization: \`Bearer \${process.env.NOUS_API_KEY}\` } }\n);\nconst account = await res.json();`;
    case "py":
      return `import os, requests\n\nr = requests.get(\n    "${url}",\n    headers={"Authorization": "Bearer " + os.environ["NOUS_API_KEY"]},\n)\naccount = r.json()`;
  }
}

/** Four calls an integration reaches for first. Each path is mounted in apps/api/src/index.mjs. */
export const COMMON_CALLS: { method: "GET" | "POST"; path: string; what: string }[] = [
  { method: "GET",  path: "/v2/accounts",      what: "List accounts, or search by name, domain or email" },
  { method: "GET",  path: "/v2/accounts/{id}", what: "One account: facts, people, timeline" },
  { method: "POST", path: "/v2/observations",  what: "Record what happened or what you learned" },
  { method: "GET",  path: "/v2/usage",         what: "Credits used this period" },
];
