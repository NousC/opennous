/**
 * Nous MCP server factory.
 *
 * Builds an McpServer with the v2 tools registered. Both entrypoints use it:
 *   - index.js (stdio bin, published as @opennous/mcp) — one server, env-scoped key
 *   - http.js  (hosted, mcp.opennous.cloud)           — a fresh server per request,
 *                                                        key scoped via AsyncLocalStorage
 *
 * The tools are thin clients of the Context API (see client.js). The agent never
 * sees raw rows — it gets engineered, epistemics-tagged context. It never
 * "updates" — it records observations; Nous derives.
 *
 * The revenue-plugin surface — PLUGIN_TOOLS below, and nothing else. The documented core
 * (2026-09-30, one per public-API door):
 *   IDENTITY  whoami   (who the key acts as · scope · GTM role[s] · usage left)
 *   READ      find (people | accounts | deals lists) · get_context (person, account or deal) ·
 *             query · attention · get_insights
 *   WRITE     add_note · enrich · score · set_icp
 * (Cloud adds read_brain and write_brain through src/cloud/, GET-839.)
 * Legacy, still registered because plugin skills call them (retire with GET-536):
 *   get_account · deals · pages · read_page · save_page · record · record_insight · record_closed_deals
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { get, post, put, patch, del, runWithToolCall } from "./client.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Workspace layer's (Cloud) additions to the plugin surface, when this checkout carries them:
// the GTM brain (GET-839). The open-source edition has no src/cloud/ and serves without them.
const CLOUD_ENTRY = new URL("./cloud/index.js", import.meta.url);
const cloudMcp = existsSync(fileURLToPath(CLOUD_ENTRY)) ? await import(CLOUD_ENTRY.href) : null;
const CLOUD_TOOL_NAMES = cloudMcp?.toolNames ?? [];

// Public web-app URL for one-click connect deep links. OAuth providers (Gmail,
// LinkedIn) need a browser sign-in the agent can't perform headlessly, so instead
// of a dead-end the agent hands the user a link that lands on the Integrations page
// with that provider's connect flow pre-opened. Overridable via NOUS_APP_URL.
const APP_URL = () => (process.env.NOUS_APP_URL || "https://app.opennous.cloud").replace(/\/+$/, "");
// OAuth/browser-sign-in providers → the slug the Integrations page auto-opens on.
const OAUTH_CONNECT = { gmail: "gmail", gmail_oauth: "gmail", google: "gmail", "google-mail": "gmail", googlemail: "gmail", linkedin: "linkedin" };
const connectLink = (slug) => `${APP_URL()}/settings?section=integrations&connect=${slug}`;

export const SERVER_VERSION = "0.77.0";

// ─── helpers ──────────────────────────────────────────────────────────────────

function relAge(ts) {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
  if (d < 1)   return "today";
  if (d === 1) return "1d ago";
  if (d < 30)  return `${d}d ago`;
  const m = Math.floor(d / 30);
  if (m < 12)  return `${m}mo ago`;
  return `${Math.floor(m / 12)}y ago`;
}

// Absolute calendar date + clock time, in the user's local zone (this server runs
// on their machine over stdio, so toLocaleString is already local). For meetings,
// "Tue, Jun 16, 3:00 PM" beats relAge's fuzzy "today" — and relAge can't represent
// the future at all, so every scheduled call would otherwise read "today".
function fmtWhen(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

// When to show an absolute datetime vs a relative age. Meetings/calls always get
// the exact time (you need to know it's 3pm, not "today"); so does anything
// future-dated (a scheduled event), which relAge would collapse to "today".
function whenLabel(type, ts) {
  const t = String(type || "");
  const isMeeting = t.includes("meeting") || t.includes("call");
  const isFuture = ts && new Date(ts).getTime() > Date.now();
  return (isMeeting || isFuture) ? fmtWhen(ts) : relAge(ts);
}

const fmtType = (p) => (p || "").replace(/^interaction\./, "").replace(/_/g, " ");
// The EVIDENCE line under a fact: who said it, their verbatim words, and where it
// came from. This is what makes a fact checkable instead of something the user has
// to take on faith — the rep reads the actual sentence rather than trusting a
// summary. Returns [] when there is nothing to show: facts recorded before evidence
// capture shipped, and facts with nothing quotable (an attendee list, a CRM field),
// so the block degrades quietly on historical data instead of looking broken.
// "21 total, showing the 15 newest" instead of a bare "15". A read is windowed by a token
// budget, and a window that does not say so reads as the whole record: an agent that had just
// written 21 facts read 15 back, took the three it could not see as refused writes, and refiled
// them under fresh ids — permanent duplicates, no delete tool (GET-371).
function factsHeader(r) {
  const shown = r.facts?.length ?? 0;
  const total = r.meta?.facts_total ?? r.facts_total;
  return (typeof total === "number" && total > shown)
    ? `${total} total, showing the ${shown} most current`
    : String(shown);
}

// When it was said, and — once it is past fresh — whether it still holds (GET-770). The date is
// the source's (the call, the message), not when we wrote it down.
const FRESHNESS_WORD = { aging: "aging", suspect: "stale", expired: "out of date" };
function saidTag(f) {
  if (!f.date) return "";
  const day = new Date(f.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const word = FRESHNESS_WORD[f.freshness];
  return `  (said ${day} \u00b7 ${relAge(f.date)}${word ? ` \u00b7 ${word}` : ""})`;
}

const shortDay = (ts) => (ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "undated");
const clip = (s, n = 140) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// Several of these hold at once, so they print as one heading with a line each (GET-798).
const MULTI_TOPIC = { blocker: "Blockers (open)", requirement: "Requirements" };

/**
 * The facts section of get_context / get_account (GET-770, GET-798), in reading order:
 *   CURRENT POSITION: where the deal stands, one line per deal topic, every open blocker and
 *     live requirement under one heading each;
 *   TECH STACK: one line per tool, its newest fact;
 *   RECENTLY REPLACED: older claims a newer one replaced, old -> new;
 *   FACTS: everything else, current-first, each dated and marked once it may no longer hold.
 */
export function factsBlock(r) {
  const lines = [];
  const current = r.current_position ?? [];
  if (current.length) {
    lines.push("CURRENT POSITION (where the deal stands — lead with this; each line replaces anything older on the same topic):");
    const printed = new Set();
    for (const f of current) {
      const heading = MULTI_TOPIC[f.category];
      if (!heading) { lines.push(`  [${f.category}] ${f.content}${saidTag(f)}`); continue; }
      if (printed.has(f.category)) continue;
      printed.add(f.category);
      lines.push(`  ${heading}:`);
      for (const b of current.filter(x => x.category === f.category)) lines.push(`    - ${b.content}${saidTag(b)}`);
    }
    lines.push("");
  }
  const stack = r.tech_stack ?? [];
  if (stack.length) {
    lines.push("TECH STACK (one line per tool, its newest fact):");
    for (const g of stack) lines.push(`  ${g.tool} — ${g.summary}${g.facts?.[0] ? saidTag(g.facts[0]) : ""}`);
    lines.push("");
  }
  const replaced = r.recently_replaced ?? [];
  if (replaced.length) {
    lines.push("RECENTLY REPLACED (older claim → what replaced it; the old side is no longer current):");
    for (const p of replaced) {
      lines.push(`  ${shortDay(p.old?.said_at)} [${p.old?.category}] '${clip(p.old?.content)}' → ${shortDay(p.new?.said_at)} [${p.new?.category}] '${clip(p.new?.content)}'`);
    }
    lines.push("");
  }
  if (r.facts?.length) {
    lines.push(`FACTS (${factsHeader(r)} \u2014 current first; "aging", "stale" and "out of date" may no longer hold):`);
    for (const f of r.facts) {
      lines.push(`  [${f.category}] ${f.content}${saidTag(f)}`);
      for (const e of evidenceLines(f)) lines.push(e);
    }
    lines.push("");
  }
  return lines;
}

/**
 * What they asked US to build (GET-1026): product feedback, not intel about them. Its own section so
 * an agent never turns "build your own recorder" into "they are looking for a recorder", and can
 * say what was asked and when. Empty when there is none.
 */
export function featureRequestsBlock(requests) {
  if (!requests?.length) return [];
  const lines = ["FEATURE REQUESTS (what they asked us to build \u2014 our product's backlog, not a tool they are shopping for; newest first):"];
  for (const r of requests) {
    lines.push(`  ${r.what ? `${r.what}: ` : ""}${r.content}${r.occurred_at ? `  (asked ${shortDay(r.occurred_at)} \u00b7 ${relAge(r.occurred_at)}${r.source_system ? ` \u00b7 ${r.source_system}` : ""})` : ""}`);
    if (r.quote) lines.push(`      "${clip(r.quote, 200)}"`);
  }
  lines.push("");
  return lines;
}

function evidenceLines(f) {
  const out = [];
  const who = f.speaker ? String(f.speaker).trim() : "";
  const quote = f.quote ? String(f.quote).trim() : "";
  const where = [f.source, f.date ? new Date(f.date).toISOString().slice(0, 10) : null]
    .filter(Boolean).join(" \u00b7 ");
  if (quote) out.push(`      ${who ? `${who} \u00b7 ` : ""}"${quote}"`);
  else if (who) out.push(`      ${who}`);
  if (where && (quote || who)) out.push(`      ${where}`);
  // The pointer, so a document can CITE this line: save_page takes it in `sources`.
  if (f.source_ref) out.push(`      ref ${f.source_ref}`);
  return out;
}

const fmtVal  = (v) => (v != null && typeof v === "object") ? JSON.stringify(v) : String(v ?? "");
const pct     = (c) => `${Math.round((c ?? 0) * 100)}%`;

// ─── list rows (find) and the deal block (get_context) ───────────────────────

const day = (ts) => (ts ? String(ts).slice(0, 10) : null);
// A value with no currency is in dollars, as the app shows it (GET-831): "$450", never a bare
// "450" an agent then reports as "currency not recorded". Another recorded currency keeps its code.
const fmtMoney = (n, cur) => {
  if (n == null) return null;
  const v = Number(n).toLocaleString("en-US");
  return !cur || cur === "USD" || cur === "$" ? `$${v}` : `${v} ${cur}`;
};
// Win odds come back as 0-1 (null = not scored: a closed deal, or no outlook for it).
const fmtOdds = (p) => (p == null ? null : `${Math.round(p * 100)}%`);
// Until the win model is fitted on the workspace's own deals the odds are a rank, never a % (GET-832).
const fmtRowOdds = (r) => r.odds_basis === "rank" && r.win_rank != null
  ? `odds ${ordinal(r.win_rank)} of ${r.win_rank_of} open`
  : null;
const ordinal = (n) => { const t = n % 100; return `${n}${t >= 11 && t <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`; };
const stageText = (stage, canonical) =>
  stage && canonical && String(stage).toLowerCase() !== canonical.replace(/_/g, " ") ? `${stage} (${canonical})` : (stage ?? canonical ?? null);

/** One deal (the public deal shape, GET /v2/deals) as one line. */
function dealLine(d) {
  const bits = [
    d.account?.name && d.account.name !== d.name ? d.account.name : null,
    stageText(d.stage, d.canonical_stage),
    d.status,
    fmtMoney(d.amount, d.currency),
    d.close_date && `closes ${day(d.close_date)}`,
    fmtRowOdds(d) ?? (d.win_probability != null && `win ${fmtOdds(d.win_probability)}${d.close_within_30d != null ? ` (${fmtOdds(d.close_within_30d)} in 30d)` : ""}`),
    d.health != null && `health ${d.health}`,
    d.owner && `owner ${d.owner.name ?? d.owner.email}`,
    d.pipeline?.name && `pipeline ${d.pipeline.name}`,
    d.last_activity_at && `active ${relAge(d.last_activity_at)}`,
    d.implied && "implied (no CRM deal)",
  ].filter(Boolean);
  return `• ${d.name ?? "(unnamed deal)"} — ${bits.join(" · ")}  [${d.id}]`;
}

/** One person (GET /v2/people, either the engaged list or include=all) as one line. */
function personLine(p) {
  const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "(unnamed)";
  const role = [p.job_title, p.company].filter(Boolean).join(" at ");
  const bits = [
    role || null,
    p.email,
    !p.email && p.linkedin_url,
    p.pipeline_stage,
    p.icp_score != null && `ICP ${p.icp_score}${p.icp_fit === true ? " fit" : p.icp_fit === false ? " not fit" : ""}`,
    p.country,
    p.last_activity_at && `active ${relAge(p.last_activity_at)}`,
  ].filter(Boolean);
  return `• ${name}${bits.length ? ` — ${bits.join(" · ")}` : ""}  [${p.id ?? p.entity_id}]`;
}

/** One account (GET /v2/accounts) as one line. */
function accountLine(a) {
  const bits = [
    a.domain,
    a.stage,
    a.icp_score != null && `ICP ${a.icp_score}${a.icp_tier ? ` ${a.icp_tier.replace(/_/g, " ")}` : ""}`,
    a.health != null && `health ${a.health}`,
    a.open_deals ? `${a.open_deals} open deal${a.open_deals === 1 ? "" : "s"}` : null,
    a.pipeline_value ? `${fmtMoney(a.pipeline_value)} pipeline` : null,
    fmtRowOdds(a) ?? (a.win_probability !== undefined && `win ${fmtOdds(a.win_probability) ?? "unknown"}${a.close_within_30d != null ? ` (${fmtOdds(a.close_within_30d)} in 30d)` : ""}`),
    a.owner && `owner ${a.owner.name ?? a.owner.email}`,
    a.country,
    a.last_activity_at && `active ${relAge(a.last_activity_at)}`,
  ].filter(Boolean);
  return `• ${a.name ?? a.domain ?? "(unnamed)"}${bits.length ? ` — ${bits.join(" · ")}` : ""}  [${a.entity_id}]`;
}

/** The `deal` block POST /v2/context leads with when the focus is a deal. */
function dealBlockLines(d) {
  const out = [`DEAL: ${d.name ?? "(unnamed deal)"}  [${d.id}]${d.implied ? "  (implied: the account has no CRM deal)" : ""}`];
  const head = [
    d.account?.name && `account ${d.account.name}${d.account.domain ? ` (${d.account.domain})` : ""}`,
    stageText(d.stage, d.canonical_stage) && `stage ${stageText(d.stage, d.canonical_stage)}${d.days_in_stage != null ? `, ${d.days_in_stage}d in stage` : ""}`,
    d.status,
    fmtMoney(d.amount, d.currency),
    d.close_date && `closes ${day(d.close_date)}`,
    d.health != null && `health ${d.health}`,
    d.owner && `owner ${d.owner.name ?? d.owner.email}`,
    d.pipeline?.name && `pipeline ${d.pipeline.name}`,
  ].filter(Boolean);
  if (head.length) out.push(`  ${head.join(" · ")}`);
  if (d.stakeholders?.length) {
    out.push("  PEOPLE ON THE DEAL:");
    for (const p of d.stakeholders) {
      out.push(`    ${p.name ?? "—"}${p.title ? ` — ${p.title}` : ""}${p.role ? ` (${String(p.role).replace(/_/g, " ")})` : ""}  [${p.entity_id}]`);
    }
  } else if (d.roster_known === false) {
    out.push("  PEOPLE ON THE DEAL: none recorded in the CRM.");
  }
  const groups = Object.entries(d.claims ?? {}).filter(([, v]) => v?.length);
  if (groups.length) {
    out.push("  FILED TO THE DEAL:");
    for (const [g, items] of groups) {
      for (const c of items) out.push(`    [${g}] ${c.label ? `${c.label}: ` : ""}${c.content}${c.at ? `  (${relAge(c.at)})` : ""}`);
    }
  }
  out.push("  (win odds: find { kind: 'deals', sort: 'win_probability' } or deals { account })");
  return out;
}

