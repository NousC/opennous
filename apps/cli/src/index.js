#!/usr/bin/env node

// Nous CLI — a thin client of the v2 Context API.
//
// You read engineered, epistemics-tagged context and write observations.
// You never overwrite — Nous derives the facts.

import { program, Command } from "commander";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { spawn, spawnSync } from "child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recede, don't decorate. Secondary text in a terminal should be readable and
// quiet — and it must degrade to plain text when the output is piped, because a
// CI log full of escape codes is worse than no colour at all.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (t) => (COLOR ? `\x1b[2m${t}\x1b[0m` : t);

// Best-effort open the user's browser; if it fails they have the printed URL.
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
            : process.platform === "win32" ? "start"
            : "xdg-open";
  try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* printed URL is the fallback */ }
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

// A name that matches several entities comes back as { status: 'ambiguous' }.
// Print the candidates and stop — the caller re-runs with a precise focus.
function handleAmbiguous(r) {
  if (r && r.status === "ambiguous") {
    console.log("Several entities match that focus — re-run with one of:");
    for (const c of r.candidates ?? []) {
      const detail = c.detail ? ` — ${c.detail}` : "";
      console.log(`  ${c.name || "(unnamed)"}${detail}  [${c.entity_id}]`);
    }
    return true;
  }
  return false;
}

// --value accepts JSON ('{"description":"…"}') or a bare string.
function parseValue(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// nous install — drop a starter Nous integration into the current project
// ---------------------------------------------------------------------------
// Detects the framework, asks for the API key, writes a single module with the
// helpers wired (signup tracking + Stripe webhook handler + generic track()),
// and prints exactly where the user has to hook it up.
//
// No magic — everything is plain code the user can read and edit. The CLI's job
// is to save them the 30 minutes of writing it from scratch and to make sure
// the event names match what the Nous UI expects.

function detectStack(root) {
  // Returns one of: "next", "node-esm", "node-cjs", "python", "unknown"
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return "next";
      if (pkg.type === "module") return "node-esm";
      return "node-cjs";
    } catch { /* fall through */ }
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    return "python";
  }
  return "unknown";
}

function prompt(question, fallback) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + (fallback ? ` [${fallback}] ` : " "), answer => {
      rl.close();
      resolve(answer.trim() || fallback || "");
    });
  });
}

