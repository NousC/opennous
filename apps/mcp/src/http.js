#!/usr/bin/env node

/**
 * Nous MCP Server — hosted, multi-tenant HTTP entrypoint (mcp.opennous.cloud).
 *
 * Serves the same tool set (server.js) over the MCP Streamable HTTP transport,
 * so cloud clients that cannot launch a local process — n8n cloud above all —
 * can connect by pasting one URL plus their workspace API key.
 *
 * Auth: each request carries its own `Authorization: Bearer pk_...` (the same
 * workspace key the REST API already validates). A `?key=pk_...` query param is
 * accepted as a fallback for url-only clients (less secure: it can land in logs).
 * OAuth (GET-762): clients that sign in instead (Grok, Claude.ai, ChatGPT) discover
 * the authorization server from the 401's WWW-Authenticate header and send a nat_
 * access token, which is forwarded the same way. See oauth.js.
 * The key is bound for the request via AsyncLocalStorage (runWithApiKey), so the
 * tool handlers stay key-agnostic.
 *
 * Stateless: a fresh server + transport per request — clean tenant isolation,
 * no session store.
 *
 * Env:
 *   PORT           — listen port (default 3002)
 *   NOUS_API_URL   — API base URL (default https://api.opennous.cloud; in-cluster: http://api:3000)
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { runWithApiKey } from "./client.js";
import { createServer, SERVER_VERSION } from "./server.js";
import {
  PROTECTED_RESOURCE_PATHS, protectedResourceMetadata, wwwAuthenticate, isOAuthToken, checkOAuthToken,
} from "./oauth.js";

const PORT = Number(process.env.PORT) || 3002;
const MCP_PATH = "/mcp";
const API_URL = process.env.NOUS_API_URL || "https://api.opennous.cloud";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json", ...headers });
  res.end(text);
}

// JSON-RPC shaped error so MCP clients render it cleanly.
function rpcError(res, status, message, id = null, headers = {}) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id }, headers);
}

function extractApiKey(req, url) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  // Query fallback is for pk_ keys only: OAuth tokens must never ride in a URL (MCP spec).
  const qp = url.searchParams.get("key");
  if (qp && qp.trim().startsWith("pk_")) return qp.trim();
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (url.pathname === "/health" || url.pathname === "/") {
    return sendJson(res, 200, { status: "ok", server: "nous-mcp", version: SERVER_VERSION });
  }

  if (PROTECTED_RESOURCE_PATHS.includes(url.pathname)) {
    return sendJson(res, 200, protectedResourceMetadata(req), { "Cache-Control": "public, max-age=300" });
  }

  // Clients on the 2025-03-26 spec look for the authorization-server metadata on
  // the MCP host itself. Serve the API's copy so they find the same answer.
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    try {
      const r = await fetch(`${API_URL}/.well-known/oauth-authorization-server`);
      return sendJson(res, r.status, await r.json(), { "Cache-Control": "public, max-age=300" });
    } catch {
      return sendJson(res, 503, { error: "temporarily_unavailable" });
    }
  }

  if (url.pathname !== MCP_PATH) {
    return rpcError(res, 404, "Not found. The MCP endpoint is POST /mcp.");
  }

  const apiKey = extractApiKey(req, url);
  if (!apiKey) {
    return rpcError(res, 401, "Sign in with OpenNous, or send Authorization: Bearer <your Nous API key>.", null,
      { "WWW-Authenticate": wwwAuthenticate(req) });
  }
  if (isOAuthToken(apiKey)) {
    const check = await checkOAuthToken(API_URL, apiKey);
    if (!check.ok && check.status === 401) {
      return rpcError(res, 401, "The access token is invalid or expired.", null,
        { "WWW-Authenticate": wwwAuthenticate(req, "invalid_token") });
    }
    if (!check.ok) return rpcError(res, 503, "Could not verify the access token. Try again.");
  }

  let body;
  try {
    body = req.method === "POST" ? await readBody(req) : undefined;
  } catch {
    return rpcError(res, 400, "Invalid JSON body.");
  }

  // Fresh server + transport per request (stateless), with the key bound for
  // the whole async handling so every tool call uses this tenant's key.
  // The caller's User-Agent rides along so the API's per-key log can name the client (n8n,
  // Cursor, ...): this process's own fetch is what the API would otherwise see. Label only.
  const agent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;
  await runWithApiKey(apiKey, async () => {
    // One surface: the 6-primitive revenue plugin. createServer() exposes only those.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        rpcError(res, 500, `MCP error: ${err?.message ?? "unknown"}`);
      }
    }
  }, { agent });
});

httpServer.listen(PORT, () => {
  console.log(`Nous MCP (HTTP) v${SERVER_VERSION} listening on :${PORT}${MCP_PATH}`);
});
