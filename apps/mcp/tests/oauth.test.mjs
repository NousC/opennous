// MCP OAuth discovery (GET-762): the hosted server must tell clients like Grok and
// Claude.ai how to sign in. Starts the real http.js against a stub API.
//
// Run: cd apps/mcp && node --test tests/oauth.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HTTP_JS = fileURLToPath(new URL("../src/http.js", import.meta.url));
let api, mcp, base;

before(async () => {
  // Stub API: token-status answers 204 only for nat_good, and serves AS metadata.
  api = http.createServer((req, res) => {
    if (req.url === "/oauth/token-status") {
      res.writeHead(req.headers.authorization === "Bearer nat_good" ? 204 : 401);
      return res.end();
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ issuer: "https://api.example" }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const port = 30000 + Math.floor(Math.random() * 20000);
  mcp = spawn(process.execPath, [HTTP_JS], {
    env: { ...process.env, PORT: String(port), NOUS_API_URL: `http://127.0.0.1:${api.address().port}`,
           MCP_URL: "https://mcp.example", OAUTH_ISSUER: "https://api.example" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => mcp.stdout.on("data", (d) => String(d).includes("listening") && resolve()));
  base = `http://127.0.0.1:${port}`;
});

after(() => { mcp?.kill(); api?.close(); });

const rpc = (headers = {}) => fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

test("no token: 401 with WWW-Authenticate pointing at the resource metadata", async () => {
  const r = await rpc();
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("www-authenticate"),
    'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"');
  assert.match(r.headers.get("access-control-expose-headers"), /WWW-Authenticate/);
});

test("protected-resource metadata names the resource and the authorization server", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200);
    const m = await r.json();
    assert.equal(m.resource, "https://mcp.example/mcp");
    assert.deepEqual(m.authorization_servers, ["https://api.example"]);
    assert.deepEqual(m.bearer_methods_supported, ["header"]);
  }
});

test("authorization-server metadata is served on the MCP host too (2025-03-26 clients)", async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).issuer, "https://api.example");
});

test("an expired or unknown nat_ token gets an HTTP 401 with invalid_token, so the client refreshes", async () => {
  const r = await rpc({ Authorization: "Bearer nat_expired" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /^Bearer error="invalid_token", resource_metadata=/);
});

test("an OAuth token in the query string is ignored (401)", async () => {
  const r = await fetch(`${base}/mcp?key=nat_good`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
});

test("a live nat_ token and a pk_ key both reach the MCP server", async () => {
  for (const token of ["nat_good", "pk_whatever"]) {
    const r = await rpc({ Authorization: `Bearer ${token}` });
    assert.equal(r.status, 200, token);
    await r.text();
  }
});