const TEMPLATES = {
  // Node ESM template — works for raw Express, Fastify, Hono, anything that
  // accepts async functions with the request body. The user wires the import
  // into whichever route handles signups + Stripe.
  "node-esm": `// Nous event tracking. Generated by \`nous install\`.
// Edit freely — this is just a starting point.

const NOUS_API_URL = process.env.NOUS_API_URL || "https://api.opennous.cloud";
const NOUS_API_KEY = process.env.NOUS_API_KEY;

async function postObservations(focus, observations) {
  if (!NOUS_API_KEY) { console.warn("[NOUS] NOUS_API_KEY not set, skipping"); return; }
  try {
    const res = await fetch(\`\${NOUS_API_URL}/v2/observations\`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: \`Bearer \${NOUS_API_KEY}\` },
      body: JSON.stringify({ focus, observations }),
    });
    if (!res.ok) console.error("[NOUS] observation failed:", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.error("[NOUS] observation error:", err.message);
  }
}

// Call this right after a new user account is created in your auth flow.
export async function trackSignup({ email, first_name = null, last_name = null, company = null, plan = "free", source }) {
  if (!email) return;
  await postObservations(email, [
    { kind: "event", property: "interaction.signed_up",
      value: { plan, source: source || "your-app", first_name, last_name, company, at: new Date().toISOString() } },
    { kind: "state", property: "stage", value: plan === "free" ? "Free User" : "Trial" },
    ...(company ? [{ kind: "state", property: "company", value: company }] : []),
  ]);
}

// Mount this on your Stripe webhook handler. Expects a Stripe Event object.
export async function handleStripeEvent(event, { customerEmail }) {
  if (!customerEmail) return;
  const sub = event.data?.object;
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    if (sub?.status !== "active") return;
    const price = sub.items?.data?.[0]?.price;
    await postObservations(customerEmail, [
      { kind: "event",
        property: event.type === "customer.subscription.created"
          ? "interaction.subscription_started"
          : "interaction.subscription_updated",
        value: {
          source: "stripe", plan: sub.metadata?.plan_id || price?.lookup_key || null, status: sub.status,
          amount: price?.unit_amount ? price.unit_amount / 100 : null, currency: sub.currency || null,
          stripe_subscription_id: sub.id, at: new Date().toISOString(),
        } },
      { kind: "state", property: "stage", value: "Customer" },
      { kind: "state", property: "plan", value: sub.metadata?.plan_id || price?.lookup_key || null },
    ]);
    return;
  }
  if (event.type === "customer.subscription.deleted") {
    await postObservations(customerEmail, [
      { kind: "event", property: "interaction.subscription_canceled",
        value: { source: "stripe", stripe_subscription_id: sub?.id, at: new Date().toISOString() } },
      { kind: "state", property: "stage", value: "Churned" },
    ]);
  }
}

// Escape hatch for any other event you want to land on the timeline.
export async function track(focus, property, value = {}) {
  await postObservations(focus, [{ kind: "event", property, value: { ...value, at: new Date().toISOString() } }]);
}
`,

  python: `# Nous event tracking. Generated by \`nous install\`.
# Edit freely — this is just a starting point.
import os
import urllib.request
import json
from datetime import datetime, timezone

NOUS_API_URL = os.getenv("NOUS_API_URL", "https://api.opennous.cloud")
NOUS_API_KEY = os.getenv("NOUS_API_KEY")

def _post(focus, observations):
    if not NOUS_API_KEY:
        print("[NOUS] NOUS_API_KEY not set, skipping")
        return
    body = json.dumps({"focus": focus, "observations": observations}).encode()
    req = urllib.request.Request(
        f"{NOUS_API_URL}/v2/observations", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {NOUS_API_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            if r.status >= 400: print("[NOUS] observation failed:", r.status)
    except Exception as e:
        print("[NOUS] observation error:", e)

def track_signup(email, *, first_name=None, last_name=None, company=None, plan="free", source="your-app"):
    if not email: return
    now = datetime.now(timezone.utc).isoformat()
    _post(email, [
        {"kind":"event","property":"interaction.signed_up",
         "value":{"plan":plan,"source":source,"first_name":first_name,"last_name":last_name,"company":company,"at":now}},
        {"kind":"state","property":"stage","value":"Free User" if plan=="free" else "Trial"},
        *([{"kind":"state","property":"company","value":company}] if company else []),
    ])

def handle_stripe_event(event, customer_email):
    if not customer_email: return
    sub = event.get("data", {}).get("object", {})
    t = event.get("type")
    now = datetime.now(timezone.utc).isoformat()
    if t in ("customer.subscription.created", "customer.subscription.updated"):
        if sub.get("status") != "active": return
        price = (sub.get("items", {}).get("data") or [{}])[0].get("price", {}) or {}
        _post(customer_email, [
            {"kind":"event",
             "property":"interaction.subscription_started" if t.endswith("created") else "interaction.subscription_updated",
             "value":{"source":"stripe","plan":sub.get("metadata",{}).get("plan_id"),"status":sub.get("status"),
                      "amount":(price.get("unit_amount") or 0)/100 or None,"currency":sub.get("currency"),
                      "stripe_subscription_id":sub.get("id"),"at":now}},
            {"kind":"state","property":"stage","value":"Customer"},
        ])
    elif t == "customer.subscription.deleted":
        _post(customer_email, [
            {"kind":"event","property":"interaction.subscription_canceled",
             "value":{"source":"stripe","stripe_subscription_id":sub.get("id"),"at":now}},
            {"kind":"state","property":"stage","value":"Churned"},
        ])

def track(focus, property_, value=None):
    now = datetime.now(timezone.utc).isoformat()
    _post(focus, [{"kind":"event","property":property_,"value":{**(value or {}),"at":now}}])
`,
};

