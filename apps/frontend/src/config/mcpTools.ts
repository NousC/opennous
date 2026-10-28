// The tools the hosted MCP server lists (GET-626), in the order tools/list returns them.
//
// Mirrors PLUGIN_TOOLS in apps/mcp/src/server.js — the registry createServer() registers from.
// tests/mcpTools.test.ts reads that file and fails when the two drift, so the Connect over MCP
// dialog never quotes a tool the server doesn't have, or a count it doesn't list.
// Cloud's server also lists read_brain, write_brain and read_intelligence after `score` (GET-839, GET-1042); the dialog adds
// them from the cloud registry (lib/cloud.ts `mcpTools`), as the server adds them from its own.
export const MCP_TOOLS: readonly string[] = [
  "whoami", "find", "get_context", "query", "attention", "tasks", "rules", "get_insights",
  "add_note", "enrich", "score", "set_icp",
  "webhooks",
  "get_account", "deals", "pages", "read_page", "save_page",
  "record", "record_insight", "record_closed_deals",
];