// What each list honours (GET /v2/people, /v2/accounts, /v2/deals). The REST lists 400 on any
// other param; checking here first gives the agent the reason and the alternatives instead.
const FIND_SPEC = {
  people: {
    filters: ["stage", "source", "status", "has_email", "has_linkedin", "email", "linkedin_url", "icp_fit",
      "min_icp_score", "last_activity_before", "last_activity_after", "account", "include_all"],
    // ?include=all reads a different store (every person, cold leads too) that answers fewer filters.
    include_all_filters: ["stage", "email", "has_email", "icp_fit", "min_icp_score", "last_activity_before",
      "last_activity_after", "account", "include_all"],
    sorts: ["last_activity", "last_activity_asc", "icp_score", "icp_score_asc", "recently_added"],
    include_all_sorts: ["last_activity", "last_activity_asc", "icp_score", "icp_score_asc"],
    search: true, maxLimit: 1000,
  },
  accounts: {
    filters: ["stage", "icp_fit", "min_icp_score", "owner", "country", "has_open_deal",
      "last_activity_before", "last_activity_after", "include_all"],
    sorts: ["last_activity", "icp_score", "pipeline_value", "health", "win_chance"],
    search: true, maxLimit: 200,
  },
  deals: {
    filters: ["account", "pipeline", "status", "stage", "owner", "closing_within_days", "min_amount", "implied"],
    sorts: ["last_activity", "close_date", "amount", "win_probability"],
    search: false, maxLimit: 200,
  },
};
const DEAL_STATUSES = ["open", "won", "lost"];

/**
 * Validate a find call against FIND_SPEC and build the query string, or return { error }.
 * Exported for the tests.
 */