const NEXT_STEPS = {
  "node-esm": `Next steps:
  1. Set NOUS_API_KEY in your .env (see https://app.opennous.cloud/integrations).
  2. Import { trackSignup } from "./nous.js" — call it right after you persist a new user.
  3. Import { handleStripeEvent } in your Stripe webhook route — call it after verifying the signature.
  4. Use track(email, "interaction.<your_event>", {...}) for anything else.`,
  "node-cjs": `Next steps:
  1. Set NOUS_API_KEY in your .env (see https://app.opennous.cloud/integrations).
  2. const { trackSignup, handleStripeEvent, track } = require("./nous.js");
  3. Call trackSignup() after persisting a new user; handleStripeEvent() inside your Stripe webhook.`,
  next: `Next steps:
  1. Set NOUS_API_KEY in your .env (see https://app.opennous.cloud/integrations).
  2. Inside your signup API route, await trackSignup({ email, ... }) after the user row is written.
  3. Inside app/api/webhooks/stripe/route.ts (or pages/api/webhooks/stripe.ts), await handleStripeEvent(event, { customerEmail }) after Stripe signature verification.`,
  python: `Next steps:
  1. Set NOUS_API_KEY in your .env (see https://app.opennous.cloud/integrations).
  2. from nous import track_signup, handle_stripe_event, track — call track_signup() after persisting a new user.
  3. Call handle_stripe_event(event, customer_email) inside your Stripe webhook view.`,
};

// `nous track init` — drop event tracking into the user's app. This used to be
// `nous install`, which collided head-on with the front-door meaning of "install":
// people typed `nous install` expecting to set Nous up and got an app-instrumentation
// scaffolder instead. The front door is now `nous init`. `install` stays as a hidden
// deprecated alias so nobody's script breaks, and it prints where the command went.
const trackCmd = program
  .command("track")
  .description("Instrument your app to send events to Nous");

function defineTrackInit(cmd) {
  return cmd
  .description("Drop Nous event tracking (signups + Stripe lifecycle) into the current project")
  .option("--dir <path>", "Target project directory (default: cwd)", process.cwd())
  .option("--lang <stack>", "Force language/stack: next | node-esm | node-cjs | python")
  .option("--key <key>", "API key (otherwise prompted)")
  .option("--yes", "Skip prompts and use defaults", false)
  .action(async ({ dir, lang, key, yes }) => {
    const root = resolve(dir);
    if (!existsSync(root)) {
      console.error(`Directory not found: ${root}`);
      process.exit(1);
    }

    const detected = lang || detectStack(root);
    const stack = (detected === "unknown") ? "node-esm" : detected;
    const templateKey = stack === "next" ? "node-esm" : (stack === "node-cjs" ? "node-esm" : stack);
    const template = TEMPLATES[templateKey];
    if (!template) {
      console.error(`No template for stack: ${stack}. Use --lang next|node-esm|node-cjs|python.`);
      process.exit(1);
    }

    const outFile = stack === "python" ? "nous.py" : "nous.js";
    const outPath = join(root, outFile);

    if (existsSync(outPath) && !yes) {
      const answer = await prompt(`${outFile} already exists. Overwrite? (y/N)`, "N");
      if (!answer.toLowerCase().startsWith("y")) {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    let apiKey = key || process.env.NOUS_API_KEY || readConfig().apiKey;
    if (!apiKey && !yes) {
      apiKey = await prompt("Paste your Nous API key (or press Enter to skip and set NOUS_API_KEY later):", "");
    }

    writeFileSync(outPath, template);

    // Append NOUS_API_KEY to .env if not already there.
    const envPath = join(root, ".env");
    let envTouched = false;
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, "utf8");
      if (!/^NOUS_API_KEY\s*=/m.test(env)) {
        appendFileSync(envPath, `\n# Nous event tracking (https://app.opennous.cloud)\nNOUS_API_KEY=${apiKey || ""}\n`);
        envTouched = true;
      }
    } else if (apiKey) {
      writeFileSync(envPath, `# Nous event tracking (https://app.opennous.cloud)\nNOUS_API_KEY=${apiKey}\n`);
      envTouched = true;
    }

    console.log(`\n✓ Wrote ${outFile}`);
    if (envTouched) console.log(`✓ Updated .env`);
    console.log(`\nDetected stack: ${stack}`);
    console.log(`\n${NEXT_STEPS[stack] || NEXT_STEPS["node-esm"]}\n`);
  });
}

