// The Connect over MCP dialog's tool list (GET-626) matches the server's registry.
//
// Run: node --test apps/frontend/tests/mcpTools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MCP_TOOLS } from "../src/config/mcpTools.ts";

test("MCP_TOOLS is PLUGIN_TOOLS in apps/mcp/src/server.js, in order", () => {
  const src = readFileSync(fileURLToPath(new URL("../../mcp/src/server.js", import.meta.url)), "utf8");
  const m = /const PLUGIN_TOOLS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(m, "PLUGIN_TOOLS not found in server.js");
  const names = [...m[1].replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  assert.deepEqual([...MCP_TOOLS], names);
});
