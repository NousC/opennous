// What the Connect agent dialogs tell you to paste (GET-626, GET-627), pinned.
//
// Run: node --test apps/frontend/tests/connectSnippets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMON_CALLS, keyStatus, mcpSteps, restLookup } from "../src/lib/connectSnippets.ts";

const URL_ = "https://mcp.opennous.cloud/mcp";

test("every MCP client carries a Bearer pk_ key and the real URL", () => {
  for (const c of ["claude", "cursor", "other"] as const) {
    const all = mcpSteps(c, URL_).map((s) => s.code ?? "").join("\n");
    assert.match(all, /Authorization"?: "?Bearer pk_|Bearer \$NOUS_API_KEY/);
    assert.ok(all.includes(URL_), c);
  }
  // Codex runs the stdio package, which reads NOUS_API_KEY.
  const codex = mcpSteps("codex", URL_)[0].code!;
  assert.match(codex, /NOUS_API_KEY=pk_/);
  assert.match(codex, /npx -y @opennous\/mcp/);
});

test("each client has exactly two steps", () => {
  for (const c of ["claude", "cursor", "codex", "other"] as const) assert.equal(mcpSteps(c, URL_).length, 2);
});

test("cursor's config is valid JSON with url + headers", () => {
  const j = JSON.parse(mcpSteps("cursor", URL_)[0].code!);
  assert.equal(j.mcpServers.opennous.url, URL_);
  assert.equal(j.mcpServers.opennous.headers.Authorization, "Bearer pk_…");
});

test("the hosted server really takes the key as a Bearer header, and has no OAuth", () => {
  const http = readFileSync(fileURLToPath(new URL("../../mcp/src/http.js", import.meta.url)), "utf8");
  assert.match(http, /auth\.startsWith\("Bearer "\)/);
  assert.match(http, /const MCP_PATH = "\/mcp"/);
  assert.doesNotMatch(http, /oauth/i);
});

test("key status: waiting until the key is used, then when", () => {
  const now = new Date(2026, 9, 2, 12, 0).getTime();
  assert.deepEqual(keyStatus(null, now), { connected: false, text: "Waiting for the first call" });
  assert.deepEqual(keyStatus(new Date(now - 12 * 60_000).toISOString(), now), { connected: true, text: "Connected · 12m ago" });
  assert.deepEqual(keyStatus("nonsense", now), { connected: false, text: "Waiting for the first call" });
});

test("REST lookup snippets hit GET /v2/accounts/:id with a Bearer key", () => {
  const base = "https://api.opennous.cloud";
  for (const lang of ["curl", "js", "py"] as const) {
    const s = restLookup(lang, base);
    assert.ok(s.includes(`${base}/v2/accounts/acme.com`), lang);
    assert.match(s, /Bearer/);
    assert.match(s, /NOUS_API_KEY/);
  }
});

test("every common call is a real route: mounted in index.mjs and handled in its router", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const index = read("../../api/src/index.mjs");
  const router: Record<string, string> = {
    "/v2/accounts": "../../api/src/routes/v2/accounts.mjs",
    "/v2/observations": "../../api/src/routes/v2/observations.mjs",
    "/v2/usage": "../../api/src/routes/v2/usage.mjs",
  };
  for (const c of COMMON_CALLS) {
    const [, mount, sub] = /^(\/v2\/[a-z]+)(\/\{id\})?$/.exec(c.path)!;
    assert.match(index, new RegExp(`app\\.use\\('${mount}',`), c.path);
    const src = read(router[mount]);
    const verb = c.method.toLowerCase();
    const route = sub ? "'/:id'" : "'/'";
    assert.ok(src.includes(`.${verb}(${route}`), `${c.method} ${c.path}`);
  }
});