// The real command: `nous track init`.
defineTrackInit(trackCmd.command("init"));

// Deprecated alias: `nous install`. Kept so existing scripts don't break; it does the
// same thing but says where it moved, because "install" is now `nous init`.
defineTrackInit(program.command("install"))
  .hook("preAction", () => {
    console.error(dim("note: `nous install` is now `nous track init`. Run `nous init` to set up Nous itself.\n"));
  });

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
// nous context <focus> — engineered, intent-shaped context for a task
// ---------------------------------------------------------------------------
program
  .command("context <focus>")
  .description("Engineered context for a task about one person or company")
  .option(
    "--intent <intent>",
    "draft_email | follow_up | meeting_prep | call_prep | account_review",
    "account_review"
  )
  .option("--budget <tokens>", "Token budget for the assembled context")
  .option("--json", "Print the raw JSON response")
  .action(async (focus, { intent, budget, json }) => {
    const api = apiClient();
    const ctx = await api.post("/v2/context", {
      focus,
      intent,
      budget_tokens: budget ? Number(budget) : undefined,
    });
    if (handleAmbiguous(ctx)) return;
    if (json) {
      console.log(JSON.stringify(ctx, null, 2));
      return;
    }
    const lines = [`${ctx.entity.type} ${ctx.entity.id}  ·  intent: ${ctx.intent}`];
    if (ctx.summary) lines.push(`\n${ctx.summary}`);
    if (ctx.claims?.length) {
      lines.push(`\nClaims:`);
      ctx.claims.forEach(c => {
        const val = typeof c.value === "object" ? JSON.stringify(c.value) : c.value;
        lines.push(
          `  ${c.property} = ${val}  (${c.epistemic_class}, ${c.freshness}, ` +
            `conf ${Math.round((c.confidence ?? 0) * 100)}%)`
        );
      });
    }
    if (ctx.timeline?.length) {
      lines.push(`\nTimeline:`);
      ctx.timeline.slice(0, 8).forEach(t => {
        const when = t.when ? new Date(t.when).toLocaleDateString() : "";
        const detail = t.summary ? `: ${t.summary}` : t.count ? ` ×${t.count}` : "";
        lines.push(`  ${when} — ${t.type}${detail}`);
      });
    }
    if (ctx.stakeholders?.length) {
      lines.push(`\nStakeholders:`);
      ctx.stakeholders.forEach(s =>
        lines.push(`  ${s.name || s.entity_id}${s.role ? ` — ${s.role}` : ""}`)
      );
    }
    lines.push(`\n~${ctx.meta?.token_estimate ?? "?"} tokens`);
    console.log(lines.join("\n"));
  });

// ---------------------------------------------------------------------------
// nous account <focus> — the full record: every claim + its epistemics
// ---------------------------------------------------------------------------
program
  .command("account <focus>")
  .description("The full account record — every claim with its epistemics + timeline")
  .option("--json", "Print the raw JSON response")
  .action(async (focus, { json }) => {
    const api = apiClient();
    const rec = await api.get(`/v2/accounts/${encodeURIComponent(focus)}`);
    if (handleAmbiguous(rec)) return;
    if (json) {
      console.log(JSON.stringify(rec, null, 2));
      return;
    }
    const lines = [`${rec.type} ${rec.entity_id}`];
    const claims = Object.entries(rec.claims ?? {});
    if (claims.length) {
      lines.push(`\nClaims:`);
      claims.forEach(([prop, c]) => {
        const val = typeof c.value === "object" ? JSON.stringify(c.value) : c.value;
        lines.push(
          `  ${prop} = ${val}  (${c.epistemic_class}, ${c.freshness}, ` +
            `conf ${Math.round((c.confidence ?? 0) * 100)}%)`
        );
      });
    }
    const obs = rec.recent_observations ?? [];
    if (obs.length) {
      lines.push(`\nRecent observations:`);
      obs.slice(0, 10).forEach(o => {
        const when = o.observed_at ? new Date(o.observed_at).toLocaleDateString() : "";
        lines.push(`  ${when} — [${o.kind}] ${o.property}  (${o.source})`);
      });
    }
    console.log(lines.join("\n"));
  });

