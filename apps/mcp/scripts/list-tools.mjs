#!/usr/bin/env node

/**
 * Print the live tool catalog of the Nous MCP server.
 *
 * This is not a pretty-printer over source: it boots the real stdio server
 * (src/index.js), performs a real MCP handshake, and calls `tools/list` — the
 * exact thing Claude/Cursor does when it connects. What prints is what an agent
 * actually sees.
 *
 *   node apps/mcp/scripts/list-tools.mjs           # grouped catalog
 *   node apps/mcp/scripts/list-tools.mjs --full    # + full tool descriptions
 *   node apps/mcp/scripts/list-tools.mjs --json    # raw tools/list payload
 *
 * No API key needed — tool registration is static; only calls need auth.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.js");

const full = process.argv.includes("--full");
const asJson = process.argv.includes("--json");

// The groups are the product story, in the order you'd tell it: read the
// account, write back what happened, ask across the book, run the workspace.
const GROUPS = [
  ["READ THE ACCOUNT", "engineered context, not raw rows", [
    "get_context", "get_account", "verify", "search_notes", "list_notes", "get_insights",
  ]],
  ["WRITE BACK", "the agent observes; Nous derives", [
    "record", "record_signal", "save_note", "score", "merge_contacts",
  ]],
  ["ASK ACROSS THE BOOK", "the whole graph, not one record", [
    "query", "attention", "get_action_items", "pipeline", "pipeline_intelligence", "campaign_performance",
  ]],
  ["ACT", "reach out — draft email, send LinkedIn", [
    "draft_email", "send_linkedin_message",
  ]],
  ["CORRECT", "unsay something recorded by mistake", [
    "retract_observation", "delete_note", "unmerge_contacts",
  ]],
  ["RUN THE WORKSPACE", "the agent operates Nous — no wizard", [
    "get_workspace_status", "whoami", "list_integrations", "set_workspace_profile",
    "build_icp_model", "train_icp_model", "sync_icp", "export_icp_model",
    "connect_integration", "configure_crm_sync", "sync_crm_now", "scrape_engagers",
    "get_routing_preferences",
  ]],
];

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", b: "\x1b[1m", cy: "\x1b[36m", gr: "\x1b[32m", ye: "\x1b[33m", r: "\x1b[0m" }
  : { dim: "", b: "", cy: "", gr: "", ye: "", r: "" };

/** One line of prose for each tool — what it does, said the way a human would. */
const BLURB = {
  get_context:          "engineered context for one task — ranked claims, confidence, freshness, ICP fit",
  get_account:          "the whole account record: every claim + the full timeline",
  verify:               "re-derive one fact before you act on it",
  search_notes:         "semantic search across saved notes, transcripts, briefs",
  list_notes:           "list saved notes newest-first (optionally for one account)",
  get_insights:         "what Nous learned about US from our calls",
  record:               "the single write verb: what happened, what you learned",
  record_signal:        "a concrete buying signal on a person or company",
  save_note:            "attach a brief, transcript or doc to a record",
  score:               "score a lead on the live ICP model, written back to the graph",
  merge_contacts:       "fold two records for the same human into one (reversible)",
  query:                "retrieve + summarise activity across many accounts",
  attention:            "what needs you now — meetings, quiet accounts, decayed facts",
  get_action_items:     "what you owe which account, pulled from transcripts",
  pipeline:             "your whole account portfolio: health, ICP, stage, days quiet",
  pipeline_intelligence:"where deals actually leak, stage to stage",
  campaign_performance: "which campaign works, sliced by who replied",
  draft_email:          "draft an email for the operator to review + send (you draft, they send)",
  send_linkedin_message:"send a LinkedIn DM for real (or reply in-thread)",
  retract_observation:  "unsay an observation recorded by mistake; the fact re-derives",
  delete_note:          "delete a note saved by mistake",
  unmerge_contacts:     "reverse a merge — split a wrongly-merged duplicate back out",
  get_workspace_status: "what's set up + ranked next steps (call this first)",
  whoami:               "who this key acts as + the workspace roster",
  list_integrations:    "what's connected here (Gmail, HubSpot, Apollo, …)",
  set_workspace_profile:"onboarding, in conversation",
  build_icp_model:      "build the ICP model from recorded context",
  train_icp_model:      "train it on real closed-won / closed-lost",
  sync_icp:             "your existing ICP files → the graph",
  export_icp_model:     "the learned model → back into your files",
  connect_integration:  "connect Apollo, HubSpot, Prospeo, …",
  configure_crm_sync:   "set the CRM sync rules",
  sync_crm_now:         "pull the CRM right now",
  scrape_engagers:      "pull who engaged your LinkedIn posts",
  get_routing_preferences: "make an agent default to Nous for GTM",
};

/** Speak MCP over stdio: initialize → initialized → tools/list. */
function listTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for tools/list"));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve(msg.result?.tools ?? []);
        }
      }
    });

    child.on("error", (e) => { clearTimeout(timer); reject(e); });

    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "nous-tool-catalog", version: "1.0.0" },
      },
    });
  });
}

const tools = await listTools();

if (asJson) {
  console.log(JSON.stringify(tools, null, 2));
  process.exit(0);
}

const byName = new Map(tools.map((t) => [t.name, t]));
const seen = new Set();

console.log("");
console.log(`  ${C.b}Nous MCP${C.r} ${C.dim}— the Revenue Context Layer for GTM agents${C.r}`);
console.log(`  ${C.dim}${tools.length} tools, live from the server over stdio${C.r}`);

for (const [title, tagline, names] of GROUPS) {
  const present = names.filter((n) => byName.has(n));
  if (!present.length) continue;
  console.log("");
  console.log(`  ${C.cy}${title}${C.r}  ${C.dim}${tagline}${C.r}`);
  for (const name of present) {
    seen.add(name);
    console.log(`    ${C.gr}${name.padEnd(25)}${C.r}${C.dim}${BLURB[name] ?? ""}${C.r}`);
    if (full) {
      const desc = (byName.get(name).description ?? "").replace(/\s+/g, " ").trim();
      for (const line of wrap(desc, 88)) console.log(`      ${C.dim}${line}${C.r}`);
      console.log("");
    }
  }
}

const extra = tools.filter((t) => !seen.has(t.name));
if (extra.length) {
  console.log("");
  console.log(`  ${C.ye}ALSO REGISTERED${C.r}`);
  for (const t of extra) console.log(`    ${C.gr}${t.name}${C.r}`);
}
console.log("");

function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of text.split(" ")) {
    if ((line + " " + word).trim().length > width) { out.push(line.trim()); line = word; }
    else line += " " + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
