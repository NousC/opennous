#!/usr/bin/env node

// OpenNous CLI — the setup + auth utility. NOT a data surface.
//
// It signs you in (browser device flow → key in ~/.nous/config.json) and installs the
// opennous plugin into your agent (`init`). All data work happens in the agent through
// the 7 MCP primitives — the CLI never duplicates them.

import { program, Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "fs";
import { homedir, hostname } from "os";
import { join, resolve, dirname, relative, sep } from "path";
import { createInterface } from "readline";
import { spawn, spawnSync } from "child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recede, don't decorate. Secondary text in a terminal should be readable and
// quiet — and it must degrade to plain text when the output is piped, because a
// CI log full of escape codes is worse than no colour at all.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (t) => (COLOR ? `\x1b[2m${t}\x1b[0m` : t);
const bold = (t) => (COLOR ? `\x1b[1m${t}\x1b[0m` : t);
const green = (t) => (COLOR ? `\x1b[32m${t}\x1b[0m` : t);

// Fetch the acting identity for a key — the same whoami the agent gets — so sign-in can
// confirm WHO you are, not just that a key was written. Best-effort; never throws.
async function fetchWhoami(apiUrl, key) {
  try {
    const r = await fetch(`${apiUrl}/v2/workspace/whoami`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
// "Theo Bramwell · Fernpoint · admin · AE"
function identityLine(who) {
  const y = who?.you || {};
  return [
    y.name || (y.user_id ? "member" : "shared workspace key"),
    who?.workspace?.name,
    y.scope,
    (Array.isArray(y.roles) && y.roles.length) ? y.roles.join(", ") : null,
  ].filter(Boolean).join(dim(" · "));
}
// The one thing left after signing in: install the plugin in the agent.
function printNextSteps() {
  console.log(`  ${dim("Next — install the plugin in Claude Code:")}`);
  console.log(`    /plugin marketplace add NousC/revenue-plugin`);
  console.log(`    /plugin install opennous@opennous\n`);
}

// Best-effort open the user's browser; if it fails they have the printed URL.
//
// Windows is the sharp edge here: `start` is a cmd.exe builtin, NOT an executable,
// so `spawn("start", ...)` fails with ENOENT — and that failure arrives as an async
// 'error' EVENT, not a throw, so a try/catch never sees it. An unhandled 'error' on
// a child process is an uncaught exception that kills the whole CLI before the
// device-auth wait. So: go through cmd.exe, and always attach an 'error' handler.
function openBrowser(url) {
  let cmd, args, opts = { stdio: "ignore", detached: true };
  if (process.platform === "darwin") {
    cmd = "open"; args = [url];
  } else if (process.platform === "win32") {
    // cmd.exe /c start "" "<url>". `start` reads a lone quoted arg as the window
    // TITLE, so it needs an explicit empty title before the URL — otherwise it just
    // opens a shell titled with the URL and never launches the browser.
    // CRITICAL: the title must be a LITERAL `""` string, not JS's zero-length "".
    // With windowsVerbatimArguments the args are joined by spaces as-is, so a
    // zero-length string collapses to nothing and the title is lost (the URL then
    // becomes the title). Verbatim also keeps our quotes, so an & in the auth URL's
    // query string stays inside them and isn't parsed by cmd as a command separator.
    cmd = process.env.ComSpec || "cmd.exe";
    args = ["/c", "start", '""', `"${url}"`];
    opts.windowsVerbatimArguments = true;
  } else {
    cmd = "xdg-open"; args = [url];
  }
  try {
    const child = spawn(cmd, args, opts);
    child.on("error", () => { /* printed URL is the fallback — never crash on this */ });
    child.unref();
  } catch { /* printed URL is the fallback */ }
}

const CONFIG_PATH = join(homedir(), ".nous", "config.json");

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(cfg) {
  const dir = join(homedir(), ".nous");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function apiClient() {
  const cfg = readConfig();
  const apiKey = process.env.NOUS_API_KEY || cfg.apiKey;
  const apiUrl = process.env.NOUS_API_URL || cfg.apiUrl || "https://api.opennous.cloud";

  if (!apiKey) {
    console.error("No API key found. Run: nous auth login --key <your-key>");
    process.exit(1);
  }

  async function request(method, path, { body, query } = {}) {
    const url = new URL(path, apiUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      console.error(`Error: ${err.error || err.message}`);
      process.exit(1);
    }
    if (res.status === 204) return {};
    return res.json();
  }

  return {
    get: (path, query) => request("GET", path, { query }),
    post: (path, body) => request("POST", path, { body }),
  };
}


// ---------------------------------------------------------------------------
// nous auth
// ---------------------------------------------------------------------------
program
  .command("auth")
  .description("Manage authentication")
  .addCommand(
    new Command("login")
      .description("Save your API key")
      .requiredOption("--key <key>", "Your Nous API key")
      .option("--url <url>", "API base URL (default: https://api.opennous.cloud)")
      .action(({ key, url }) => {
        const cfg = readConfig();
        cfg.apiKey = key;
        if (url) cfg.apiUrl = url;
        writeConfig(cfg);
        console.log("✓ Authenticated. Run `nous attention` to verify.");
      })
  )
  .addCommand(
    new Command("status")
      .description("Show current auth status")
      .action(() => {
        const cfg = readConfig();
        const key = process.env.NOUS_API_KEY || cfg.apiKey;
        const url = process.env.NOUS_API_URL || cfg.apiUrl || "https://api.opennous.cloud";
        if (key) {
          console.log(`Logged in\nAPI URL: ${url}\nKey: ${key.slice(0, 8)}...`);
        } else {
          console.log("Not logged in. Run: npx @opennous/cli login");
        }
      })
  )
  .addCommand(
    new Command("logout")
      .description("Sign out — remove the saved API key")
      .action(() => {
        const cfg = readConfig();
        if (!cfg.apiKey) { console.log("Not signed in."); return; }
        delete cfg.apiKey;
        writeConfig(cfg);
        console.log("✓ Signed out — removed the saved API key from ~/.nous/config.json");
      })
  );

// ---------------------------------------------------------------------------
// nous connect <provider> — connect Gmail / Google Calendar via Composio
// ---------------------------------------------------------------------------
// You're already signed in (the saved key identifies you), so there's no device-code
// dance — we start a Composio consent, open it in your browser, and poll until the
// account goes ACTIVE. Composio holds the OAuth token; Nous never sees it.
const CONNECT_ALIASES = {
  gmail: "gmail_oauth",
  gmail_oauth: "gmail_oauth",
  calendar: "google_calendar",
  gcal: "google_calendar",
  "google-calendar": "google_calendar",
  google_calendar: "google_calendar",
};
program
  .command("connect <provider>")
  .description("Connect a source: gmail | calendar (via Composio)")
  .action(async (provider) => {
    const name = CONNECT_ALIASES[String(provider).toLowerCase()];
    if (!name) {
      console.error(`Unknown source "${provider}". Try: nous connect gmail  |  nous connect calendar`);
      process.exit(1);
    }
    const api = apiClient();
    const start = await api.post("/api/connect/composio/start", { provider: name });
    if (!start?.redirect_url) {
      console.error("Couldn't start the connection. Ask an admin to set up the Integration Engine (Composio) in Settings first.");
      process.exit(1);
    }
    console.log(`\nOpening your browser to authorize ${name === "gmail_oauth" ? "Gmail" : "Google Calendar"}…`);
    console.log(dim(start.redirect_url) + "\n");
    openBrowser(start.redirect_url);

    process.stdout.write("Waiting for you to finish in the browser");
    for (let i = 0; i < 150; i++) {   // ~5 min at 2s
      await sleep(2000);
      process.stdout.write(".");
      const s = await api.get("/api/connect/composio/status", { provider: name, connection_request_id: start.connection_request_id });
      if (s?.status === "connected") { console.log("\n✓ Connected. Your history is backfilling now and new events will flow in automatically."); return; }
      if (s?.status === "failed") { console.log("\n✗ Google didn't approve the connection. Run the command again to retry."); process.exit(1); }
    }
    console.log("\nStill pending. If you finished in the browser, run the command again — it will pick up the active connection.");
  });

// freshly minted API key is saved to ~/.nous/config.json. No copy-paste. Shared
// by `nous login` and `nous init`.
// ---------------------------------------------------------------------------
async function browserLogin(url, opts = {}) {
  const apiUrl = url || process.env.NOUS_API_URL || readConfig().apiUrl || "https://api.opennous.cloud";
  // Default = plain browser sign-in. With { startPath, startBody } it redeems a team
  // join token instead (nous join): same device flow, different start endpoint.
  const startPath = opts.startPath || "/api/cli/auth/start";
  const startBody = opts.startBody ? JSON.stringify(opts.startBody) : "{}";

  let start;
  try {
    const r = await fetch(`${apiUrl}${startPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: startBody,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error ? j.error.replace(/_/g, " ") : `server returned ${r.status}`);
    }
    start = await r.json();
  } catch (e) {
    console.error(`Couldn't start: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nOpening your browser to sign in. If it doesn't open, visit:\n  ${start.verification_uri_complete}\n`);
  openBrowser(start.verification_uri_complete);

  const interval = (start.interval || 4) * 1000;
  const deadline = Date.now() + (start.expires_in || 600) * 1000;
  process.stdout.write("Waiting for you to approve in the browser");

  while (Date.now() < deadline) {
    await sleep(interval);
    process.stdout.write(".");
    let j = {};
    try {
      const r = await fetch(`${apiUrl}/api/cli/auth/poll`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code }),
      });
      j = await r.json().catch(() => ({}));
    } catch { continue; }

    if (j.status === "approved" && j.api_key) {
      const cfg = readConfig();
      cfg.apiKey = j.api_key;
      cfg.apiUrl = apiUrl;
      writeConfig(cfg);
      const who = await fetchWhoami(apiUrl, j.api_key);
      console.log(`\n\n  ${green("✓")} ${bold("Signed in")}${who ? ` as ${identityLine(who)}` : ""}`);
      console.log(`  ${dim("Key saved to ~/.nous/config.json")}\n`);
      return true;
    }
    if (j.status === "denied")  { console.log("\nAuthorization was denied."); process.exit(1); }
    if (j.status === "expired") { console.log("\nThis sign-in expired. Run it again."); process.exit(1); }
  }
  console.log("\nTimed out waiting for approval. Run it again.");
  process.exit(1);
}

program
  .command("login")
  .description("Sign in with your browser and save an API key (no copy-paste)")
  .option("--url <url>", "API base URL (default: https://api.opennous.cloud)")
  .action(async ({ url }) => {
    await browserLogin(url);
    printNextSteps();
  });

program
  .command("join <token>")
  .description("Join a team with an invite/join token and set up your own scoped workspace")
  .option("--url <url>", "API base URL (default: https://api.opennous.cloud)")
  .action(async (token, { url }) => {
    await browserLogin(url, { startPath: "/api/cli/auth/join/start", startBody: { token } });
    console.log(`  ${dim("You're in — your agent now has its own member-scoped workspace.")}\n`);
    printNextSteps();
  });

// ---------------------------------------------------------------------------
// Connect OpenNous to whatever agent is on this machine — host-aware.
//
// The MCP server (7 primitives) is the universal capability: any MCP host runs `npx @opennous/mcp`.
// But the SKILLS + routing are the product surface, and those are delivered per host:
//   • Claude Code  → the OpenNous PLUGIN (skills + routing hooks + the trimmed MCP, one install).
//   • Any other host (Cursor, Codex, Claude Desktop, …) → the trimmed MCP via a `.mcp.json`;
//     each host's skills pack ships as we light it up.
// So `init` installs the plugin on Claude Code, and writes the MCP config everywhere else — one
// signup, the right shell per host, the same 7-primitive surface (NOUS_SURFACE=plugin) throughout.
//
// The MCP resolves its key from ~/.nous/config.json on every call, so we never bake the
// key into any of these configs — sign-in already wrote it there.
// ---------------------------------------------------------------------------

const MCP_CMD = "npx";
const MCP_ARGS = ["-y", "@opennous/mcp"];

/** Is the `claude` CLI on PATH? Then registration is one command and needs no file. */
function hasClaudeCli() {
  try {
    const r = spawnSync("claude", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

/** Merge a `nous` server into a JSON MCP config file (Claude Code / Cursor shape). */
function writeJsonMcp(path, apiUrl) {
  let cfg = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { cfg = {}; }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.opennous = {
    command: MCP_CMD,
    args: MCP_ARGS,
    // NOUS_SURFACE=plugin trims to the 7 revenue primitives (never the full internal toolset).
    // Only pin a non-default API URL (self-host); cloud reads the key from ~/.nous/config.json.
    env: {
      NOUS_SURFACE: "plugin",
      ...(apiUrl && apiUrl !== "https://api.opennous.cloud" ? { NOUS_API_URL: apiUrl } : {}),
    },
  };
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Register the MCP server with the agent on this machine. Returns a short line describing
 * what happened, for the caller to print.
 *
 * Order of preference:
 *   1. `claude mcp add` if the Claude CLI is here — one command, no file to manage.
 *   2. Write ./.mcp.json in the current project (Claude Code and most clients read it).
 * We never fail the flow on this — a printed fallback is better than an abort.
 */
const PLUGIN_MARKETPLACE = "NousC/revenue-plugin";
const PLUGIN_ID = "opennous@opennous";

// Claude Code → install the OpenNous PLUGIN (skills + routing hooks + the trimmed MCP, in one).
// We try the plugin CLI; if this Claude build has no `plugin` subcommand it returns null and the
// caller prints the two slash-commands instead. We deliberately do NOT fall back to a bare
// `claude mcp add` — a standalone MCP server would duplicate the plugin's and drop the skills.
function installClaudePlugin() {
  const add = spawnSync("claude", ["plugin", "marketplace", "add", PLUGIN_MARKETPLACE], { stdio: "ignore" });
  if (add.status !== 0 && add.status !== null) { /* non-zero: try install anyway, marketplace may already be added */ }
  const inst = spawnSync("claude", ["plugin", "install", PLUGIN_ID], { stdio: "ignore" });
  return inst.status === 0;
}

// Any other MCP host (Cursor, Codex, Claude Desktop, …) → the trimmed MCP server via a .mcp.json
// any MCP host reads. Skills for those hosts arrive as their own packs (roadmap).
function registerMcpServer(apiUrl) {
  const path = join(process.cwd(), ".mcp.json");
  writeJsonMcp(path, apiUrl);
  return `Wrote ${path} — your agent will pick up OpenNous (7 primitives) from it.`;
}

// Install the ICP auto-sync hook into the project's Claude Code config. Once in place,
// editing a Nous context file (context/**/icp.md, etc.) reminds the agent to call
// sync_icp that turn — because an edited ICP file is INERT until synced into the graph.
// Copies our packaged hook script into .claude/hooks/ and merges the PostToolUse entry
// into .claude/settings.json WITHOUT clobbering any existing hooks or settings.
// Returns true if it was already installed. Uses the exec (args) form so there's no
// shell/quoting difference between Windows PowerShell and macOS/Linux bash.
function installIcpSyncHook() {
  const claudeDir = join(process.cwd(), ".claude");
  const hooksDir = join(claudeDir, "hooks");
  const scriptPath = join(hooksDir, "icp-sync-reminder.mjs");
  const settingsPath = join(claudeDir, "settings.json");

  const src = readFileSync(new URL("./hooks/icp-sync-reminder.mjs", import.meta.url), "utf8");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(scriptPath, src);

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) || {}; } catch { settings = {}; }
  }
  settings.hooks = settings.hooks || {};
  const post = settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
  const already = post.some((e) => (e.hooks || []).some((h) =>
    (Array.isArray(h.args) && h.args.some((a) => String(a).includes("icp-sync-reminder"))) ||
    String(h.command || "").includes("icp-sync-reminder")));
  if (!already) {
    post.push({
      matcher: "Write|Edit|MultiEdit",
      hooks: [{ type: "command", command: "node", args: [scriptPath], timeout: 10 }],
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
  return already;
}

// nous init — the one-line "get started": sign in, register the MCP, hand off to the agent.
// This is the command the install script and the marketing site point to.
program
  .command("init")
  .description("Get started — sign in and connect Nous to your agent")
  .option("--url <url>", "API base URL (default: https://api.opennous.cloud)")
  .option("--no-register", "Skip registering the MCP server (just sign in)")
  .action(async ({ url, register }) => {
    await browserLogin(url);

    const apiUrl = url || readConfig().apiUrl || "https://api.opennous.cloud";
    if (register !== false) {
      // Claude Code → the plugin (skills + hooks + trimmed MCP). Any other host → the MCP config.
      if (hasClaudeCli()) {
        let installed = false;
        try { installed = installClaudePlugin(); } catch { /* fall through to instructions */ }
        if (installed) {
          console.log("\n✓ Installed the OpenNous plugin into Claude Code — skills, routing, and the 8 primitives.");
          console.log("  Open Claude Code and OpenNous starts onboarding automatically.");
          console.log(dim("  (Already have it open? Start a new session so the skills load.)"));
        } else {
          console.log("\nDetected Claude Code. Install the OpenNous plugin (skills + hooks + tools):");
          console.log("  /plugin marketplace add NousC/revenue-plugin");
          console.log("  /plugin install opennous@opennous");
          console.log(dim("  Then open Claude Code — OpenNous starts onboarding on its own."));
        }
      } else {
        try {
          console.log(`\n${registerMcpServer(apiUrl)}`);
        } catch {
          console.log("\nCouldn't write .mcp.json automatically. Add OpenNous to your host's MCP config:");
          console.log(`  command: ${MCP_CMD}  args: ${MCP_ARGS.join(" ")}  env: NOUS_SURFACE=plugin`);
        }
      }

      // Auto-sync the ICP: a Claude Code hook so editing your ICP file reminds the
      // agent to sync it into Nous (the file is inert until synced). Best-effort —
      // a convenience, never a reason to fail setup.
      try {
        const already = installIcpSyncHook();
        if (!already) console.log("Installed the ICP auto-sync hook — edits to your ICP file now sync to Nous automatically.");
      } catch { /* non-fatal */ }
    }

    console.log("\n✅ Signed in. Open Claude Code — OpenNous will walk you through onboarding on its own.");
    console.log("\n" + dim("Docs: https://docs.opennous.cloud/mcp/introduction"));
  });

// nous pull — write the Vault into ./context/*.md and hand authorship to the repo.
//
// The bridge for the Google road. A user who set up in the browser has a Vault whose author
// is Nous (source 'nous', no file). The day they open a repo and connect an agent, that
// arrangement is backwards: they now live in files, and the Vault should mirror the files,
// not the other way round. `pull` flips it — it writes each context doc to disk and re-syncs
// it WITH its path, which sets source='claude_code'. From then on their repo is the author,
// exactly as if they'd started on the agent road.
//
// It only touches slots that exist, and by default won't clobber a file that's already there
// (the repo, once it's the author, wins) unless you pass --force.
const PULL_KINDS = { icp: "icp.md" };

program
  .command("pull")
  .description("Write your Nous context docs into ./context and let your repo own them")
  .option("--dir <path>", "Where to write the context/ folder (default: cwd)", process.cwd())
  .option("--force", "Overwrite files that already exist", false)
  .action(async ({ dir, force }) => {
    const api = apiClient();
    const { foundations } = await api.get("/v2/foundations");
    const docs = (foundations || []).filter((p) => PULL_KINDS[p.kind] && (p.body_md || "").trim());
    if (!docs.length) {
      console.log("Nothing to pull — your Vault has no context docs yet. Set one up in the app first.");
      return;
    }

    const ctxDir = join(resolve(dir), "context");
    if (!existsSync(ctxDir)) mkdirSync(ctxDir, { recursive: true });

    let written = 0, skipped = 0, synced = 0;
    for (const p of docs) {
      const rel = join("context", PULL_KINDS[p.kind]);
      const abs = join(resolve(dir), rel);
      if (existsSync(abs) && !force) {
        console.log(dim(`  skip  ${rel} (exists — pass --force to overwrite)`));
        skipped++;
        continue;
      }
      writeFileSync(abs, p.body_md.trim() + "\n");
      written++;
      console.log(`  write ${rel}`);
      // Re-sync WITH the path so the graph now knows the repo is the author.
      try {
        await api.post(`/v2/foundations/${p.kind}`, { body_md: p.body_md, file_path: rel });
        synced++;
      } catch { /* the file is written; a failed authorship flip is non-fatal, re-run pull */ }
    }

    console.log(`\n✓ ${written} written${skipped ? `, ${skipped} skipped` : ""}. Your repo now owns your context.`);
    if (synced < written) console.log(dim("  (some didn't sync back — re-run `nous pull` to finish)"));
    console.log(dim("Edit these files and your agent syncs them with sync_foundation. Nous mirrors them."));
  });

// nous logout — top-level alias of `auth logout`. Removes the saved API key.
program
  .command("logout")
  .description("Sign out — remove the saved API key")
  .action(() => {
    const cfg = readConfig();
    if (!cfg.apiKey) { console.log("Not signed in."); return; }
    delete cfg.apiKey;
    writeConfig(cfg);
    console.log("✓ Signed out — removed the saved API key from ~/.nous/config.json");
  });

// ---------------------------------------------------------------------------
program.name("nous").version("0.12.0").parse();