// ---------------------------------------------------------------------------
// nous record <focus> — observe what happened; Nous derives the facts
// ---------------------------------------------------------------------------
program
  .command("record <focus>")
  .description("Record an observation. You observe — Nous derives the claims.")
  .requiredOption("--kind <kind>", "event | state")
  .requiredOption("--property <property>", "e.g. interaction.email_sent or job_title")
  .option("--value <value>", "The event detail or fact value (JSON or string)")
  .option("--source <source>", "Where this came from", "cli")
  .option("--method <method>", "How it was observed")
  .option("--observed-at <iso>", "When it was observed (ISO 8601)")
  .action(async (focus, opts) => {
    const api = apiClient();
    const observation = {
      kind: opts.kind,
      property: opts.property,
      value: parseValue(opts.value),
      source: opts.source,
      method: opts.method,
      observed_at: opts.observedAt,
    };
    const result = await api.post("/v2/observations", { focus, observations: [observation] });
    if (handleAmbiguous(result)) return;
    const recomputed = result.claims_recomputed ?? [];
    console.log(
      `✓ Recorded ${result.recorded} observation(s) for ${result.entity_id}` +
        (recomputed.length ? `\n  Claims recomputed: ${recomputed.join(", ")}` : "")
    );
  });

// ---------------------------------------------------------------------------
// nous query — retrieve and summarise a corpus of activity across many people
// ---------------------------------------------------------------------------
program
  .command("query")
  .description("Retrieve and summarise activity across many people")
  .option("--kind <kind>", "event | state")
  .option("--property <prefix>", "Property prefix — e.g. interaction.linkedin")
  .option("--source <source>", "Filter by source")
  .option("--entity <id>", "Restrict to one entity")
  .option("--since <days>", "Look back this many days")
  .option("--limit <n>", "Max results", "20")
  .option("--question <text>", "A question — switches to semantic retrieval")
  .option("--json", "Print the raw JSON response")
  .action(async opts => {
    const api = apiClient();
    const scope = {
      kind: opts.kind,
      property: opts.property,
      source: opts.source,
      entity_id: opts.entity,
      since_days: opts.since ? Number(opts.since) : undefined,
      limit: opts.limit ? Number(opts.limit) : undefined,
    };
    const data = await api.post("/v2/query", { scope, question: opts.question });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data.items ?? [];
    if (!items.length) {
      console.log("No matching activity.");
      return;
    }
    items.forEach(it => {
      const when = it.when ? new Date(it.when).toLocaleDateString() : "";
      const who = it.entity_name || it.entity_id;
      const sim = it.similarity != null ? `  ${Math.round(it.similarity * 100)}%` : "";
      console.log(`  ${when} — ${who} — ${it.type}${sim}${it.summary ? `: ${it.summary}` : ""}`);
    });
    console.log(
      `\n${data.returned} of ${data.matched} (${data.mode})` +
        (data.sampled ? " — sampled" : "")
    );
  });

// ---------------------------------------------------------------------------
// nous attention — what needs attention across the workspace
// ---------------------------------------------------------------------------
program
  .command("attention")
  .description("Accounts gone quiet, facts decayed — ranked, with suggested actions")
  .option("--limit <n>", "Max results", "20")
  .option("--json", "Print the raw JSON response")
  .action(async ({ limit, json }) => {
    const api = apiClient();
    const data = await api.get("/v2/attention", { limit });
    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    const items = data.items ?? [];
    if (!items.length) {
      console.log("Nothing needs attention. ✓");
      return;
    }
    items.forEach(it => {
      const who = it.entity_name || it.entity_id;
      console.log(`  [${it.kind}] ${who} — ${it.what} (${it.age_days}d)`);
      console.log(`     → ${it.suggested_action}`);
    });
  });

