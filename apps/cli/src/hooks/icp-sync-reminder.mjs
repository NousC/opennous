#!/usr/bin/env node
// Nous ICP auto-sync reminder (installed by `npx @opennous/cli init`).
//
// A Claude Code PostToolUse hook. After the agent edits a Nous context file, it
// reminds the agent that the file is INERT until synced: the app, the ICP tab, and
// the ICP scoring model read the Nous GRAPH, not the repo file, so an edit does
// nothing until mcp__nous__sync_icp runs. Standalone Node (no bash/jq) so it behaves
// identically on Windows, macOS, and Linux.

let raw = "";
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw || "{}");
    const f = (j && j.tool_input && j.tool_input.file_path) || (j && j.tool_response && j.tool_response.filePath) || "";
    const norm = String(f).replace(/\\/g, "/");           // normalize Windows separators
    if (!/\.md$/i.test(norm) || !/\/context\//i.test(norm)) return;

    // Report the path relative to the project so the agent passes the right source_path.
    const proj = (process.env.CLAUDE_PROJECT_DIR || "").replace(/\\/g, "/");
    let rel = norm;
    if (proj && norm.toLowerCase().startsWith(proj.toLowerCase())) {
      rel = norm.slice(proj.length).replace(/^\/+/, "");
    }
    const base = norm.split("/").pop().toLowerCase();

    const ctx = base === "icp.md"
      ? `You just edited ${rel}, your Nous ICP file. It is INERT until synced: the app, the ICP tab, and the ICP scoring model read the Nous graph, not this file. Call the mcp__nous__sync_icp tool THIS TURN with section "ICP" and source_path "${rel}", passing the file body as the section content, so the graph and the scoring model rebuild from your edit. Do not end the turn with the ICP file edited but unsynced.`
      : `You edited a Nous context file (${rel}). It stays inert until synced into the Nous graph. If it is an ICP, positioning, pricing, competitors, or market file, call mcp__nous__sync_icp this turn with the matching section and its source_path so the graph updates.`;

    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } }));
  } catch { /* never block a tool call */ }
});