export function buildFindQuery({ kind, search, filters = {}, sort, limit, offset }) {
  const spec = FIND_SPEC[kind];
  if (!spec) return { error: `kind must be one of: ${Object.keys(FIND_SPEC).join(", ")}.` };
  const given = Object.entries(filters ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const allAll = kind === "people" && filters?.include_all === true;
  const allowed = allAll ? spec.include_all_filters : spec.filters;
  const bad = given.map(([k]) => k).filter((k) => !allowed.includes(k));
  if (bad.length) {
    const why = allAll ? `${kind} with include_all` : kind;
    const hint = kind === "deals" && bad.some((k) => ["icp_fit", "min_icp_score", "country", "has_open_deal"].includes(k))
      ? " ICP fit, country and open-deal filters are on accounts: find accounts first, then pass one as `account`." : "";
    return { error: `${bad.join(", ")} ${bad.length === 1 ? "is not a filter" : "are not filters"} on ${why}. Supported: ${allowed.join(", ")}.${hint}` };
  }
  if (search && !spec.search) {
    return { error: "deals cannot be searched by text. Pass filters.account (a domain, email, entity id or name) for one account's deals, or find accounts by `search` first." };
  }
  const sorts = allAll ? spec.include_all_sorts : spec.sorts;
  if (sort && !sorts.includes(sort)) return { error: `sort '${sort}' is not available for ${allAll ? "people with include_all" : kind}. Use one of: ${sorts.join(", ")}.` };
  if (kind === "deals" && filters?.status && !DEAL_STATUSES.includes(filters.status)) {
    return { error: `a deal's status is one of: ${DEAL_STATUSES.join(", ")}.` };
  }
  const cap = kind === "accounts" && sort === "win_chance" ? 50 : allAll ? 200 : spec.maxLimit;
  const q = {};
  if (search) q.search = search;
  for (const [k, v] of given) {
    if (k === "include_all") { if (v === true) q.include = "all"; continue; }
    if (k === "stage" && kind === "people") { q.pipeline_stage = v; continue; }
    q[k] = v;
  }
  if (sort) q.sort = sort;
  if (limit != null) q.limit = Math.min(Math.max(1, Math.floor(limit)), cap);
  if (offset != null) q.offset = Math.max(0, Math.floor(offset));
  return { path: `/v2/${kind}`, query: q };
}


// ─── factory ──────────────────────────────────────────────────────────────────

// A closed deal as the agent may supply it. A bare domain is the original shape and still
// works; the object form carries the money and the date, which the forecast needs. Widened
// rather than replaced so nothing that already calls this breaks.
//
// Module scope, not inside createServer(). It was declared below its own first use, and a
// `const` in the temporal dead zone throws on every request — the hosted server crashed on
// each call with "Cannot access 'CLOSED_DEAL' before initialization". Out here it is also
// built once instead of per request, since createServer() runs for every incoming call.
const CLOSED_DEAL = z.union([
  z.string(),
  z.object({
    domain: z.string().describe("Company domain, e.g. 'acme.com' — no scheme."),
    amount: z.number().optional().describe("Deal value in major units (48000, not 4800000)."),
    currency: z.string().optional().describe("ISO code or symbol. Defaults to the workspace currency."),
    closed_at: z.string().optional().describe("When it actually closed, ISO date. Drives every cycle-time measurement, so pass the real date rather than today's."),
  }),
]);

export function createServer() {
  const server = new McpServer({
    // What an MCP host shows the server as. "OpenNous", like the product and the plugin.
    name: "opennous",
    version: SERVER_VERSION,
    description:
      "OpenNous — the revenue Context Graph for your coding agent. Operated by the agent, not a human " +
      "clicking around: call whoami to confirm who you act as (workspace, scope, GTM role). Call " +
      "get_context before drafting outreach or preparing for a meeting. Call record after every " +
      "interaction, or whenever you learn something — you observe, Nous derives.",
    icons: [
      { src: "https://opennous.cloud/newlogoP.png", mimeType: "image/png", sizes: ["64x64"] },
    ],
  });

  // Nous is fully a revenue plugin: this server exposes EXACTLY these primitives and
  // nothing else (the ~30 legacy tools were pruned). Writes: record · record_insight.
  // Reads: get_context · get_account · query (search folds in via facts:true) · score.
  // ICP: set_icp writes the hypothesis; record_closed_deals trains it on real
  // won/lost outcomes (contrastive lift). Identity: whoami (who the key acts as,
  // scope, GTM role[s]) — the governance substrate. record_signal folds into record;
  // save_note is out. Deals: deal health + how likely each deal is to close, and why. The
  // THE surface. This set is the only statement of what the plugin exposes — the README
  // describes it, and for weeks the two disagreed (docs said eight, this comment said ten, the
  // set held thirteen), which is how a locked decision quietly stops being one. Do not write the
  // count in prose anywhere, here or in the docs; count the set.
  //
  // The `tool()` guard below drops a stray non-primitive registration rather than exposing it,
  // so adding a tool takes a deliberate edit here. The bar for that edit: a capability that
  // cannot fold into an existing primitive. Not convenience, and not symmetry with the app's 64
  // tools — most of those are UI actions, the operator's own connectors, or skill machinery
  // Claude Code already has. See docs/revenue-plugin/README.md §3.
  const PLUGIN_TOOLS = new Set([
    // The documented core (2026-09-30): one tool per door of the public API.
    "whoami", "find", "get_context", "query", "attention", "tasks", "rules", "get_insights",
    "add_note", "enrich", "score",
    // The Workspace layer's (Cloud) tools: read_brain, write_brain (GET-839). None in the open-source edition.
    ...CLOUD_TOOL_NAMES,
    "set_icp",
    // Events pushed to the operator's own stack (GET-559): a door of its own, /v2/webhooks —
    // nothing else subscribes, and an agent wiring n8n or Clay to the record needs it.
    "webhooks",
    // (`tasks` sits next to attention: the worklist's items, read and closed. Closing a task cannot
    // fold into record or add_note, which only append; GET-830.)
    // Legacy: still registered because plugin skills call them. Retired once the skills
    // migrate to the core set (GET-536). Not in the documented surface.
    "get_account", "deals", "pages", "read_page", "save_page",
    "record", "record_insight", "record_closed_deals",
  ]);
  // Registrations are collected, then made in PLUGIN_TOOLS order at the end, so tools/list
  // shows the documented core first and the legacy tools after it, whatever order the code
  // below happens to define them in.
  const _tool = server.tool.bind(server);
  const pending = new Map();
  const tool = (name, ...rest) => {
    if (!PLUGIN_TOOLS.has(name)) return undefined;
    pending.set(name, rest);
    return undefined;
  };
  // What the cloud module's tools and tool extensions call the API with.
  const helpers = { get, post, put, relAge };

  // ===========================================================================
  // TOOL: get_context  —  POST /v2/context
  // The headline tool. Engineered, intent-shaped context for a specific task.
  // ===========================================================================
  tool(
    "get_context",
    "Get engineered context for a specific task about a person, a company or a DEAL. Pass their email (or " +
    "entity id, or a deal id from find { kind: 'deals' }) and the intent. A deal id leads with the DEAL itself " +
    "(stage, amount, close date, owner, health, the people on it, the objections / competitors / budget / " +
    "timeline filed to it), then its account's context. Returns a focused, ranked context block: the facts that matter for " +
    "that task — each with a confidence and a freshness — the durable FACTS we've learned about them " +
    "(their atomic memory: budget, authority, pain, stack, plans), the recent timeline, the buying-group " +
    "stakeholders, open predictions, and the account's ICP fit score (0-100 + why). Call this before " +
    "drafting outreach, preparing for a meeting, " +
    "or making any decision about a person. A fact's freshness tells you whether to trust it: 'fresh' " +
    "act on it, 'suspect'/'expired' verify first.",
    {
      focus: z.string().describe("Who or what to look up — an email, a LinkedIn URL, a domain, an entity UUID, a name, or a DEAL id: a CRM deal UUID, or `implied:<account_id>` for an account with no CRM deal (both as find { kind: 'deals' } prints them). A name may match several people; you'll get candidates to choose from."),
      intent: z.enum(["draft_email", "follow_up", "meeting_prep", "call_prep", "account_review"])
        .optional()
        .describe("What you are about to do — shapes which context surfaces (default: account_review)"),
      budget_tokens: z.number().optional().describe("Approximate token budget for the context block"),
    },
    async ({ focus, intent, budget_tokens }) => {
      const ctx = await post("/v2/context", { focus, intent: intent ?? "account_review", budget_tokens });

      // a name matched several people — surface the candidates to choose from
      if (ctx.status === "ambiguous") {
        const opts = (ctx.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        return { content: [{ type: "text", text:
          `"${focus}" matches several people. Call get_context again with one of these entity ids:\n${opts}` }] };
      }

      // A deal focus: the deal leads, then the account context it resolved to.
      const lines = ctx.deal ? [...dealBlockLines(ctx.deal), "", "ACCOUNT CONTEXT:", ctx.summary, ""] : [ctx.summary, ""];

      if (ctx.icp) {
        const label = ctx.icp.score >= 70 ? "strong fit" : ctx.icp.score >= 40 ? "moderate fit" : "weak fit";
        lines.push(`ICP FIT: ${ctx.icp.score}/100 — ${label}${ctx.icp.reason ? `  (${ctx.icp.reason})` : ""}`);
        lines.push("");
      }
      // Atomic memory, current position first (GET-770).
      lines.push(...factsBlock(ctx));
      if (ctx.claims?.length) {
        lines.push(`ATTRIBUTES (${ctx.meta?.claims_returned ?? ctx.claims.length}):`);
        for (const c of ctx.claims) {
          lines.push(`  ${c.property}: ${fmtVal(c.value)}  [${pct(c.confidence)} · ${c.freshness}]`);
        }
        lines.push("");
      }
      if (ctx.workspace?.length) {
        lines.push("YOUR CONTEXT (ICP / product / positioning):");
        for (const w of ctx.workspace) lines.push(`  ${w.property}: ${fmtVal(w.value)}`);
        lines.push("");
      }
      if (ctx.meetings && (ctx.meetings.next || ctx.meetings.last)) {
        // GET-231: the meeting a prep is FOR, read off the account — every attendee on the
        // invite, their side and ours. Only meeting_prep / call_prep carry it.
        const meetingLines = (label, m) => {
          if (!m) return;
          lines.push(`${label}: ${m.title ?? "Meeting"} — ${fmtWhen(m.when)}${m.status && m.status !== "scheduled" ? ` (${m.status})` : ""}`);
          for (const a of m.attendees ?? []) {
            const who = a.name ?? a.email ?? "guest";
            const bits = [a.side === "internal" ? "our team" : a.company ?? "their side"];
            if (a.title) bits.push(a.title);
            if (a.organizer) bits.push("organizer");
            if (a.side === "external" && !a.entity_id) bits.push("no record yet");
            lines.push(`  ${who}${a.name && a.email ? ` <${a.email}>` : ""} (${bits.join(", ")})${a.entity_id ? `  [${a.entity_id}]` : ""}`);
          }
        };
        meetingLines("NEXT MEETING", ctx.meetings.next);
        meetingLines("LAST MEETING", ctx.meetings.last);
        if (ctx.meetings.upcoming?.length) {
          lines.push("ALSO COMING UP:");
          for (const u of ctx.meetings.upcoming) lines.push(`  ${fmtWhen(u.when)}  ${u.title ?? "Meeting"}`);
        }
        lines.push("");
      }
      if (ctx.timeline?.length) {
        lines.push("TIMELINE:");
        for (const t of ctx.timeline) {
          if (t.tier === "count") lines.push(`  ${t.count}× ${fmtType(t.type)}`);
          else lines.push(`  ${whenLabel(t.type, t.when)}  ${fmtType(t.type)}${t.summary ? `: ${t.summary}` : ""}`);
        }
        lines.push("");
      }
      if (ctx.documents?.length) {
        // Meeting briefs / notes / transcripts kept on the contact — an overview
        // (snippets only). Written documents open with read_page; `documents` searches them.
        lines.push("PAGES (briefs, reports & meeting records — open a written one with read_page, search them with pages):");
        for (const d of ctx.documents) {
          const when = d.date ? `  [${relAge(d.date)}]` : "";
          lines.push(`  ${d.type.replace(/_/g, " ")}${d.title ? ` · ${d.title}` : ""}${when}${d.source_ref ? `  [${d.document_id}]` : ""}`);
          if (d.snippet) lines.push(`    ${d.snippet}`);
        }
        lines.push("");
      }
      if (ctx.stakeholders?.length) {
        // The buying committee as a STRUCTURE: who's at the account, their role,
        // whether we've engaged them, and how they relate — so the agent works the
        // whole committee, not one person.
        const c = ctx.committee;
        lines.push(c?.company ? `BUYING COMMITTEE — ${c.company}:` : "STAKEHOLDERS:");
        for (const s of ctx.stakeholders) {
          if (s.role === "company") continue; // the company is the header
          const bits = [];
          if (s.committee_role && s.committee_role !== "contact") bits.push(s.committee_role.replace(/_/g, " "));
          if (s.role) bits.push(s.role);
          bits.push(s.engaged ? "engaged" : "not yet engaged");
          if (s.confirmed === false) bits.push("mentioned, unconfirmed");
          const rel = s.relationships?.length ? ` — ${s.relationships.join("; ")}` : "";
          lines.push(`  ${s.name ?? "—"} (${bits.join(", ")})${rel}`);
        }
        if (c?.champion) lines.push(`  champion: ${c.champion}`);
        if (c?.gaps?.length) for (const g of c.gaps) lines.push(`  ⚠ ${g}`);
        lines.push("");
      }
      if (ctx.predictions?.length) {
        lines.push("PREDICTIONS:");
        for (const p of ctx.predictions) {
          lines.push(`  ${p.kind}: ${fmtVal(p.value)} (${pct(p.confidence)})`);
        }
      }
      return {
        content: [{ type: "text", text: `${lines.join("\n").trim()}\n\n(entity_id: ${ctx.entity?.id}${ctx.deal ? ` · deal_id: ${ctx.deal.id}` : ""})` }],
      };
    }
  );

  // ===========================================================================
  // TOOL: get_account  —  GET /v2/accounts/:id
  // The full account-record projection. For a focused view, prefer get_context.
  // ===========================================================================
  tool(
    "get_account",
    "Get the full account record for a person or company — the durable FACTS we've learned about them " +
    "(their atomic memory: budget, authority, pain, stack, plans), every attribute (claim) with its " +
    "confidence and freshness, plus what they actually SAID and did, ranked by how much it tells you. " +
    "Pass an email or entity UUID, and the intent you're working toward so the record is shaped for it.",
    {
      id: z.string().describe("Who to look up — an email, an entity UUID, or a name. A name may match several people; you'll get candidates to choose from."),
      intent: z
        .enum(["meeting_prep", "call_prep", "account_review", "follow_up", "draft_email"])
        .optional()
        .describe(
          "What you're about to do. Shapes how much of their history comes back: a meeting brief wants " +
          "the conversation in detail, an email draft wants one hook. Defaults to account_review.",
        ),
    },
    async ({ id, intent }) => {
      // Ask for the RANKED record, not the raw one.
      //
      // The timeline this tool used to print was chronological and contentless —
      // "3d ago  email_sent" — which tells an agent that something happened and
      // nothing about what. Ranked activity carries the source and the substance,
      // so the model reads what was actually said instead of a list of event names.
      const q = new URLSearchParams({ intent: intent ?? "account_review", compress: "1" });
      const rec = await get(`/v2/accounts/${encodeURIComponent(id)}?${q}`);

      // A name matched several people — surface the candidates to choose from.
      // Without this, the header line below reads `rec.type`/`rec.entity_id` off the
      // ambiguous response (which carries neither) and prints "undefined · undefined".
      if (rec.status === "ambiguous") {
        const opts = (rec.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        return { content: [{ type: "text", text:
          `"${id}" matches several people. Call get_account again with one of these entity ids:\n${opts}` }] };
      }

      const lines = [`${rec.type} · ${rec.entity_id}`, ""];

      if (rec.icp) {
        const label = rec.icp.score >= 70 ? "strong fit" : rec.icp.score >= 40 ? "moderate fit" : "weak fit";
        lines.push(`ICP FIT: ${rec.icp.score}/100 — ${label}${rec.icp.reason ? `  (${rec.icp.reason})` : ""}`);
        lines.push("");
      }
      if (rec.scorecard) {
        // The latest call scorecard the app computed (Coaching v2). The after-call skill writes the
        // coaching review out of THIS — it does not re-score. Each dimension carries its exact moment.
        const sc = rec.scorecard;
        lines.push(`LAST CALL SCORE: ${sc.overall}/10 · ${sc.next_step_secured ? "next step secured" : "no next step secured"}${sc.occurred_at ? `  (${relAge(sc.occurred_at)})` : ""}`);
        for (const d of (sc.scores ?? [])) {
          lines.push(`  [${d.score}] ${d.label}${d.note ? ` — ${d.note}` : ""}`);
          if (d.moment) lines.push(`      "${d.moment}"`);
        }
        lines.push("");
      }
      // Atomic memory, current position first (GET-770).
      lines.push(...factsBlock(rec));
      lines.push(...featureRequestsBlock(rec.feature_requests));
      const docs = rec.documents ?? [];
      if (docs.length) {
        // Saved briefs / notes / transcripts kept on the contact — previews only.
        // The agent needs to KNOW these exist so it never reports "no brief on
        // file" when one is saved; a written document opens with read_page.
        lines.push(`PAGES (${docs.length} — briefs, reports & meeting records; open a written one with read_page):`);
        for (const d of docs) {
          const when = d.date ? `  (${relAge(d.date)})` : "";
          lines.push(`  ${d.type.replace(/_/g, " ")}${d.title ? ` · ${d.title}` : ""}${when}${d.source_ref ? `  [${d.document_id}]` : ""}`);
          if (d.snippet) lines.push(`      ${d.snippet}`);
        }
        lines.push("");
      }
      // The buying committee — who else is at the account, their role, whether we've
      // engaged them, and how they relate. Same structure get_context surfaces.
      if (rec.stakeholders?.length) {
        const c = rec.committee;
        lines.push(c?.company ? `BUYING COMMITTEE — ${c.company}:` : "STAKEHOLDERS:");
        for (const s of rec.stakeholders) {
          if (s.role === "company") continue;
          const bits = [];
          if (s.committee_role && s.committee_role !== "contact") bits.push(s.committee_role.replace(/_/g, " "));
          if (s.role) bits.push(s.role);
          bits.push(s.engaged ? "engaged" : "not yet engaged");
          if (s.confirmed === false) bits.push("mentioned, unconfirmed");
          const rel = s.relationships?.length ? ` — ${s.relationships.join("; ")}` : "";
          lines.push(`  ${s.name ?? "—"} (${bits.join(", ")})${rel}`);
        }
        if (c?.champion) lines.push(`  champion: ${c.champion}`);
        if (c?.gaps?.length) for (const g of c.gaps) lines.push(`  ⚠ ${g}`);
        lines.push("");
      }
      const claims = Object.values(rec.claims ?? {});
      if (claims.length) {
        lines.push(`ATTRIBUTES (${claims.length}):`);
        for (const c of claims) {
          lines.push(`  ${c.property}: ${fmtVal(c.value)}  [${pct(c.confidence)} · ${c.freshness}]`);
        }
        lines.push("");
      }
      // What they actually said and did — the most telling first, each with the
      // system it came from, so a claim in the answer can always be traced back.
      const activity = rec.key_activity ?? [];
      if (activity.length) {
        lines.push(`WHAT HAPPENED (${activity.length} most telling):`);
        for (const a of activity) {
          const when = a.when ? relAge(a.when) : "";
          const head = `  ${a.what}${a.source ? ` · ${a.source}` : ""}${when ? ` · ${when}` : ""}`;
          lines.push(a.detail ? `${head}\n      ${a.detail}` : head);
        }
        lines.push("");
      }

      // Say what was left out, and why. An agent that is handed 18 of 300
      // interactions and does not know it will happily conclude that nothing else
      // ever happened.
      const sum = rec.activity_summary;
      if (sum?.note) lines.push(sum.note);
      else if (sum?.total_observations) {
        lines.push(`${sum.total_observations} interactions on record.`);
      }

      // Fall back to the raw timeline if an older API didn't rank anything.
      if (!activity.length && rec.recent_observations?.length) {
        const obs = rec.recent_observations;
        lines.push(`TIMELINE (${obs.length}):`);
        for (const o of obs.slice(0, 30)) {
          lines.push(`  ${whenLabel(o.property, o.observed_at)}  ${fmtType(o.property)}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );



  // ===========================================================================
  // TOOL: deals  —  GET /v2/accounts/outlook · GET /v2/accounts/:id/outlook
  // Deal health next to how likely a deal is to close, and why. Per account — the
  // revenue roll-up is not this tool. (These paths were /v2/deals and /v2/deals/:id
  // until /v2/deals became the CRM deal list; the API still answers the old paths.)
  // ===========================================================================
  tool(
    "deals",
    "DEAL HEALTH and HOW LIKELY A DEAL IS TO CLOSE, with the reasons. Two ways to call it:\n" +
    "  • no `account` → the open deals most likely to close within `within_days` (default 30), ranked. Each carries " +
    "its chance to close in that window, its overall chance to win, its deal health (score, band, what to watch) and " +
    "the facts that moved its odds. Use for 'which deals are most likely to close in the next 30 days', 'what will " +
    "close this month', 'what's closest to closing'.\n" +
    "  • `account` (email, domain, LinkedIn URL, entity UUID, or name) → that one deal: health with all four signals " +
    "and the engagement read, its chance to close overall, within `within_days` and within 90 days, the stage-only " +
    "baseline, and every fact pushing the odds up or down. Use for 'how likely is Acme to close', 'what's the deal " +
    "health on Acme', 'will Acme close this month'.\n" +
    "The odds are the stage's base rate moved by what the graph recorded: open objections, competitors, stall, " +
    "silence, threading, ICP fit, intent. 'unknown' within N days means this stage has no closed deals to judge " +
    "timing on yet: say so, never call it 0%.\n" +
    "Until the workspace has enough won and lost deals to learn from, the odds come back as a RANK (ODDS TO CLOSE: " +
    "3rd most likely of 12 open deals) with what is helping and hurting, and NO percentage. Say it that way; never " +
    "turn it into a percentage or call it a forecast, and don't explain model weights to the user.",
    {
      account: z.string().optional().describe("One account to judge: email, domain, LinkedIn URL, entity UUID, or name. Omit to rank the open deals."),
      within_days: z.number().optional().describe("The window for 'likely to close within N days'. Default 30."),
      limit: z.number().optional().describe("How many ranked deals to return (max 25, default 10). Ignored with `account`."),
    },
    async ({ account, within_days, limit }) => {
      const pctTxt = (v) => (v == null ? "unknown" : `${v}%`);
      const q = within_days ? { within_days } : {};
      const lines = [];

      if (account) {
        const r = await get(`/v2/accounts/${encodeURIComponent(account)}/outlook`, q);
        if (r.status === "ambiguous") {
          const opts = (r.candidates ?? []).map(c =>
            `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
          return { content: [{ type: "text", text:
            `"${account}" matches several people. Call deals again with one of these entity ids:\n${opts}` }] };
        }
        const name = r.name ?? r.entity_id;
        if (r.status === "open" && r.odds === "rank") {
          // Default weights (GET-832): a rank among the open deals and what moves it, no percentage.
          lines.push(`${name} · ${r.entity_id} · stage ${r.stage}, ${r.days_in_stage}d in stage` +
            (r.typical_days_in_stage != null ? ` (typical ${r.typical_days_in_stage}d)` : ""));
          lines.push(`ODDS TO CLOSE: ${ordinal(r.rank)} most likely of ${r.of} open deal${r.of === 1 ? "" : "s"}`);
          if (r.helping?.length) lines.push(`  HELPING: ${r.helping.join("; ")}`);
          if (r.hurting?.length) lines.push(`  HURTING: ${r.hurting.join("; ")}`);
        } else if (r.status === "open") {
          const windows = Object.entries(r.close_within_pct ?? {})
            .map(([d, v]) => `${pctTxt(v)} within ${d}d`).join(" · ");
          lines.push(`${name} · ${r.entity_id} · stage ${r.stage}, ${r.days_in_stage}d in stage` +
            (r.typical_days_in_stage != null ? ` (typical ${r.typical_days_in_stage}d)` : ""));
          lines.push(`CLOSE: ${pctTxt(r.win_pct)} to win · ${windows}  (stage alone: ${pctTxt(r.stage_only_win_pct)})`);
          if (r.timing && r.timing !== "judged") lines.push(`TIMING: ${r.timing}`);
          if (r.why?.length) {
            lines.push("WHY:");
            for (const y of r.why) lines.push(`  ${y}`);
          }
        } else {
          lines.push(`${name} · ${r.entity_id}${r.stage ? ` · ${r.stage}` : ""}`);
          lines.push(r.note);
        }
        if (r.icp) {
          const i = r.icp;
          if (!i.scored) lines.push(`ICP: ${i.note}`);
          else {
            lines.push(`ICP: ${i.score ?? "—"}/100${i.tier ? ` ${i.tier}` : ""}${i.via_person?.name ? ` (scored on ${i.via_person.name})` : ""}`);
            if (i.fired?.length) for (const f of i.fired) lines.push(`  +${f.weight} ${f.label}`);
            if (i.note) lines.push(`  ${i.note}`);
            else if (i.missing_inputs?.length) lines.push(`  not on the record: ${i.missing_inputs.join(", ")}`);
          }
        }
        if (r.health) {
          lines.push(`HEALTH: ${r.health.score ?? "—"}/100 ${r.health.band ?? ""}`.trim());
          if (r.health.evidence?.note) lines.push(`  ${r.health.evidence.note}`);
          for (const s of r.health.signals ?? []) lines.push(`  ${s.signal}: ${s.level} — ${s.reason}`);
          const e = r.health.engagement ?? {};
          const eng = [
            e.last_response && `last response ${e.last_response}`,
            e.engagement_trend && `engagement ${e.engagement_trend}`,
            e.multi_threading && `${e.multi_threading}`,
            e.response_time && e.response_time !== "—" && `buyer replies in ${e.response_time}`,
            e.meetings && e.meetings,
          ].filter(Boolean);
          if (eng.length) lines.push(`  ${eng.join(" · ")}`);
        }
        if (r.via_person) lines.push(`(resolved from a person at this account: ${r.via_person})`);
        for (const n of r.model?.notes ?? []) lines.push(`NOTE: ${n}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const r = await get("/v2/accounts/outlook", { ...q, ...(limit ? { limit } : {}) });
      const deals = r.deals ?? [];
      lines.push(`Open deals ranked by ${r.ranked_by}. Showing ${deals.length} of ${r.open_deals} open` +
        (r.odds === "rank" ? "." : `; timing known for ${r.timing_known}.`));
      deals.forEach((d, i) => {
        if (d.odds === "rank") {
          lines.push(`${i + 1}. ${d.name ?? "(unnamed)"} [${d.entity_id}] — ${d.stage}, ${d.days_in_stage}d · ` +
            `health ${d.health?.score ?? "—"}${d.health?.band ? ` ${d.health.band}` : ""}`);
          if (d.helping?.length) lines.push(`   helping: ${d.helping.join("; ")}`);
          if (d.hurting?.length) lines.push(`   hurting: ${d.hurting.join("; ")}`);
          if (d.health?.watch?.length) lines.push(`   watch: ${d.health.watch.join("; ")}`);
          return;
        }
        lines.push(`${i + 1}. ${d.name ?? "(unnamed)"} [${d.entity_id}] — ${d.stage}, ${d.days_in_stage}d · ` +
          `${pctTxt(d.close_within_pct?.[r.within_days])} within ${r.within_days}d · ${pctTxt(d.win_pct)} to win · ` +
          `health ${d.health?.score ?? "—"}${d.health?.band ? ` ${d.health.band}` : ""}`);
        if (d.timing && d.timing !== "judged") lines.push(`   timing: ${d.timing}`);
        if (d.why?.length) lines.push(`   why: ${d.why.join("; ")}`);
        if (d.health?.watch?.length) lines.push(`   watch: ${d.health.watch.join("; ")}`);
      });
      if (!deals.length) lines.push("No open deals: nothing has a reconstructed stage between first contact and a close.");
      for (const n of r.model?.notes ?? []) lines.push(`NOTE: ${n}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: documents  —  GET /v2/documents
  // The briefs, plans and reports already written in the workspace (GET-197) — the same Docs
  // the operator browses. Before this the plugin could not see a single one.
  // ===========================================================================
  tool(
    "pages",
    "The documents already written in this workspace — account briefs, account plans, reports (pipeline, " +
    "win/loss, market read, forecast, team), meeting briefs, objection prep. The operator browses them in Pages.\n" +
    "  • `query` → the PASSAGES that match, best first, each with the section it came from. Use for 'what did we " +
    "conclude about pricing', 'which report mentioned the Clay objection'.\n" +
    "  • no `query` → the list, newest first, filtered by `kind`, `account`, `series`, `cadence` or a date window. " +
    "Use for 'last month's pipeline report', 'the brief on Acme', 'every win/loss read this quarter'.\n" +
    "CHECK HERE BEFORE WRITING A NEW REPORT OR BRIEF: build on the last one and say what changed. Open one with " +
    "read_page. Cite a document by its ref (nous://doc/…) when you repeat what it found." +
    (cloudMcp?.pages?.description ?? ""),
    {
      ...(cloudMcp?.pages?.args?.(z) ?? {}),
      query: z.string().optional().describe("What you are looking for, in plain language. Omit to list."),
      kind: z.enum(["brief", "plan", "report", "meeting_brief", "objection_prep", "call"]).optional(),
      account: z.string().optional().describe("Only documents about this account: email, domain, LinkedIn URL, entity UUID, or name."),
      series: z.enum(["pipeline", "forecast", "win_loss", "market_read", "team", "role", "changes"]).optional().describe("Reports: which recurring report."),
      cadence: z.enum(["weekly", "monthly", "quarterly", "one_off"]).optional().describe("Reports: the length of the window covered."),
      since: z.string().optional().describe("ISO date: documents covering or written on/after it."),
      until: z.string().optional().describe("ISO date: documents covering or written on/before it."),
      limit: z.number().optional().describe("Max results (default 20, max 50)."),
    },
    async (args) => {
      const viaCloud = await cloudMcp?.pages?.handle?.(args, helpers);
      if (viaCloud) return viaCloud;
      const { query, kind, account, series, cadence, since, until, limit } = args;
      const params = Object.fromEntries(Object.entries({ q: query, kind, focus: account, series, cadence, since, until, limit })
        .filter(([, v]) => v != null && v !== ""));
      const r = await get("/v2/documents", params);
      if (r.status === "ambiguous") {
        const opts = (r.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        return { content: [{ type: "text", text: `"${account}" matches several accounts. Call documents again with one of these entity ids:\n${opts}` }] };
      }
      const head = (d) => {
        const bits = [d.kind.replace(/_/g, " ")];
        if (d.about) bits.push(`about ${d.about}`);
        if (d.series) bits.push(d.series.replace(/_/g, " "));
        if (d.cadence && d.cadence !== "one_off") bits.push(d.cadence);
        if (d.period) bits.push(`${d.period.start} → ${d.period.end}`);
        bits.push(`written ${relAge(d.written)}`);
        if (d.version > 1) bits.push(`v${d.version}`);
        return `${d.title}  [${d.document_id}]\n    ${bits.join(" · ")}`;
      };
      const lines = [];
      if (query) {
        const results = r.results ?? [];
        if (!results.length) return { content: [{ type: "text", text: `No document passage matches "${query}".` }] };
        lines.push(`${results.length} document passage${results.length === 1 ? "" : "s"} matching "${query}":`);
        for (const h of results) {
          lines.push(`• ${head(h)}`);
          lines.push(`    section ${h.section}${h.heading ? ` · ${h.heading}` : ""} · cite ${h.ref}`);
          if (h.passage) lines.push(`    ${h.passage.replace(/\s+/g, " ").slice(0, 500)}`);
        }
      } else {
        const docs = r.documents ?? [];
        if (!docs.length) return { content: [{ type: "text", text: "No document matches. Say so; if one is wanted, it has to be written." }] };
        lines.push(`${docs.length} document${docs.length === 1 ? "" : "s"}, newest first:`);
        for (const d of docs) {
          lines.push(`• ${head(d)}`);
          if (d.headline) lines.push(`    ${d.headline}`);
        }
      }
      lines.push("", "Open one with read_page { document_id, section?, find? }.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: read_page  —  GET /v2/documents/:id
  // ===========================================================================
  tool(
    "read_page",
    "Read one document from `documents` — whole, one `section`, or the passages around a phrase (`find`, cheaper). " +
    "Returns what the document cited (the calls and emails behind it, with quotes), the accounts it mentions, the " +
    "documents it links to and that link to it, and its version history. When you repeat a finding, cite the SOURCE " +
    "the document cited, not the document's summary of it.",
    {
      document_id: z.string().optional().describe("The id from `pages`."),
      ...(cloudMcp?.read_page?.args?.(z) ?? {}),
      section: z.number().optional().describe("Read only this section, by index."),
      find: z.string().optional().describe("A word or phrase: return the passages around each occurrence."),
    },
    async (args) => {
      const viaCloud = await cloudMcp?.read_page?.handle?.(args, helpers);
      if (viaCloud) return viaCloud;
      const { document_id, section, find } = args;
      if (!document_id) return { content: [{ type: "text", text: "Pass `document_id` (from pages)." }] };
      const params = Object.fromEntries(Object.entries({ section, find }).filter(([, v]) => v != null && v !== ""));
      const d = await get(`/v2/documents/${encodeURIComponent(document_id)}`, params);
      const lines = [`# ${d.title}`];
      const meta = [d.kind?.replace(/_/g, " "), d.about && `about ${d.about}`, d.period && `${d.period.start} → ${d.period.end}`,
        d.written && `written ${relAge(d.written)}`, d.version && `v${d.version}`, d.replaced && "REPLACED by a newer version"].filter(Boolean);
      lines.push(meta.join(" · "), `ref ${d.ref}`, "");
      if (d.headline) lines.push(d.headline, "");
      lines.push(`SECTIONS: ${(d.sections ?? []).map(s => `${s.index} ${s.label}`).join(" · ")}`, "");
      if (d.passages) {
        lines.push(d.passages.length ? `PASSAGES matching "${d.find}":` : `"${d.find}" does not appear in this document. Say so; do not infer it came up in other words.`);
        for (const p of d.passages) lines.push("---", p);
      } else {
        if (d.section) lines.push(`## ${d.section.label}`);
        lines.push(d.content ?? "");
        if (d.truncated) lines.push("", "(truncated — read by section or find)");
      }
      if (d.sources?.length) {
        lines.push("", `SOURCES IT CITED (${d.sources.length}):`);
        for (const s of d.sources) {
          lines.push(`  ${s.system}${s.detail ? ` — ${s.detail}` : ""}${s.when ? ` (${relAge(s.when)})` : ""}  ${s.ref}`);
          if (s.quote) lines.push(`    "${s.quote}"${s.speaker ? ` — ${s.speaker}` : ""}`);
        }
      }
      if (d.mentions?.length) lines.push("", `MENTIONS: ${d.mentions.map(m => `${m.name} [${m.entity_id}]`).join(", ")}`);
      if (d.links_to?.length) lines.push(`LINKS TO: ${d.links_to.map(x => `${x.title} [${x.document_id}]`).join(", ")}`);
      if (d.linked_from?.length) lines.push(`LINKED FROM: ${d.linked_from.map(x => `${x.title} [${x.document_id}]`).join(", ")}`);
      if (d.versions?.length > 1) lines.push(`VERSIONS: ${d.versions.map(v => `v${v.version} ${v.status} ${relAge(v.created_at)} [${v.id}]`).join(" · ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: save_page  —  POST /v2/documents
  // A finished brief, plan or report, filed into Pages (GET-204): the same tree, versions,
  // Evidence and agent retrieval as a document the in-app agent writes. Not the repo.
  // ===========================================================================
  tool(
    "save_page",
    "File a FINISHED document into the workspace's Pages: an account brief, an account plan, a report " +
    "(pipeline, win/loss, market read, forecast, team), a meeting brief or objection prep. It is saved on the " +
    "account it is about, versioned (a new brief on the same account becomes the next version) and readable by " +
    "the team and by agents. Call it ONCE, at the end, with the document you would otherwise have left in the chat " +
    "or written to a file. Do NOT also write it to the repo: raw material (transcripts, emails) stays in git, the " +
    "finished document lives in Pages.\n" +
    "HOW TO WRITE IT:\n" +
    "  • `markdown`: the document, split into sections on its `##` headings. A brief opens with an At a glance " +
    "section of 4-6 bullets (a meeting brief opens with Purpose and objective instead); no headings or dividers inside a section. A report section opens with a thesis a " +
    "reader could disagree with, never a label, and never as a negation followed by a correction.\n" +
    "  • CITE: mark each claim [1], [2] … and pass `sources` in that same order, each with the `ref` the tools " +
    "printed (e.g. `source://fireflies/…`, `nous://account/…`) plus its quote and speaker when you have them. A " +
    "marker with no matching source is dropped, so number against the list you pass.\n" +
    "  • A report passes `period` for the window it covers (it files under Weekly / Monthly / Quarterly) and " +
    "`generated_from` with real product names (\"HubSpot\", \"Fireflies\").\n" +
    "After it returns, give the operator ONE line with the finding and the page link. Don't paste the document." +
    (cloudMcp?.save_page?.description ?? ""),
    {
      // Cloud's extension supplies `brain`, `path` and its own `kind` (GET-839).
      ...(cloudMcp?.save_page?.args?.(z) ?? { kind: z.enum(["brief", "plan", "report", "meeting_brief", "objection_prep"]).optional().describe("What it is.") }),
      account: z.string().optional().describe("The account or person it is about: email, domain, LinkedIn URL, entity UUID, or name. Required for everything but a report across the book."),
      title: z.string().optional().describe("A report's name, as it would be called in an inbox (\"Revenue Pipeline Report — Acme\"). A meeting brief: the meeting's own title (\"Acme x OpenNous\"). A brief or plan is named by its account."),
      headline: z.string().optional().describe("One line: the finding, or where the account stands."),
      markdown: z.string().describe("The document itself, sections on `##` headings, citations as [1], [2]."),
      sources: z.array(z.object({
        ref: z.string().describe("The source_ref the tools printed."),
        system: z.string().optional(),
        detail: z.string().optional().describe("What the source is: 'Pricing review call with Odile'."),
        when: z.string().optional(),
        quote: z.string().optional(),
        speaker: z.string().optional(),
      })).optional().describe("The evidence, in the order the [n] markers number it."),
      period: z.object({ start: z.string(), end: z.string() }).optional().describe("Reports: the window covered, ISO dates."),
      generated_from: z.array(z.string()).optional().describe("Reports: the tools behind the data, as product names."),
      skill: z.string().optional().describe("The skill that produced it, e.g. 'brief', 'revenue-report'. Files a report into its series."),
    },
    async (args) => {
      const viaCloud = await cloudMcp?.save_page?.handle?.(args, helpers);
      if (viaCloud) return viaCloud;
      const { kind, account, title, headline, markdown, sources, period, generated_from, skill } = args;
      if (!kind) return { content: [{ type: "text", text: "Pass `kind` (brief, plan, report, meeting_brief, objection_prep)." }] };
      const r = await post("/v2/documents", { kind, account, title, headline, markdown, sources, period, generated_from, skill });
      if (r.status === "ambiguous") {
        const opts = (r.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        return { content: [{ type: "text", text: `"${account}" matches several accounts. Call save_page again with one of these entity ids:\n${opts}` }] };
      }
      if (r.error) {
        return { content: [{ type: "text", text: `Not saved (${r.error})${r.message ? `: ${r.message}` : ""}. Tell the operator it is not in Pages.` }] };
      }
      const lines = [
        `Saved to Pages: ${r.title}${r.version > 1 ? ` (v${r.version}, replaces the previous version)` : ""}`,
        r.url,
        `${r.sources} source${r.sources === 1 ? "" : "s"} attached · document_id ${r.document_id}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: record  —  POST /v2/observations
  // The single write verb. You observe — Nous derives the updated facts.
  // ===========================================================================
  tool(
    "record",
    "Record what happened or what you learned about a person or company. You never overwrite " +
    "anything — you observe, and Nous derives the updated facts. Use kind:'event' for an interaction " +
    "(property like 'interaction.email_sent', 'interaction.call_held', 'interaction.email_reply') and " +
    "kind:'state' for a fact (property like 'job_title', 'deal.proposal_amount'). Examples — sent an " +
    "email: {kind:'event',property:'interaction.email_sent',value:{description:'intro email'}}; " +
    "learned their title changed: {kind:'state',property:'job_title',value:'VP of Engineering'}; " +
    "a fact ended (they left): {kind:'state',property:'job_title',value:null}. For a piece of INTEL " +
    "about the contact — a preference, an objection, a competitor they mentioned, a general note — " +
    "use property:'intel' with a category: {kind:'state',property:'intel',value:{category:'objection'," +
    "content:'skeptical about market demand',label:'Market demand skepticism'}} (category ∈ " +
    "status_quo | goal | pain | objection | authority | budget | timeline | buying_signal | " +
    "preference | competitor | discovery | relationship | adoption | proficiency | seasonality | " +
    "staff_change | firmographic | performance | expansion_signal | risk_signal | tech_stack | blocker | " +
    "requirement | general — use the " +
    "MOST specific one; 'general' is a last resort, and it's 'timeline', never 'timing'. " +
    "firmographic = the standing shape of the business (locations, headcount, volume they do, " +
    "inventory, the segment they serve); performance = a dated result in THEIR business (a record " +
    "month, a slump, leads or sales up or down, a target hit or missed); expansion_signal = an " +
    "EXISTING customer asking for, considering or declining MORE of what we sell — set " +
    "stance:'asked'|'considering'|'declined' and product:'<family name>', and never omit stance " +
    "(a decline read as an ask sends a rep to pitch what was just refused); risk_signal = an " +
    "EXISTING customer saying the relationship is in question — set " +
    "severity:'stated_churn'|'at_risk'|'friction'. tech_stack = a tool they use and any fact about " +
    "it, filed on the company, set tool:'<name>'; blocker = what stands between now and a signed deal, " +
    "set status:'open'|'resolved'; requirement = a hard condition for buying. A prospect moving to " +
    "close is buying_signal, not expansion_signal. Their feedback on OUR product is not intel about " +
    "them: it is product feedback, not pain and not risk_signal). " +
    "Insights about YOUR OWN business (product/positioning/market/buyer) go to record_insight, not here. " +
    "HOW THIS OPERATOR WANTS THINGS — when they tell you outright, write it down so nobody has to say it twice. " +
    "A preference is about shape: {kind:'state',property:'preference',value:{statement:'write shorter than feels " +
    "finished',scope:'person',applies_to:'email_send'}}. A prohibition is stronger and gets its own property — " +
    "{kind:'state',property:'constraint',value:{statement:'never send breakup emails',scope:'person'}} — because " +
    "we stop generating those entirely rather than trying to remember not to. Use scope:'workspace' only when it " +
    "is how the COMPANY works, not how this person likes things. " +
    "CLOSING THE LOOP — when you RECOMMEND an action, write the recommendation down before it happens: " +
    "{kind:'state',property:'decision.proposed',value:{decision_id:'<your id>',proposal:'send a follow-up " +
    "naming the security objection',proposal_body:'<the exact draft>',rationale:'the security review " +
    "is the real blocker at this stage', " +
    "evidence_ids:['<claim/note id you reasoned from>'],action_type:'email_send',category:'outreach'}}. " +
    "`proposal_body` is the draft itself — hashed and discarded, never stored, and the only way to tell " +
    "later whether the human sent it as written or rewrote it first. Omit it and the decision reports as " +
    "sent-verbatim whatever happened. " +
    "Keep `proposal` (WHAT you are doing) apart from `rationale` (WHY you think it works), and list the " +
    "facts you actually reasoned from in `evidence_ids` — that is what lets Nous learn which KINDS of " +
    "evidence are worth acting on, not just which actions worked. When the human answers, " +
    "record the verdict: property 'decision.accepted' | 'decision.edited' | 'decision.rejected' with the same " +
    "decision_id. PASS drafted_body AND sent_body whenever you can see the final text — a rewrite in the " +
    "conversation, a pasted-back version, a revision you produced on request. Without them the verdict is " +
    "stored UNVERIFIED and counts toward nothing, so reporting 'edited' with no text is the same as saying " +
    "nothing. On the verdict, " +
    "say what the correction MEANT — you are the only one who heard it: {interpretation:'cut the pricing " +
    "paragraph', correction_kind:'rule'|'structure'|'claim'|'constraint'|'none', correction_scope:'once'|" +
    "'person'|'workspace'|'product'}. 'none' and 'once' are correct most of the time; a typo or a detail only " +
    "they knew teaches nothing, and recording it crowds out the real signal. Ask 'just this one, or always?' " +
    "only when you genuinely cannot tell. Then pass that " +
    "same decision_id on the interaction observation when the action fires. That is what turns advice into " +
    "learnable data — without it a send is an orphan nobody can grade.",
    {
      focus: z.string().describe("Email address, LinkedIn URL, domain, or entity UUID — a precise identifier, never a bare name"),
      observations: z.array(z.object({
        kind: z.enum(["event", "state"]).describe("event = an interaction; state = a fact"),
        property: z.string().describe("e.g. 'interaction.email_sent' or 'job_title'"),
        value: z.any().optional().describe("the event detail or the fact value; null = the fact ended"),
        source: z.string().optional().describe("where this came from — provider slug, e.g. 'fireflies', 'gmail' (default: agent)"),
        method: z.string().optional().describe("api | webhook | extraction | inference | user_input (default: api)"),
        observed_at: z.string().optional().describe("ISO timestamp of WHEN this happened/was true. REQUIRED when importing history — otherwise it's stamped now."),
        external_id: z.string().optional().describe("idempotency key, unique per (source). Re-recording the same one is a no-op. One raw item → many observations → give each a distinct id, e.g. '<itemId>:<property>'."),
        source_ref: z.string().optional().describe("pointer to the raw this came from, e.g. 'git://<repo>/raw/fireflies/2026-03-14-9182.md'. Keeps provenance without storing raw in Nous."),
        content_hash: z.string().optional().describe("sha256 of the raw file, so a later fetch can be verified untampered. Set when raw lives in git (not sent here)."),
        decision_id: z.string().optional().describe("the recommendation this action came from. Stamp it on the interaction observation you record when the action fires (an email send, a LinkedIn message) and Nous attributes whatever comes back — reply, meeting, bounce, silence — to that decision."),
      })).describe("One or more observations to record"),
    },
    async ({ focus, observations }) => {
      const result = await post("/v2/observations", { focus, observations });
      const sent = observations?.length ?? 0;
      // Say what was sent alongside what landed, so a partial write reads as partial
      // instead of as a smaller success (GET-369).
      const head = result.rejected?.length
        ? `Recorded ${result.recorded} of ${sent} observation${sent !== 1 ? "s" : ""}.`
        : `Recorded ${result.recorded} observation${result.recorded !== 1 ? "s" : ""}.`;
      const parts = [head];
      // Name every refusal and why. A guard that drops silently is indistinguishable from
      // a write that never happened, which is how a whole category of facts disappeared for months.
      for (const r of result.rejected ?? []) {
        parts.push(`REFUSED${r.external_id ? ` ${r.external_id}` : ""}${r.property ? ` (${r.property})` : ""}: ${r.reason}`);
      }
      if (result.claims_recomputed?.length) {
        parts.push(`Facts updated: ${result.claims_recomputed.join(", ")}.`);
      }
      // A call_review observation comes back as a stored scorecard + Call page (GET-260).
      for (const r of result.call_reviews ?? []) {
        if (r.status === "stored") {
          parts.push(`Call review stored: ${r.overall}/10${r.next_step_secured ? ", next step secured" : ""}${r.merged_into_existing_call ? " (merged into the call another recording opened)" : ""}.${r.page_url ? ` Call page: ${r.page_url}` : ""}`);
        } else if (r.status === "not_sales") {
          parts.push(`Call review not stored: the review says this was a ${r.call_type} call, and only sales calls get a scorecard.`);
        } else if (r.status === "unusable") {
          parts.push(`Call review rejected: ${r.error}. Use these dimension keys: ${(r.expected_keys ?? []).join(", ")}.`);
        } else {
          parts.push(`Call review failed: ${r.error ?? r.status}.`);
        }
      }
      parts.push(`(entity_id: ${result.entity_id})`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }
  );


  // ===========================================================================
  // TOOL: record_insight  —  POST /v2/insights
  // The mirror of record. record captures facts ABOUT the contact; this captures
  // what a call/email taught us about OUR OWN business — product, positioning,
  // market, buyer. Workspace-level (about us, no focus). Feeds the Insights page
  // and theme clustering. In the plugin model the extraction runs on the agent's
  // own tokens, so this is where those insights land.
  // ===========================================================================
  tool(
    "record_insight",
    "Record what a call or email taught us about OUR OWN business — our product, positioning, " +
    "market, or buyer. This is the MIRROR of record: record captures facts about the CONTACT; this " +
    "captures what we learned about US. It is always heard from someone: focus is who said it or " +
    "their account (email, domain, LinkedIn URL or entity id, never a bare name), which ties the " +
    "insight to that account so it counts there and get_insights returns it. Pass the call's " +
    "source_ref (the one you sent record) when there is one. category is one of product | " +
    "positioning | market | buyer. Include the verbatim quote and who said it whenever you can. " +
    "Send all insights from one source in a single call. Do NOT put contact facts here — use record.",
    {
      insights: z.array(z.object({
        category: z.enum(["product", "positioning", "market", "buyer"]).describe("which lens this is about"),
        content: z.string().describe("the insight in one clear sentence, stated from OUR perspective"),
        quote: z.string().optional().describe("the verbatim thing they said that supports it"),
        speaker: z.string().optional().describe("who said it — a name or a role"),
        focus: z.string().optional().describe("this insight's person or account, when it differs from the top-level focus"),
      })).describe("one or more insights extracted from the same call/email"),
      focus: z.string().describe("who said it or their account: email, domain, LinkedIn URL or entity id"),
      source_ref: z.string().optional().describe("where it was said: the call or email's source_ref, as sent to record"),
      source_label: z.string().optional().describe("where these came from, e.g. 'Acme discovery call'"),
      occurred_at: z.string().optional().describe("ISO timestamp of the call/email"),
    },
    async ({ insights, focus, source_ref, source_label, occurred_at }) => {
      const r = await post("/v2/insights", { insights, focus, source_ref, source_label, occurred_at });
      return { content: [{ type: "text", text:
        `Recorded ${r.written} insight${r.written !== 1 ? "s" : ""}` +
        (r.submitted && r.written < r.submitted ? ` (${r.submitted - r.written} were duplicates)` : "") +
        (r.accounts?.length ? `, tied to ${r.accounts.length === 1 ? "account " + r.accounts[0] : r.accounts.length + " accounts"}` : "") +
        ". They show in get_insights once the nightly sort places them." }] };
    }
  );

  // ===========================================================================
  // TOOL: set_icp  —  PUT /v2/icp
  // Write the workspace's ICP (the buyer definition + scoring rules). The API saves the text and
  // builds a scoring model from it ONLY when none exists yet: an existing model is never rebuilt
  // here, so what the learning loop trained on real outcomes is not wiped by a text edit.
  // ===========================================================================
  tool(
    "set_icp",
    "Write (or replace) this workspace's ICP as markdown (body_md): who the ideal customer is, plus the " +
    "scoring rules (a base, persona weights, firmographic weights, observed-signal boosts/cuts, and hard " +
    "disqualifiers). The written ICP is replaced and versioned. The SCORING MODEL that score, get_context and " +
    "the reports use is built from it only when the workspace has no model yet (a fresh workspace: whoami's " +
    "setup says whether an ICP is set). When a model already exists it is KEPT as is, so the outcome-trained " +
    "weights survive a text edit; the result says which happened. Read the current ICP first with " +
    "query { scope: { foundation: 'icp' } } and keep what is still true. Authoring guide + required sections: " +
    "the onboard skill's icp-authoring reference.",
    {
      body_md: z.string().describe("the full ICP as markdown — the buyer definition + the scoring rules (see the icp-authoring reference for the required sections)"),
    },
    async ({ body_md }) => {
      const r = await put("/v2/icp", { body_md });
      const v = r.icp?.version;
      const lines = [`ICP saved${v ? ` (v${v})` : ""}.`];
      const m = r.model ?? {};
      const n = Array.isArray(m.signals) ? m.signals.length : null;
      const sig = n != null ? ` (${n} signal${n === 1 ? "" : "s"})` : "";
      switch (m.status) {
        case "created":
          lines.push(`Scoring model built from it${sig}. score / get_context now judge accounts against this ICP.`);
          break;
        case "exists":
          lines.push(`A scoring model already existed, so it was NOT rebuilt${sig}: score / get_context keep using it, ` +
            "including what it learned from closed deals. The new text is what query { scope: { foundation: 'icp' } } " +
            "returns and what the next model build reads. Tell the operator the scores themselves have not changed.");
          break;
        case "no_icp_memory":
          lines.push("No scoring model was built: the engine found no ICP text to build from. Check body_md was not empty and retry.");
          break;
        case "translation_failed":
          lines.push("No scoring model was built: it came back empty. Make sure the ICP has the scoring sections " +
            "(base, persona and firmographic weights, signal boosts/cuts, disqualifiers), then set it again.");
          break;
        case "external_scorer":
          lines.push("No scoring model was built: this workspace scores accounts with its own scorer and posts them " +
            "with score { scorer, scores }. The ICP text is saved for agents to read.");
          break;
        case "build_failed":
          lines.push("The text is saved, but building the scoring model failed. score keeps the previous model, if any. Say so.");
          break;
        default:
          lines.push(m.status ? `Model status: ${m.status}.` : "No model status came back.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: record_closed_deals  —  POST /v2/workspace/closed-deals
  // Train the ICP on REAL outcomes. set_icp writes the hypothesis; this upgrades
  // it to an outcome-graded model: feed the won and lost domains (the CRM/Stripe
  // closed cohorts), the engine runs contrastive lift — what separates wins from
  // losses — links known contacts, resolves their open predictions with the real
  // outcome, and re-scores every open account. The onboarding + win-loss payoff.
  // ===========================================================================
  tool(
    "record_closed_deals",
    "Train this workspace's ICP on REAL closed deals. Pass the won and lost deals (each a bare " +
    "domain, or an object {domain, amount, currency, closed_at}). The engine enriches each domain, " +
    "links the contacts you already have there, resolves their open ICP predictions with the real " +
    "outcome, runs contrastive lift (the signals that separate wins from losses), and re-scores every " +
    "open account against the upgraded model. Use it in onboarding once the backfill has landed the " +
    "closed cohorts (pull them with query scope.property:'stage' — accounts at 'closed_won' and " +
    "'closed_lost'), and whenever new deals close. Needs at least one deal; both sides (some won AND " +
    "some lost) make the lift trustworthy — one side alone is directional only. The ICP is the one " +
    "company model, so this is an admin/founder action.",
    {
      won:  z.array(CLOSED_DEAL).optional().describe("Closed-WON deals — bare domains or {domain, amount, currency, closed_at}. Pull from accounts at stage 'closed_won'."),
      lost: z.array(CLOSED_DEAL).optional().describe("Closed-LOST deals — same shape. Pull from accounts at stage 'closed_lost'."),
    },
    async ({ won = [], lost = [] }) => {
      const r = await post("/v2/workspace/closed-deals", { won, lost });
      if (r.need_more_deals || r.error === "need_more_deals") {
        return { content: [{ type: "text", text:
          "Need at least one closed deal (a won or lost domain) to train the ICP. Pull the closed cohorts with query scope.property:'stage', then pass their domains." }] };
      }
      const lines = [
        `ICP trained on real outcomes — ${r.won || 0} won · ${r.lost || 0} lost` +
        (r.enriched ? ` · ${r.enriched} companies enriched` : "") +
        (r.surfaced ? ` · ${r.surfaced} predictions resolved` : "") + ".",
      ];
      if ((r.discovered || []).length) {
        lines.push("", "Signals the model learned (contrastive lift, won vs lost):");
        for (const d of r.discovered) {
          const dir = (d.weight ?? 0) > 0 ? "+" : "";
          lines.push(`  • ${d.label}  [${dir}${d.weight}]${d.note ? ` — ${d.note}` : ""}`);
        }
      }
      if ((r.linked || []).length) {
        const names = r.linked.map(l => l.name).filter(Boolean);
        lines.push("", `Linked ${r.linked.length} known contact${r.linked.length !== 1 ? "s" : ""} to these deals` +
          (names.length ? `: ${names.slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}` : "") + ".");
      }
      lines.push("", "Open accounts have been re-scored. score / get_context now reflect the outcome-graded ICP.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: query  —  POST /v2/query
  // Retrieve a corpus of activity across many people. You do the analysis.
  // ===========================================================================
  tool(
    "query",
    "Retrieve and summarise activity across many people. Three powers:\n" +
    "  1. return:'entities' groups results by person/company (one row per entity, ranked by " +
    "most-recent matching activity). Use for 'hottest leads', 'who replied this week', " +
    "'who's in the negotiation stage'.\n" +
    "  2. `without` subtracts entities — 'sent in 5d MINUS replied in 5d' = 'no-reply leads'. " +
    "'activity in 30d MINUS activity in 5d' = 'cooled leads'.\n" +
    "  3. rollups.by_value appears when scope.kind='state' — counts entities by current value " +
    "(use scope.property='stage' for funnel reports).\n" +
    "  4. Scheduled meetings/calls are events with property 'interaction.meeting_scheduled' and a " +
    "future-dated `when`. For 'what's booked today/this week', set property:'interaction.meeting_scheduled' " +
    "with from/to bounding the day or week (since_days only looks backward and can't reach them), and " +
    "order:'asc' to list soonest-first. Meeting rows render the absolute date and time.\n" +
    "  5. scope.facts:true + question searches the FACTS corpus (durable atomic facts about accounts) " +
    "instead of activity — cross-account semantic fact search like 'which accounts want off Clay' or " +
    "'who is hiring'. return:'entities' gives the single best-matching fact per account. (A single " +
    "account's facts already come back inline with get_account.) READ THE ICP ITSELF with scope:{foundation:'icp'} — the buyer definition and the scoring rules, not another number derived from them. Do that before triaging a list or arguing with a score, so the judgement is one you can explain.",
    {
      scope: z.object({
        kind: z.enum(["event", "state"]).optional(),
        property: z.string().optional().describe("property prefix — 'interaction.email' covers email_sent and email_replied; 'interaction.meeting_scheduled' for booked meetings"),
        source: z.string().optional().describe("e.g. 'gmail', 'linkedin', 'slack'"),
        entity_id: z.string().optional().describe("scope to one person/company"),
        since_days: z.number().optional().describe("only activity within the last N days (backward only)"),
        from: z.string().optional().describe("ISO timestamp — only activity at/after this (absolute lower bound; use for date windows like 'today')"),
        to: z.string().optional().describe("ISO timestamp — only activity at/before this (absolute upper bound). Combine from+to for a window; future-dated for upcoming meetings"),
        order: z.enum(["asc", "desc"]).optional().describe("observed_at order (default desc, newest first). Use 'asc' for an upcoming-meeting schedule (soonest first)"),
        limit: z.number().optional().describe("max items (default 50, cap 200)"),
        facts: z.boolean().optional().describe("search the FACTS corpus (durable atomic facts about accounts) instead of activity. Needs `question` — a cross-account semantic fact search, e.g. 'which accounts want off Clay'. return:'entities' = the best matching fact per account."),
        reporting: z.enum(["company", "role"]).optional().describe("Return the distilled REPORTING for a seat instead of activity: 'role' = the insights routed to a GTM role (deal-blockers/objections with account counts + relevant themes, reframed for that seat); 'company' = the whole-company founder lens. Routed server-side by the caller's role — a member only ever gets their own seat, an admin/founder can ask for 'company' or any role."),
        role: z.string().optional().describe("With reporting:'role', which seat to report for — account_executive | sdr | sales | customer_success | engineer | marketing | revops | founder. Defaults to the caller's own role(s) from whoami."),
        attention: z.enum(["mine"]).optional().describe("Return the daily WORKLIST instead of activity: the engine-curated Studio surface — upcoming meetings, the follow-ups you owe, and the accounts to focus on (open attention flags) — scoped to the caller (a member sees only their owned book; an admin/founder sees the whole workspace). Powers the morning read."),
        foundation: z.enum(["icp"]).optional().describe("Return a FOUNDATION document as written instead of activity: 'icp' = the ICP itself, the buyer definition and the scoring rules, not another number derived from them. Read this before triaging a list, planning an account, or arguing with a score, so the judgement is one you can explain."),
      }).describe("Corpus filter"),
      without: z.object({
        kind: z.enum(["event", "state"]).optional(),
        property: z.string().optional(),
        source: z.string().optional(),
        entity_id: z.string().optional(),
        since_days: z.number().optional(),
      }).optional().describe("Subtract entities matching this scope from the result — same shape as scope. Enables 'sent but no reply', 'cooled in last N days'."),
      return: z.enum(["observations", "entities"]).optional()
        .describe("observations (default) = one row per observation. entities = one row per entity, ranked by most-recent matching activity."),
      question: z.string().optional().describe("What you want to learn — echoed back; enables semantic ranking"),
    },
    async ({ scope, without, return: returnMode, question }) => {
      const body = { scope, question };
      if (without)    body.without = without;
      if (returnMode) body.return  = returnMode;
      const r = await post("/v2/query", body);

      // Reporting response (scope.reporting) — distilled handlers + themes for a seat.
      if (r.role_label !== undefined || r.reporting) {
        const out = [`REPORTING · ${r.role_label || r.role}${r.reporting === "company" ? " (whole-company lens)" : ""}`, ""];
        if ((r.handlers || []).length) {
          out.push("DEAL BLOCKERS / OBJECTIONS (by accounts raising them):");
          for (const h of r.handlers) {
            out.push(`  • ${h.title}${h.account_count ? `  — ${h.account_count} account${h.account_count !== 1 ? "s" : ""}` : ""}` +
                     (h.objection_summary ? `\n      ${h.objection_summary}` : ""));
          }
          out.push("");
        }
        if ((r.themes || []).length) {
          out.push("SIGNALS / THEMES for this seat:");
          for (const t of r.themes) out.push(`  • ${t.title}${t.takeaway ? ` — ${t.takeaway}` : ""}`);
        }
        if (!(r.handlers || []).length && !(r.themes || []).length) {
          out.push("Nothing distilled for this seat yet — run some ingest/backfill so the reporting has material.");
        }
        return { content: [{ type: "text", text: out.join("\n").trim() }] };
      }

      // Worklist response (scope.attention='mine') — the daily Studio surface.
      if (r.attention) {
        const out = [`WORKLIST · ${r.scope === "member" ? "your book" : "whole workspace"}`, ""];
        const mt = r.upcoming_meetings || [], fu = r.follow_ups || [], af = r.accounts_to_focus || [];
        if (mt.length) { out.push("UPCOMING MEETINGS:"); for (const m of mt) out.push(`  • ${m.account || "(unknown)"}${m.when ? `  — ${m.when}` : ""}`); out.push(""); }
        if (fu.length) { out.push("FOLLOW UP ON:"); for (const i of fu) out.push(`  • ${i.title}${i.account ? `  (${i.account})` : ""}${i.due ? ` — ${i.due}` : ""}`); out.push(""); }
        if (af.length) { out.push("ACCOUNTS TO FOCUS ON:"); for (const f of af) out.push(`  • ${f.account || "(account)"}${f.flag_type ? `  [${f.flag_type}]` : ""}${f.reason ? ` — ${f.reason}` : ""}`); }
        if (!mt.length && !fu.length && !af.length) out.push("Nothing on your worklist right now — nothing scheduled, owed, or flagged. Run some ingest/backfill if this looks empty on a live workspace.");
        return { content: [{ type: "text", text: out.join("\n").trim() }] };
      }

      const head = `${r.matched} match${r.matched !== 1 ? "es" : ""}` +
                   (r.sampled ? ` (showing ${r.returned})` : "") +
                   (r.corpus === "facts" ? " · facts" : r.return === "entities" ? " · grouped by entity" : "");
      const roll = Object.entries(r.rollups?.by_type ?? {})
        .map(([t, n]) => `${n}× ${fmtType(t)}`).join(" · ");
      const lines = [head, roll].filter(Boolean);
      if (r.rollups?.by_value && Object.keys(r.rollups.by_value).length) {
        lines.push("BY VALUE: " + Object.entries(r.rollups.by_value).map(([v, n]) => `${v}: ${n}`).join(", "));
      }
      lines.push("");
      for (const it of r.items ?? []) {
        if (r.corpus === "facts") {
          lines.push(`  ${it.entity_name ?? it.entity_id}  [${it.category}] ${it.content}` +
                     (it.date ? `  [${relAge(it.date)}]` : "") +
                     (it.similarity != null ? `  (${it.similarity})` : ""));
        } else if (r.return === "entities") {
          lines.push(`  ${it.entity_name ?? it.entity_id}  ` +
                     `(${it.matches} match${it.matches !== 1 ? "es" : ""}, last ${whenLabel(it.most_recent_type, it.most_recent_at)})` +
                     (it.most_recent_value != null ? `  → ${fmtVal(it.most_recent_value)}` : "") +
                     (it.most_recent_summary ? `\n      ${it.most_recent_summary}` : ""));
        } else {
          lines.push(`  ${whenLabel(it.type, it.when)}  ${it.entity_name ?? it.entity_id}  ` +
                     `${fmtType(it.type)}${it.summary ? `: ${it.summary}` : ""}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );

  // ===========================================================================
  // TOOL: score  —  POST /v2/score
  // The thin scoring verb an external list (spreadsheet, Clay column, agent)
  // calls to get Nous's judgment on a row and have it land in the graph. The
  // list stays wherever the user built it; Nous owns the score. Read-mostly:
  // returns the live ICP fit + intent, bootstrap-staking a known-but-unscored
  // row on demand. Cheaper and leaner than get_context on purpose.
  // ===========================================================================
  const scoreOne = (r) => {
    if (!r.resolved) {
      if (r.reason === "ambiguous") {
        const names = (r.candidates || []).map(c => c.name || c.entity_id).join(", ");
        return `ambiguous — several people match${names ? `: ${names}` : ""}. Score by email or LinkedIn URL instead.`;
      }
      return "not in the graph yet — pass the lead's `attributes` (title, company, keywords) to score it inline, or enrich the account first.";
    }
    const layers = r.layered && r.layered.layers ? r.layered.layers : {};
    const layerLine = Object.keys(layers).length ? `\n    layers: ${Object.entries(layers).map(([k, v]) => `${k} ${v}`).join(" · ")}` : "";
    const work = (r.layered && r.layered.missing && r.layered.missing.length)
      ? `\n    unknown: ${r.layered.missing.join(", ")} — ${r.layered.play || "enrich to resolve"}` : "";
    if (!r.scored) {
      // 'partial' — Fit/Pain resolved live (not staked). Show what we know + the worklist.
      if (Object.keys(layers).length) return `partial fit${layerLine}${work}`;
      return `known, but awaiting enrichment — no scoreable claims yet (${r.entity_id}).`;
    }
    const tier = (r.icp.tier || "").replace(/_/g, " ") || "untiered";
    const inline = r.source === "inline" ? " · scored inline (not in the graph)" : "";
    return `ICP ${r.icp.score}/100 (${tier})${r.icp.fit ? " ✓fit" : ""} · intent ${r.intent.score}/100 ${r.intent.band}${inline}` +
           layerLine + work + (r.icp.reason ? `\n    ${r.icp.reason}` : "");
  };
  tool(
    "score",
    "Score a lead against our live ICP model and intent axis, and write the judgment into the graph so " +
    "every other agent reads the same number. This is for scoring a list the user built ELSEWHERE (a " +
    "Google Sheet, a Clay column, a CRM export): the list stays where it is, Nous returns the score. " +
    "Give an email, domain, LinkedIn URL, or entity UUID (or up to 100 at once via `identifiers`). " +
    "Returns ICP fit 0-100 + tier (tier_1/2/3/not_icp, which drives the play), decaying intent " +
    "0-100 + band, AND the LAYERED read: layers {fit,pain,intent,ability} with a `missing` worklist " +
    "(what's still unknown — unknown is never 0) and a suggested `play`. It reads the live score " +
    "(staking one on demand for a known-but-unscored account); the score keeps evolving afterwards. " +
    "COLD LEAD not in Nous? Pass `attributes` (title, company, keywords/headline) and it's scored " +
    "INLINE against the model — Fit/Pain resolve from what you have, nothing is written. For a whole " +
    "EXTERNAL list, pass `leads` (up to 1000 attribute objects) — all scored inline in one call, model " +
    "loaded once, nothing written — so you can triage a big list before deciding what to bring in. Only " +
    "a bare identifier with no attributes and no graph record comes back `unknown_identifier`. " +
    "BRING YOUR OWN SCORER: when the workspace scores with its own system (whoami / GET /v2/icp/scorer says " +
    "'external'; the API plan does by default), pass `scorer` (your model's name) and `scores` " +
    "[{identifier, score 0-100, tier?, reason?}] to WRITE your scores onto the record instead. They become " +
    "the fit every other agent reads, and Nous grades them against won/lost.",
    {
      identifier: z.string().optional().describe("One lead — an email, domain, LinkedIn URL, or entity UUID."),
      identifiers: z.array(z.string()).optional().describe("A batch of graph leads (max 100 per call; loop for a larger list)."),
      attributes: z.record(z.any()).optional().describe("For a COLD lead NOT in Nous: its attributes from LinkedIn/a list — { job_title, seniority, company_type, industry, employee_count, keywords or headline, location }. Scored inline against the model; nothing is written. Use when the identifier isn't in the graph yet, or pass on its own with no identifier."),
      leads: z.array(z.record(z.any())).optional().describe("An EXTERNAL cold list scored inline in one call (up to 1000): each item is an attributes object { job_title, company_type, keywords|headline, ... }, optionally with a `ref` echoed back. Nothing is written to the graph. Use to triage a big list before deciding which accounts to bring in."),
      intent: z.string().optional().describe("Optional hint about why you're scoring. Currently ignored; it does not change the score."),
      scorer: z.string().optional().describe("With `scores`: the name of YOUR scoring model, e.g. 'acme-v3' (letters, digits, . _ - /). Stamped on each score."),
      scores: z.array(z.object({
        identifier: z.string().describe("email, domain, LinkedIn URL, or entity UUID of an account already in Nous"),
        score: z.number().min(0).max(100).describe("your 0-100 fit score"),
        tier: z.enum(["tier_1", "tier_2", "tier_3", "not_icp"]).optional().describe("your tier; omitted, it is derived from the workspace's tier bands"),
        reason: z.string().optional().describe("one line on why — shows on the record and in the score trail"),
      })).optional().describe("WRITE scores from your own scorer (up to 500). Needs `scorer`, and a workspace that scores for itself."),
    },
    async ({ identifier, identifiers, intent, attributes, leads, scorer, scores }) => {
      if (Array.isArray(scores) && scores.length) {
        const r = await post("/v2/scores", { scorer, scores });
        if (r.error === "scorer_not_external") {
          return { content: [{ type: "text", text:
            "Not written: this workspace is scored by Nous's own model. Switching it to your own scorer is an operator " +
            "decision (PUT /v2/icp/scorer { scorer: 'external' }); ask before doing it." }] };
        }
        if (r.error) return { content: [{ type: "text", text: `Not written: ${r.error}${r.hint ? ` — ${r.hint}` : ""}` }] };
        const rows = r.results || [];
        const ok = rows.filter(x => x.resolved && !x.error);
        const missed = rows.filter(x => !x.resolved || x.error);
        const lines = [`Wrote ${ok.length}/${rows.length} scores from ${r.scorer}.`];
        for (const x of missed.slice(0, 20)) lines.push(`  ${x.identifier ?? "(no identifier)"} — ${x.error || x.reason}`);
        if (missed.some(x => x.reason === "unknown_identifier")) lines.push("Unknown identifiers are not in Nous yet: record them first, then score.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (Array.isArray(leads) && leads.length) {
        const r = await post("/v2/score", { leads });
        const rows = r.results || [];
        const scored = rows.filter(x => x.scored);
        const byTier = {};
        for (const x of scored) { const t = (x.icp?.tier || "untiered").replace(/_/g, " "); byTier[t] = (byTier[t] || 0) + 1; }
        const dist = Object.entries(byTier).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" · ") || "none";
        return { content: [{ type: "text", text: `Scored ${scored.length}/${rows.length} inline (nothing written). Tiers: ${dist}` }] };
      }
      if (Array.isArray(identifiers) && identifiers.length) {
        const r = await post("/v2/score", { identifiers, intent });
        const lines = (r.results || []).map(x => `  ${x.identifier} — ${scoreOne(x)}`);
        const scored = (r.results || []).filter(x => x.scored).length;
        return { content: [{ type: "text", text: `Scored ${scored}/${(r.results || []).length}:\n${lines.join("\n")}` }] };
      }
      const r = await post("/v2/score", { identifier, intent, attributes });
      return { content: [{ type: "text", text: `${identifier || "cold lead"} — ${scoreOne(r)}` }] };
    }
  );









  // (Retired 2026-08-22) propose_vault_file — the agent no longer authors files into a
  // member's personal vault. The vault surface is now the Sync page only (connect a repo);
  // Nous auto-pushes account/people EVIDENCE to `nous/` in that repo, and agent-authored
  // knowledge lives Nous-side (save_note on the account record), not as approval-gated files.
  // The inbox approval flow was retired with it. See AIOS decisions/log.md 2026-08-22.


















  // ===========================================================================
  // Public-API parity (2026-09-30). Each documented door of the public API has its own tool:
  // the people / accounts / deals lists (find), attention, the Insights board, notes and one-person
  // enrichment. Thin clients of the same /v2 routes the API documents.
  // ===========================================================================

  // ===========================================================================
  // TOOL: find  —  GET /v2/people · GET /v2/accounts · GET /v2/deals
  // The three lists, one tool. Each list honours its own filters; buildFindQuery checks them
  // here so a wrong one comes back as a sentence, not a raw 400.
  // ===========================================================================
  tool(
    "find",
    "FIND people, accounts or deals by filter: the lists, not one record. Pick `kind`, then filter and sort. " +
    "Examples:\n" +
    "  • deals closing this month → { kind: 'deals', filters: { status: 'open', closing_within_days: 30 }, sort: 'close_date' }\n" +
    "  • deals most likely to win → { kind: 'deals', filters: { status: 'open' }, sort: 'win_probability' }\n" +
    "  • ICP-fit accounts gone quiet → { kind: 'accounts', filters: { icp_fit: true, last_activity_before: '30d' } }\n" +
    "  • accounts most likely to close → { kind: 'accounts', sort: 'win_chance' }\n" +
    "  • who at acme.com → { kind: 'people', filters: { account: 'acme.com' } }\n" +
    "  • do we have sarah@acme.com → { kind: 'people', filters: { email: 'sarah@acme.com' } }\n" +
    "FILTERS BY KIND (anything else is refused with the reason):\n" +
    "  people: stage, source, status, has_email, has_linkedin, email, linkedin_url, icp_fit, min_icp_score, " +
    "last_activity_before/after, account, include_all (also cold leads; then only stage, email, has_email, icp_fit, " +
    "min_icp_score, last_activity_*, account). Sorts: last_activity, last_activity_asc, icp_score, icp_score_asc, recently_added.\n" +
    "  accounts: stage, icp_fit, min_icp_score, owner, country, has_open_deal, last_activity_before/after, include_all " +
    "(skip the list window). Sorts: last_activity, icp_score, pipeline_value, health, win_chance (only accounts with an open deal, max 50).\n" +
    "  deals: account, pipeline (id from the CRM), status (open|won|lost), stage, owner, closing_within_days, min_amount, " +
    "implied. No text search. Sorts: last_activity, close_date, amount, win_probability.\n" +
    "Stages are canonical: identified, connected, interested, meeting_booked, discovery, demo, negotiation, closed_won, " +
    "closed_lost, disqualified, churned. A deal with `implied` is an account with no CRM deal (id implied:<account_id>). " +
    "Open one row with get_context { focus: <its id> } — that works for people, accounts and deals.",
    {
      kind: z.enum(["people", "accounts", "deals"]).describe("Which list."),
      search: z.string().optional().describe("people: name, email, company or LinkedIn contains. accounts: name, domain or email contains. Not for deals."),
      filters: z.object({
        stage: z.string().optional().describe("Canonical stage, e.g. demo, negotiation, closed_won. people/accounts/deals."),
        icp_fit: z.boolean().optional().describe("ICP score >= 70 (true) or not (false). people/accounts."),
        min_icp_score: z.number().optional().describe("0-100. people/accounts."),
        last_activity_before: z.string().optional().describe("Gone quiet: no activity in this long, e.g. '30d', '12h' (includes never active). people/accounts."),
        last_activity_after: z.string().optional().describe("Active within this long, e.g. '7d'. people/accounts."),
        account: z.string().optional().describe("One account: domain, entity UUID, email or name. people/deals."),
        owner: z.string().optional().describe("CRM owner email (or name). accounts/deals."),
        country: z.string().optional().describe("Exact country. accounts."),
        has_open_deal: z.boolean().optional().describe("accounts."),
        include_all: z.boolean().optional().describe("people: everyone incl. cold leads (fewer filters). accounts: skip the list window (by default: an open or won deal, a recent loss, or recent activity)."),
        status: z.string().optional().describe("deals: open | won | lost. people: record status, e.g. active."),
        pipeline: z.string().optional().describe("CRM pipeline id. deals."),
        closing_within_days: z.number().optional().describe("Open deals whose close date is between today and N days out. deals."),
        min_amount: z.number().optional().describe("Amount at least this (deals without an amount drop out). deals."),
        implied: z.boolean().optional().describe("true = only implied deals, false = only CRM deals. deals."),
        source: z.string().optional().describe("Where the person came from, e.g. hubspot, linkedin, gmail, manual. people."),
        has_email: z.boolean().optional().describe("people."),
        has_linkedin: z.boolean().optional().describe("people."),
        email: z.string().optional().describe("Exact email lookup. people."),
        linkedin_url: z.string().optional().describe("Exact LinkedIn URL lookup. people."),
      }).optional().describe("Only the filters the chosen kind supports (see the description)."),
      sort: z.enum(["last_activity", "last_activity_asc", "icp_score", "icp_score_asc", "recently_added",
        "pipeline_value", "health", "win_chance", "close_date", "amount", "win_probability"]).optional()
        .describe("Default last_activity (newest first). Each kind has its own set (see the description)."),
      limit: z.number().optional().describe("Page size (default 50 for accounts/deals, 100 for people)."),
      offset: z.number().optional().describe("Rows to skip, for paging."),
    },
    async (args) => {
      const built = buildFindQuery(args);
      if (built.error) return { content: [{ type: "text", text: `Not run: ${built.error}` }], isError: true };
      const r = await get(built.path, built.query);
      const rows = r[args.kind] ?? [];
      const noun = args.kind === "people" ? (rows.length === 1 ? "person" : "people")
        : args.kind === "accounts" ? (rows.length === 1 ? "account" : "accounts") : (rows.length === 1 ? "deal" : "deals");
      const head = `${rows.length} ${noun}` + (r.offset ? ` (from ${r.offset})` : "") +
        (args.sort ? ` · sorted by ${args.sort}` : "") +
        (r.has_more ? ` · more available, page with offset ${(r.offset ?? 0) + rows.length}` : "");
      const line = args.kind === "people" ? personLine : args.kind === "accounts" ? accountLine : dealLine;
      const lines = [head, ...rows.map(line)];
      if (!rows.length) lines.push("Nothing matches those filters.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: enrich  —  POST /v2/people/:id/enrich · POST /v2/accounts/:id/enrich (GET-669)
  // ===========================================================================
  tool(
    "enrich",
    "ENRICH one person, or one company, on the workspace's OWN providers (Apollo / Findymail / Prospeo, its keys; " +
    "Nous adds no data of its own). A person: title, email, LinkedIn, company, phone, location. A company " +
    "(`account`: domain or account id): industry, size, location, keywords, description, tech stack, which every " +
    "person there inherits, so it fills the FIT part of their scores. Re-scores on the live ICP. Anything " +
    "enriched in the last 90 days comes back from what we already hold, nothing spent; pass force:true to buy it " +
    "again. Spends the workspace's enrichment credits: enrich what you are about to work, not a whole list.",
    {
      person: z.string().optional().describe("The person: entity UUID, email, or LinkedIn URL (not a name; find { kind: 'people', search } first)."),
      account: z.string().optional().describe("Instead of a person, a company: its domain (acme.com) or account entity id."),
      force: z.boolean().optional().describe("Re-enrich even inside the 90-day reuse window. Spends a credit."),
    },
    async ({ person, account, force }) => {
      if (account) {
        const r = await post(`/v2/accounts/${encodeURIComponent(String(account).trim())}/enrich`, force ? { force: true } : {});
        const text = r.cached
          ? `${account} was already enriched ${r.last_enriched_at ? `on ${day(r.last_enriched_at)}` : "recently"}${r.provider ? ` via ${r.provider}` : ""} (inside the 90-day window): nothing spent. Pass force:true to re-buy.`
          : r.enriched
            ? `Enriched ${account} via ${r.provider}: ${r.fields_added.join(", ")}.${r.rescored_people ? ` Re-scored ${r.rescored_people} people there.` : ""}`
            : `No provider had anything on ${account}. Nothing added.`;
        return { content: [{ type: "text", text: `${text}\n(account_id: ${r.account_id})` }] };
      }
      if (!person) return { content: [{ type: "text", text: "Pass a person (email, LinkedIn URL or entity id) or an account (domain or account id)." }], isError: true };
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let id = String(person).trim();
      if (!UUID_RE.test(id)) {
        const found = await get(`/v2/people/${encodeURIComponent(id)}`);
        id = found.person?.entity_id;
        if (!id) return { content: [{ type: "text", text: `No person found for ${person}.` }], isError: true };
      }
      const r = await post(`/v2/people/${encodeURIComponent(id)}/enrich`, force ? { force: true } : {});
      const p = r.person ?? {};
      const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || person;
      const lines = [];
      if (r.cached) {
        lines.push(`${name} was already enriched ${r.last_enriched_at ? `on ${day(r.last_enriched_at)}` : "recently"}` +
          `${r.last_provider ? ` via ${r.last_provider}` : ""} (inside the 90-day window): nothing spent. Pass force:true to re-buy.`);
      } else if (r.enriched) {
        lines.push(`Enriched ${name}${r.provider ? ` via ${r.provider}` : ""}: ` +
          (r.fields_added?.length ? `added ${r.fields_added.join(", ")}.` : "no empty field was filled (existing values confirmed)."));
      } else {
        lines.push(`No provider returned anything new for ${name}. Nothing added.`);
      }
      const now = [
        [p.job_title, p.company].filter(Boolean).join(" at ") || null,
        p.email, p.linkedin_url, p.phone,
        [p.city, p.country].filter(Boolean).join(", ") || null,
        p.icp_score != null && `ICP ${p.icp_score}`,
      ].filter(Boolean);
      if (now.length) lines.push(`  ${now.join(" · ")}`);
      lines.push(`(entity_id: ${id})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: attention  —  GET /v2/attention
  // ===========================================================================
  tool(
    "attention",
    "What needs attention NOW, workspace-wide and ranked: accounts going dark, key facts that have " +
    "decayed, upcoming meetings, open commitments, hot intent, and flags. Each item names the account, " +
    "what happened, a suggested action and where it came from. Use it for 'what should I do today', " +
    "'who's gone quiet', 'what did I promise'. Open commitments carry a task id: when the user says one " +
    "is done, close it with `tasks` (action 'done') so it leaves every worklist. A member key sees its own book.",
    {
      limit: z.number().optional().describe("How many items (default 25, max 100)."),
    },
    async ({ limit }) => {
      const r = await get("/v2/attention", limit ? { limit } : undefined);
      const items = r.items ?? [];
      const m = r.meta ?? {};
      const lines = [`${items.length} item${items.length === 1 ? "" : "s"} · ` +
        `${m.going_dark ?? 0} going dark · ${m.decayed_facts ?? 0} decayed · ${m.upcoming_meetings ?? 0} meetings · ` +
        `${m.open_commitments ?? 0} commitments · ${m.hot_intent ?? 0} hot intent · ${m.flags ?? 0} flags`];
      items.forEach((it, i) => {
        const when = it.when ? ` · ${fmtWhen(it.when)}` : "";
        lines.push(`${i + 1}. [${String(it.kind || "").replace(/_/g, " ")}] ${it.entity_name ?? "(unnamed)"} [${it.entity_id}]${when}`);
        lines.push(`   ${it.what}`);
        if (it.suggested_action) lines.push(`   → ${it.suggested_action}`);
        if (it.task_id) lines.push(`   task: ${it.task_id}`);
        if (it.source) lines.push(`   source: ${it.source}`);
      });
      if (!items.length) lines.push("Nothing needs attention right now.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: tasks  —  GET /v2/action-items · POST /v2/action-items/status
  // The worklist's own items, readable AND closable (GET-830). Without it an agent told "that's
  // done" could only write a note saying so, and the task stayed open in every report.
  // ===========================================================================
  tool(
    "tasks",
    "The TASK LIST: the commitments and next steps Nous extracted from calls, meetings and emails, plus " +
    "tasks people added by hand. One tool to read them and to close them. action 'list' (default) " +
    "returns tasks with a task id, the account, who owes it, the due date and where it came from. " +
    "action 'done' closes tasks by id; 'reopen' puts them back. Use 'done' the moment the user says a " +
    "task is finished (\"I sent the deck\", \"mark those done\"), or when you can see it was done: a " +
    "closed task leaves the Tasks page, attention and every report. Never write a note to say a task " +
    "is done; close it here. Ids come from this tool's list or from attention. To find one task, list " +
    "with `focus` set to the account.",
    {
      action: z.enum(["list", "done", "reopen"]).optional().describe("list (default), done, or reopen."),
      ids: z.array(z.string()).optional().describe("For done/reopen: task ids ('<entity_id>:action_item.…'), up to 100."),
      reason: z.string().optional().describe("For done: what made it done, in a few words, e.g. 'deck sent 10 Oct'. Shown on the task."),
      owner: z.enum(["me", "prospect", "all"]).optional().describe("For list: whose tasks. me (default) = our side; prospect = what they owe us."),
      status: z.enum(["open", "done", "all"]).optional().describe("For list: default open."),
      focus: z.string().optional().describe("For list: one account or person, by entity UUID or email."),
      due: z.enum(["today", "week", "all"]).optional().describe("For list: only tasks due today or within 7 days. Default all."),
      limit: z.number().optional().describe("For list: how many (default 50, max 500)."),
    },
    async ({ action = "list", ids, reason, owner, status, focus, due, limit }) => {
      if (action === "done" || action === "reopen") {
        if (!ids?.length) {
          return { isError: true, content: [{ type: "text", text: "Pass `ids`: the task id of each task to change. Get them from tasks (action 'list') or attention." }] };
        }
        const want = action === "done" ? "done" : "open";
        const r = await post("/v2/action-items/status", { ids, status: want, ...(reason ? { reason } : {}) });
        const results = r.results ?? [];
        const ok = results.filter((x) => x.ok);
        const bad = results.filter((x) => !x.ok);
        const verb = want === "done" ? "Closed" : "Reopened";
        const lines = [`${verb} ${ok.length} of ${results.length} task${results.length === 1 ? "" : "s"}.`];
        for (const x of ok) lines.push(`✓ ${x.title ?? x.id}`);
        for (const x of bad) {
          const why = x.error === "not_found" ? "not found (wrong id, already removed, or not visible to this key)"
            : x.error === "invalid_id" ? "not a task id (expected '<entity_id>:action_item.…')"
            : x.error ?? "failed";
          lines.push(`✗ ${x.id}: ${why}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const n = Math.min(Math.max(1, Math.floor(limit ?? 50)), 500);
      const r = await get("/v2/action-items", {
        owner: owner ?? "me", status: status ?? "open", due: due ?? "all", limit: n,
        ...(focus ? { focus } : {}),
      });
      const items = r.items ?? [];
      const lines = [`${items.length} ${status === "all" ? "" : `${status ?? "open"} `}task${items.length === 1 ? "" : "s"}` +
        `${owner === "prospect" ? " they owe us" : owner === "all" ? "" : " on our side"}` +
        (r.truncated ? ` (first ${n}; more exist: raise limit or narrow with focus/due)` : "")];
      for (const t of items) {
        const who = [t.company, t.account].filter(Boolean).join(" · ") || "(no account)";
        const dueTxt = t.due_at ? ` · due ${String(t.due_at).slice(0, 10)}` : t.due_phrase ? ` · due ${t.due_phrase}` : "";
        const done = t.status === "done" ? ` · done${t.completed_reason ? ` (${t.completed_reason})` : ""}` : "";
        lines.push(`• ${t.title}${dueTxt}${done}`);
        lines.push(`   ${who}${t.owner_name ? ` · owner ${t.owner_name}` : ""}${t.source_type ? ` · from ${t.source_type}` : ""}` +
          `${t.recorded_at ? ` ${String(t.recorded_at).slice(0, 10)}` : ""}`);
        lines.push(`   task: ${t.task_id ?? `${t.entity_id}:${t.id}`}`);
      }
      if (!items.length) lines.push("No tasks match.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // rules — the operator's own rules, said once (GET-846). A CHECKED rule is evaluated in the
  // background: a broken one opens a flag (attention) and a task (tasks) on the account and closes
  // them once met. A GUIDANCE rule only reaches the agent. The agent maps what the user said onto a
  // check from the catalogue, or keeps it guidance; it never invents a check.
  // ===========================================================================
  tool(
    "rules",
    "The user's RULES for their own deals, said once. Add one the moment the user states how their deals " +
    "must go (\"every meeting ends with a dated next step within 48 hours\", \"I reply to buyers within a " +
    "day\", \"lead with ROI for CFOs\"). If it matches a check, pass `check` (and its number) and the engine " +
    "holds them to it in the background: a broken rule raises the account in attention and opens a task, " +
    "and both clear once it is met. Checks: next_step_after_meeting (hours), reply_to_buyer_email (hours), " +
    "stage_without_meeting (days); action 'checks' says what each verifies. A rule that matches none is " +
    "guidance: pass no check, tell the user it is guidance, and apply it yourself. action 'list' (default) " +
    "shows their rules with ids; 'pause', 'resume', 'remove' take `id`. Rules are personal (a member key).",
    {
      action: z.enum(["list", "add", "pause", "resume", "remove", "checks"]).optional().describe("list (default), add, pause, resume, remove, or checks."),
      statement: z.string().optional().describe("For add: the rule in the user's words."),
      check: z.enum(["next_step_after_meeting", "reply_to_buyer_email", "stage_without_meeting"]).optional()
        .describe("For add: the check this rule maps onto. Omit for guidance."),
      hours: z.number().optional().describe("For add: the window in hours (next_step_after_meeting, reply_to_buyer_email)."),
      days: z.number().optional().describe("For add: the window in days (stage_without_meeting)."),
      weight: z.enum(["low", "normal", "high"]).optional().describe("For add: how hard a broken rule pushes the account up. Default normal."),
      id: z.string().optional().describe("For pause/resume/remove: the rule id from list."),
    },
    async ({ action = "list", statement, check, hours, days, weight, id }) => {
      const unit = (r) => {
        const p = r.check?.params ?? {};
        return p.hours != null ? `${p.hours}h` : p.days != null ? `${p.days} days` : "";
      };
      if (action === "checks") {
        const r = await get("/v2/rules/checks");
        const lines = ["Checks a rule can map onto:"];
        for (const c of r.checks ?? []) lines.push(`• ${c.type} (${c.param}, default ${c.default}): ${c.label}. ${c.verifies}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
      if (action === "add") {
        if (!statement?.trim()) {
          return { isError: true, content: [{ type: "text", text: "Pass `statement`: the rule in the user's words." }] };
        }
        const params = check === "stage_without_meeting" ? (days != null ? { days } : {}) : (hours != null ? { hours } : {});
        const body = { statement, ...(check ? { check: { type: check, params } } : {}), ...(weight ? { weight } : {}) };
        const r = await post("/v2/rules", body);
        const rule = r.rule ?? {};
        const how = rule.kind === "checked"
          ? `Rule saved, checked in the background: ${rule.check?.label ?? rule.check?.type} (${unit(rule)})`
          : "Rule saved as guidance (nothing checks it; apply it yourself)";
        return { content: [{ type: "text", text: `${how}.\n"${rule.statement}"\nid: ${rule.id}` }] };
      }
      if (action === "pause" || action === "resume" || action === "remove") {
        if (!id) return { isError: true, content: [{ type: "text", text: "Pass `id`: the rule id from rules (action 'list')." }] };
        if (action === "remove") {
          await del(`/v2/rules/${encodeURIComponent(id)}`);
          return { content: [{ type: "text", text: `Removed rule ${id}. Its open flags and tasks clear on the next check.` }] };
        }
        const r = await patch(`/v2/rules/${encodeURIComponent(id)}`, { status: action === "pause" ? "paused" : "active" });
        const verb = action === "pause" ? "Paused" : "Resumed";
        return { content: [{ type: "text", text: `${verb}: "${r.rule?.statement ?? id}".` }] };
      }
      const r = await get("/v2/rules");
      const rules = r.rules ?? [];
      const lines = [`${rules.length} rule${rules.length === 1 ? "" : "s"}`];
      for (const rule of rules) {
        const how = rule.kind === "checked" ? `checked: ${rule.check?.label ?? rule.check?.type} (${unit(rule)})` : "guidance";
        lines.push(`• ${rule.statement}`);
        lines.push(`   ${how} · ${rule.weight} · ${rule.status}`);
        lines.push(`   id: ${rule.id}`);
      }
      if (!rules.length) lines.push("No rules yet. Add one when the user says how their deals must go.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: get_insights  —  GET /v2/insights
  // ===========================================================================
  tool(
    "get_insights",
    "Read the INSIGHTS BOARD: what customers said about OUR business, each insight placed under the " +
    "team that has to act (lane: product | sales | success | market) and the kind of work (subtype: bug, " +
    "friction, feature, objection, pricing, pitch, setup, training, partners, buyers), tagged with the " +
    "concrete thing it is about, and tied to the account that said it, with the quote and speaker. " +
    "Filter by lane, subtype, one account (`focus`), or a date. Use for 'what objections are we hearing', " +
    "'which bugs came up this month', 'what did Acme ask for'. The labels follow the workspace (a service " +
    "business sees Delivery / Missed results). To WRITE an insight use record_insight.",
    {
      lane: z.enum(["product", "sales", "success", "market"]).optional().describe("The team that acts."),
      subtype: z.enum(["bug", "friction", "feature", "objection", "pricing", "pitch", "setup", "training", "partners", "buyers"]).optional().describe("The kind of work. Must belong to `lane` when both are given."),
      focus: z.string().optional().describe("One account: entity UUID, email, domain, or LinkedIn URL (not a bare name)."),
      since: z.string().optional().describe("Only insights on or after this ISO date, e.g. 2026-09-01."),
      limit: z.number().optional().describe("Page size (default 50, max 200)."),
      offset: z.number().optional().describe("Rows to skip, for paging."),
    },
    async (args) => {
      const r = await get("/v2/insights", args);
      const tax = r.taxonomy ?? {};
      const laneLabel = new Map((tax.lanes ?? []).map((l) => [l.key, l.label]));
      const subLabel = new Map((tax.subtypes ?? []).map((s) => [s.key, s.label]));
      const items = r.insights ?? [];
      const lines = [`${items.length} insight${items.length === 1 ? "" : "s"}` +
        (r.offset ? ` (from ${r.offset})` : "") + (r.has_more ? " · more available, page with offset" : "")];
      for (const i of items) {
        const where = [laneLabel.get(i.lane) ?? i.lane, subLabel.get(i.subtype) ?? i.subtype].filter(Boolean).join(" → ");
        const acct = i.account ? `${i.account.name ?? "(unnamed)"} [${i.account.entity_id}]` : "no account";
        lines.push(`• ${where}${i.tags?.length ? ` · ${i.tags.join(", ")}` : ""} · ${acct}` +
          (i.occurred_at ? ` · ${new Date(i.occurred_at).toISOString().slice(0, 10)}` : ""));
        lines.push(`    ${i.content}`);
        if (i.quote) lines.push(`    ${i.speaker ? `${i.speaker} · ` : ""}"${i.quote}"`);
        else if (i.speaker) lines.push(`    ${i.speaker}`);
        if (i.source_ref) lines.push(`    ref ${i.source_ref}`);
      }
      const rd = r.readiness;
      if (rd && !rd.ready) {
        lines.push(`Not extracting insights yet: ${rd.detail} Set the ICP with ${rd.fix?.mcp ?? "set_icp"} (or in the app at ${rd.fix?.app ?? "/settings?section=context"}).`);
      } else if (!items.length) lines.push("No placed insights match. New insights reach the board after the nightly sort.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: add_note  —  POST /v2/notes
  // ===========================================================================
  tool(
    "add_note",
    "Keep a NOTE or document on a person or company: a short note, a meeting brief, meeting notes, a " +
    "pre-meeting prep, research, or a transcript. It is stored on the account and found later by the " +
    "account reads. This is for artifacts you keep, not interactions: for 'an email was sent' or 'a " +
    "meeting happened' use record; for a finished brief/plan/report you want in Pages use save_page. " +
    "`focus` must be an entity UUID, email, LinkedIn URL or domain (a domain files on the company); an " +
    "unknown email or domain creates the person/company.",
    {
      focus: z.string().describe("Who it is about: entity UUID, email, LinkedIn URL, or domain. Not a bare name."),
      content: z.string().describe("The note or document text."),
      title: z.string().optional().describe("A short name, e.g. 'Pre-meeting brief: renewal'."),
      type: z.enum(["note", "meeting_brief", "transcript", "meeting_notes", "pre_meeting", "research"]).optional().describe("Default note."),
      date: z.string().optional().describe("The relevant date (e.g. the meeting date), ISO. Defaults to now."),
    },
    async ({ focus, content, title, type, date }) => {
      const r = await post("/v2/notes", { focus, content, title, type, date });
      return { content: [{ type: "text", text:
        `Saved ${String(r.doc_type ?? type ?? "note").replace(/_/g, " ")}${title ? ` "${title}"` : ""} on ${r.entity_id}.` }] };
    }
  );

  // ===========================================================================
  // TOOL: webhooks  —  /v2/webhooks
  // Subscribe the operator's own stack to events, each carrying the record (GET-559).
  // ===========================================================================
  tool(
    "webhooks",
    "Push events to the user's own stack (n8n, Make, Clay, their agent's endpoint). Each record event " +
    "carries the account, its people, the deal and the evidence behind it (source, confidence), so the " +
    "receiver acts without calling back. Actions: `events` lists what can be subscribed to; `list`; " +
    "`create` (url + events; returns the signing secret ONCE — tell the user to store it); `update` " +
    "(name/url/events/active, or rotate_secret); `delete`; `test` sends one webhook.test now against a " +
    "real account; `deliveries` shows recent sends and failures. Deliveries are signed: X-Nous-Signature " +
    "= sha256 HMAC of the raw body with the secret.",
    {
      action: z.enum(["events", "list", "create", "update", "delete", "test", "deliveries"]),
      id: z.string().optional().describe("The webhook id, for update, delete, test and deliveries."),
      url: z.string().optional().describe("Where to POST events (https)."),
      events: z.array(z.string()).optional().describe("Event types, e.g. conversation.call_ended, conversation.reply_received, deal.won, deal.lost, deal.stage_changed."),
      name: z.string().optional(),
      active: z.boolean().optional(),
      rotate_secret: z.boolean().optional(),
      account_id: z.string().optional().describe("For test: the account to build the sample record from."),
    },
    async ({ action, id, url, events, name, active, rotate_secret, account_id }) => {
      const text = (t) => ({ content: [{ type: "text", text: t }] });
      const need = (v, what) => { if (!v) throw new Error(`${what} is required for ${action}`); };
      if (action === "events") {
        const r = await get("/v2/webhooks/events");
        return text(r.events.map(e => `${e.type}${e.record ? "" : " (person snapshot only)"} — ${e.description}`).join("\n"));
      }
      if (action === "list") {
        const r = await get("/v2/webhooks");
        if (!r.webhooks.length) return text("No webhooks yet.");
        return text(r.webhooks.map(w => `${w.id} · ${w.name} · ${w.active ? "active" : "paused"} · ${w.url}\n  ${w.events.join(", ")}`).join("\n"));
      }
      if (action === "create") {
        need(url, "url"); need(events?.length, "events");
        const r = await post("/v2/webhooks", { url, events, name });
        return text(`Created ${r.webhook.id} for ${r.webhook.events.join(", ")} → ${r.webhook.url}.\nSigning secret (shown once, store it now): ${r.secret}`);
      }
      need(id, "id");
      if (action === "update") {
        const body = Object.fromEntries(Object.entries({ name, url, events, active, rotate_secret }).filter(([, v]) => v !== undefined));
        const r = await patch(`/v2/webhooks/${id}`, body);
        return text(`Updated ${r.webhook.id}: ${r.webhook.active ? "active" : "paused"}, ${r.webhook.events.join(", ")} → ${r.webhook.url}.${r.secret ? `\nNew signing secret (shown once): ${r.secret}` : ""}`);
      }
      if (action === "delete") {
        await del(`/v2/webhooks/${id}`);
        return text(`Deleted ${id}.`);
      }
      if (action === "test") {
        const r = await post(`/v2/webhooks/${id}/test`, account_id ? { account_id } : {});
        return text(`Test event ${r.event_id} queued${r.account ? `, built on ${r.account}` : ""}. It is delivered within 30 seconds; check with action=deliveries.`);
      }
      const r = await get(`/v2/webhooks/${id}/deliveries`);
      if (!r.deliveries.length) return text("Nothing sent yet.");
      return text(r.deliveries.map(d => `${d.occurred_at} · ${d.event_type} · ${d.status}${d.last_status_code ? ` (${d.last_status_code})` : ""}${d.last_error && d.status !== "delivered" ? ` — ${String(d.last_error).slice(0, 120)}` : ""}`).join("\n"));
    }
  );

  // ===========================================================================
  // TOOL: whoami  —  GET /v2/workspace/whoami
  // The identity primitive: who this key acts AS, their scope, and their GTM
  // role(s). Every governance/permission decision hangs off knowing the actor.
  // ===========================================================================
  tool(
    "whoami",
    "Report who this API key acts AS: the workspace, the person, their SCOPE (admin sees the whole " +
    "workspace; member sees only their own book plus the shared graph), their GTM ROLE(S) (e.g. AE, " +
    "SDR, founder — a person can hold several), the key's capability (read/write vs read-only), and the " +
    "budget left (plan, ops left, credits left; unlimited when the plan has no cap). " +
    "Call it to confirm the plugin is wired to the right workspace and identity, and to scope " +
    "role-specific work to the right person — a member gets their own view, an admin the whole team's.",
    {},
    async () => {
      const r = await get("/v2/workspace/whoami");
      const w = r.workspace || {};
      const y = r.you || {};
      const who = y.name || (y.user_id ? "(unnamed member)" : "a shared workspace key (no person)");
      const scope = y.scope === "admin"
        ? "ADMIN — you see the whole workspace"
        : "MEMBER — you see only your own book plus the shared graph";
      const roles = Array.isArray(y.roles) && y.roles.length ? y.roles.join(", ") : "none set";
      const cap = y.capability === "read_only" ? "read-only" : "read/write";
      const s = r.setup || {};
      const num = (n) => Number(n).toLocaleString("en-US");
      // The orientation line — what the agent should do NEXT, right now.
      const next = !s.onboarded
        ? "Setup: NOT onboarded yet (fresh workspace). NEXT → run the `onboard` skill now to build the graph."
        : `Setup: onboarded · ${num(s.accounts || 0)} accounts` +
          `${s.people != null ? ` · ${num(s.people)} people` : ""} · ICP ${s.has_icp ? "set" : "not set"}. ` +
          "NEXT → call `attention` for today's worklist.";
      // The budget (null on a field = unlimited; usage null = metering unavailable right now).
      const u = r.usage;
      const usage = !u
        ? "Usage: unavailable right now (not a limit — retry later if it matters)."
        : `Usage: plan ${u.plan ?? "unknown"} · ops ${u.ops_left == null ? "unlimited" : `${num(u.ops_left)} left`}` +
          `${u.ops_used != null ? ` (${num(u.ops_used)} used${u.ops_limit != null ? ` of ${num(u.ops_limit)}` : ""})` : ""}` +
          ` · credits ${u.credits_left == null ? "unlimited" : `${num(u.credits_left)} left`}` +
          `${u.period_end ? ` · period ends ${day(u.period_end)}` : ""}.`;
      return { content: [{ type: "text", text:
        `You are acting as ${who} on ${w.name || "this workspace"}.\n` +
        `Scope: ${scope}.\n` +
        `Role(s): ${roles}.\n` +
        `Capability: ${cap}.\n` +
        `${usage}\n` +
        next }] };
    }
  );

  // Register in PLUGIN_TOOLS order: the documented core first, then the legacy tools.
  // Each handler runs inside a tool-call context, so every /v2 call it makes carries the tool's
  // name (X-Nous-Tool) and the MCP client's name (X-Nous-Agent) for the per-key request log
  // (GET-623). The handler is always the last argument to server.tool().
  const agentName = () => {
    try {
      const v = server.server.getClientVersion?.();
      return v?.name ? `${v.name}${v.version ? `/${v.version}` : ""}` : undefined;
    } catch { return undefined; }
  };
  cloudMcp?.register?.({ tool, z, ...helpers });
  for (const name of PLUGIN_TOOLS) {
    if (!pending.has(name)) continue;
    const args = [...pending.get(name)];
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      args[args.length - 1] = (...callArgs) =>
        runWithToolCall({ tool: name, agent: agentName() }, () => handler(...callArgs));
    }
    _tool(name, ...args);
  }

  return server;
}