// ---------------------------------------------------------------------------
// nous audit — is this graph actually sound?
//
// The command that answers the only question a technical team has before trusting
// data they didn't collect themselves. It is deliberately a COMMAND and not a
// dashboard: a dashboard makes a claim about our own product and asks you to
// believe it; a command runs against your data, in your terminal, and returns an
// exit code. One of those can fail a build.
// ---------------------------------------------------------------------------
program
  .command("audit")
  .description("Audit your GTM data — what's broken, what's unsure, and what to do about it")
  .option("--check <name>", "One check only: arriving, resolved, evidenced, current, reachable")
  .option("--list", "List the records behind each finding")
  .option("--fail-under <n>", "Exit 1 if health is below this percentage — for CI")
  .option("--fix", "Show the repairs that can be made safely, without making them")
  .option("--apply", "Actually make them (use with --fix)")
  .option("--json", "Print the raw JSON response")
  .action(async ({ check, list, failUnder, fix, apply, json }) => {
    const api = apiClient();

    // ── nous audit --fix ──
    //
    // Only the repairs that need no judgment: records sharing an email or a
    // LinkedIn profile are the same human by definition. Everything else the audit
    // finds needs a decision, a browser, or you — and a --fix that quietly did
    // those too would be one nobody could trust.
    if (fix) {
      const out = await api.post("/v2/audit/fix", { apply: !!apply });
      if (json) { console.log(JSON.stringify(out, null, 2)); return; }

      if (out.dry_run) {
        if (!out.would_merge) {
          console.log("\n  Nothing to repair automatically.\n");
          return;
        }
        console.log(`\n  ${out.would_merge} ${out.would_merge === 1 ? "merge" : "merges"} can be made safely:\n`);
        for (const m of out.merges) {
          console.log(`    · ${m.who ?? m.keep}  ${dim("— " + m.why)}`);
        }
        console.log(dim("\n  Nothing changed. Re-run with --fix --apply to make them.\n"));
        return;
      }

      console.log(`\n  Merged ${out.merged}.${out.failed ? `  ${out.failed} failed.` : ""}\n`);
      for (const f of out.failures ?? []) console.error(`    ✗ ${f.who ?? f.keep}: ${f.error}`);
      if (out.failed) process.exit(1);
      return;
    }

    const data = await api.get("/v2/audit", check ? { check } : {});

    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const checks = check ? [data.check] : data.checks;
      const findings = data.findings ?? [];

      console.log("");
      for (const c of checks) {
        const pct = String(c.pct).padStart(4);
        const mark = c.pct === 100 ? "\u2713" : "\u2717";
        console.log(`  ${pct}%  ${c.label.toUpperCase().padEnd(11)} ${c.summary}  ${mark}`);
        // What we deliberately did not count. An audit cannot itself be a black box.
        if (c.note) console.log(`         ${dim(c.note)}`);
      }

      if (!findings.length) {
        console.log("\n  Nothing to fix.\n");
      } else {
        console.log("");
        for (const f of findings) {
          console.log(`  [${f.severity.toUpperCase()}] ${f.title}`);
          console.log(`         ${dim(f.detail)}`);
          // Who can fix it, said plainly. Pretending we can re-authorise someone's
          // Gmail is how a tool loses trust the first time it fails to.
          const by = f.fixable_by === "human"
            ? "needs you"
            : f.fixable_by === "agent_with_confirmation"
              ? "the agent, once you confirm"
              : "the agent";
          console.log(`         \u2192 ${f.fix}  (${by})`);

          if (list && f.subjects?.length) {
            for (const sub of f.subjects.slice(0, 20)) {
              const line = sub.who
                ? (Array.isArray(sub.who) ? sub.who.join("  \u2194  ") : sub.who)
                : Object.entries(sub).map(([k, v]) => `${k}=${v}`).join(" ");
              console.log(`           \u00b7 ${line}${sub.why ? dim("  — " + sub.why) : ""}`);
            }
            if (f.subjects.length > 20) {
              console.log(`           \u00b7 ${dim(`and ${f.subjects.length - 20} more`)}`);
            }
          }
          console.log("");
        }
        if (!list) console.log(dim("  Add --list to see the records behind each finding.\n"));
      }
    }

    // The reason this is a command. An exit code can stop a deploy; a dashboard
    // cannot. You would have known about a dead connector on day one, not day 48.
    const health = check ? data.check.pct : data.health;
    if (failUnder !== undefined) {
      const floor = Number(failUnder);
      if (health < floor) {
        console.error(`\n  FAIL: health ${health}% is below the threshold of ${floor}%\n`);
        process.exit(1);
      }
    }
  });

// ---------------------------------------------------------------------------
// nous verify <focus> <property> — re-check a claim before acting on it
// ---------------------------------------------------------------------------
program
  .command("verify <focus> <property>")
  .description("Re-check a claim before acting on it — the calibration check")
  .action(async (focus, property) => {
    const api = apiClient();
    const r = await api.post("/v2/verify", { focus, property });
    if (handleAmbiguous(r)) return;
    const fmt = c =>
      c
        ? `${typeof c.value === "object" ? JSON.stringify(c.value) : c.value} ` +
          `(${c.freshness}, conf ${Math.round((c.confidence ?? 0) * 100)}%)`
        : "—";
    console.log(`${r.property}`);
    console.log(`  before: ${fmt(r.before)}`);
    console.log(`  after:  ${fmt(r.after)}`);
    if (r.note) console.log(`  ${r.note}`);
  });

// ---------------------------------------------------------------------------
// nous classify — pre-flight cold-outbound dedup
// ---------------------------------------------------------------------------
program
  .command("classify")
  .description("Pre-flight dedup a list of emails and/or LinkedIn URLs against the workspace's engagement history")
  .option("--emails <list>", "Comma-separated emails")
  .option("--linkedin <list>", "Comma-separated LinkedIn URLs")
  .option("--file <path>", "Path to any text/CSV — both emails and LinkedIn URLs are auto-extracted")
  .option("--json", "Print the raw JSON response")
  .action(async ({ emails, linkedin, file, json }) => {
    const api = apiClient();
    const EMAIL_RE    = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
    const LINKEDIN_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_\-%]+/gi;

    let emailList = [];
    let linkedinList = [];

    if (file) {
      const { readFileSync } = await import("fs");
      const text = readFileSync(file, "utf8");
      emailList = text.match(EMAIL_RE) || [];
      linkedinList = text.match(LINKEDIN_RE) || [];
    }
    if (emails)   emailList    = emailList.concat(emails.split(/[\s,]+/).filter(Boolean));
    if (linkedin) linkedinList = linkedinList.concat(linkedin.split(/[\s,]+/).filter(Boolean));

    emailList    = [...new Set(emailList.map(e => e.toLowerCase().trim()))].filter(Boolean);
    linkedinList = [...new Set(linkedinList.map(u => u.trim()))].filter(Boolean);

    if (!emailList.length && !linkedinList.length) {
      console.error("Pass at least one of --emails, --linkedin, or --file");
      process.exit(1);
    }

    const body = {};
    if (emailList.length)    body.emails        = emailList;
    if (linkedinList.length) body.linkedin_urls = linkedinList;

    const data = await api.post("/v2/dedup", body);
    if (json) { console.log(JSON.stringify(data, null, 2)); return; }
    const s = data.summary || {};
    const pad = (n, w = 6) => String(n).padStart(w);
    console.log(`\n  ${pad(s.total)}  total  (${emailList.length} emails, ${linkedinList.length} linkedin)`);
    console.log(`  ${pad(s.net_new)}  net_new       ← safe to send / safe to buy`);
    console.log(`  ${pad(s.engaged)}  engaged       skip (in an active convo)`);
    console.log(`  ${pad(s.recent)}  recent        defer (contacted in last 30d)`);
    console.log(`  ${pad(s.bounced)}  bounced       skip`);
    console.log(`  ${pad(s.unsubscribed)}  unsubscribed  skip`);
    console.log(`  ${pad(s.suppressed)}  suppressed    skip (workspace policy)\n`);
  });

// ---------------------------------------------------------------------------
// Browser sign-in (device authorization). Opens the browser, you approve, and a
// freshly minted API key is saved to ~/.nous/config.json. No copy-paste. Shared
// by `nous login`, `nous init`, and the plugin's /nous-login command.
// ---------------------------------------------------------------------------
async function browserLogin(url) {
  const apiUrl = url || process.env.NOUS_API_URL || readConfig().apiUrl || "https://api.opennous.cloud";

  let start;
  try {
    const r = await fetch(`${apiUrl}/api/cli/auth/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    start = await r.json();
  } catch (e) {
    console.error(`Couldn't start sign-in: ${e.message}`);
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
      console.log(`\n\n✓ Signed in. Key saved to ~/.nous/config.json`);
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
    console.log("Your Nous tools are ready — try `get_workspace_status` in your agent.");
  });

// ---------------------------------------------------------------------------
// MCP registration — connect Nous to whatever agent is on this machine.
//
// We deliberately DO NOT use the Claude Code plugin/marketplace here. Two commands
// (`/plugin marketplace add`, `/plugin install`), Claude-Code-only, with a marketplace
// standing between a new user and the product — it's too much for a first run. The MCP
// server is the whole integration, and `claude mcp add` registers it in one line.
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
  cfg.mcpServers.nous = {
    command: MCP_CMD,
    args: MCP_ARGS,
    // Only pin a non-default API URL (self-host). Cloud reads the key from the config file.
    ...(apiUrl && apiUrl !== "https://api.opennous.cloud" ? { env: { NOUS_API_URL: apiUrl } } : {}),
  };
  const dir = path.slice(0, path.lastIndexOf("/"));
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
function registerMcp(apiUrl) {
  if (hasClaudeCli()) {
    const args = ["mcp", "add", "nous", "--scope", "user"];
    if (apiUrl && apiUrl !== "https://api.opennous.cloud") args.push("-e", `NOUS_API_URL=${apiUrl}`);
    args.push("--", MCP_CMD, ...MCP_ARGS);
    const r = spawnSync("claude", args, { stdio: "ignore" });
    if (r.status === 0) return "Registered Nous with Claude Code (claude mcp add).";
    // add fails if a server named nous already exists — that's a success for our purposes.
    return "Nous is already registered with Claude Code.";
  }
  const path = join(process.cwd(), ".mcp.json");
  writeJsonMcp(path, apiUrl);
  return `Wrote ${path} — your agent will pick up Nous from it.`;
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
      try {
        console.log(`\n${registerMcp(apiUrl)}`);
      } catch (e) {
        // Never let registration take down sign-in — print the manual line instead.
        console.log("\nCouldn't register the MCP automatically. Add it with:");
        console.log(`  claude mcp add nous -- ${MCP_CMD} ${MCP_ARGS.join(" ")}`);
      }
    }

    console.log('\nYou\'re set. Tell your agent: "set up my Nous workspace" — it reads your');
    console.log("project, finds your ICP (or drafts one), and syncs it. That's onboarding.\n");
    console.log(dim("Docs: https://docs.opennous.cloud/mcp/introduction"));
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
const PULL_KINDS = { icp: "icp.md", positioning: "positioning.md", voice: "voice.md", outreach: "messaging.md" };

program
  .command("pull")
  .description("Write your Nous context docs into ./context and let your repo own them")
  .option("--dir <path>", "Where to write the context/ folder (default: cwd)", process.cwd())
  .option("--force", "Overwrite files that already exist", false)
  .action(async ({ dir, force }) => {
    const api = apiClient();
    const { playbooks } = await api.get("/v2/playbooks");
    const docs = (playbooks || []).filter((p) => PULL_KINDS[p.kind] && (p.body_md || "").trim());
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
        await api.post(`/v2/playbooks/${p.kind}`, { body_md: p.body_md, file_path: rel });
        synced++;
      } catch { /* the file is written; a failed authorship flip is non-fatal, re-run pull */ }
    }

    console.log(`\n✓ ${written} written${skipped ? `, ${skipped} skipped` : ""}. Your repo now owns your context.`);
    if (synced < written) console.log(dim("  (some didn't sync back — re-run `nous pull` to finish)"));
    console.log(dim("Edit these files and your agent syncs them with sync_playbook. Nous mirrors them."));
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
program.name("nous").version("0.7.0").parse();
