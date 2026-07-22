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
 * Tools:
 *   get_context          — engineered context for a task (draft_email, follow_up, ...) + ICP fit score
 *   get_account          — the full account record: every claim + the timeline + ICP fit score
 *   merge_contacts       — fold two duplicate records for the same person into one (lossless, reversible)
 *   record               — record what happened / what you learned (observe, never update)
 *   query                — retrieve + summarise a corpus of activity across many people
 *   attention            — what needs your attention (accounts gone quiet, facts decayed)
 *   verify               — re-check a fact before acting on it
 *   get_playbook         — read the user's own rules: voice, outreach, icp, positioning
 *   save_note            — attach a note/document (meeting brief, transcript, prep) to a contact
 *   search_notes         — semantic search over saved notes & documents
 *   get_workspace_status — what's set up in this workspace + a ranked next_steps list (call first)
 *   set_workspace_profile— agent-driven onboarding: set the workspace's name, site, type, ICP
 *   build_icp_model  — build/rebuild the ICP scoring model from the recorded GTM context
 *   train_icp_model  — build the ICP model from real closed-won/lost deals (contrastive lift)
 *   sync_icp              — sync the user's EXISTING ICP/positioning files into Nous (file → graph)
 *   export_icp_model        — get the learned ICP model as a block to write back into their ICP file (graph → file)
 *   connect_integration  — connect a key-based integration (Apollo, Prospeo, HubSpot, …)
 *   configure_crm_sync   — set CRM sync rules (auto-sync, create policy, hygiene cadence)
 *   sync_crm_now         — run an immediate incremental/full CRM pull (don't wait for the daily cron)
 *   set_trigger          — create an outbound event trigger (webhook); list_triggers reads them
 *   list_triggers        — list the workspace's event triggers + available events
 *   get_routing_preferences — Claude Code routing prefs to default GTM to Nous (write to CLAUDE.md)
 *   lead_list_operations — the operations trail of a lead list (imports/enrich/push/replies), filterable
 *   get_coverage         — pre-spend coverage: exact per-lead check (identifiers) or attribute estimate (title/keyword)
 *   enrich_leads         — find missing emails for a lead list (two-step: dry-run cost preview, then confirm)
 *   verify_leads         — validate email deliverability for a lead list (two-step preview, then confirm)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { get, post } from "./client.js";

export const SERVER_VERSION = "0.42.0";

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
const fmtVal  = (v) => (v != null && typeof v === "object") ? JSON.stringify(v) : String(v ?? "");
const pct     = (c) => `${Math.round((c ?? 0) * 100)}%`;

// Routing preferences — the text that makes an agent treat Nous as the default
// for GTM (reach for get_context/get_account over raw CRM/HubSpot/Salesforce/
// Gong/Granola). Returned by get_routing_preferences; the agent writes it into
// the user's CLAUDE.md (Claude Code) or the user pastes it into claude.ai org
// preferences. Mirrors the Install page's "short" version.
const ROUTING_PREFERENCES = `# Nous is this workspace's Revenue Context Layer

Nous is our Revenue Context Layer for GTM: the pre-computed context every agent reads
before it acts. Underneath, a context graph resolves every person, conversation, and
touchpoint across our GTM tool stack into one account record, with each fact's
confidence and freshness, the full interaction timeline, a 0-100 ICP fit score on
every account, plus our own ICP, positioning, and pricing. Agents read engineered
context from Nous rather than raw CRM rows.

## Ground GTM work in Nous

Before any go-to-market task (drafting outreach, prepping a call or meeting,
reviewing an account, qualifying a prospect) call get_context with the person's
email and the matching intent. Use what it returns. Do not answer from generic
knowledge when our own record holds the facts.

## Default to Nous, even unprompted

For any GTM question about a person, company, deal, or our own business, reach for
Nous first even when the user never says "Nous":
- Who is this, every known fact, full history  -> get_account
- Context for a specific task                   -> get_context
- Something happened or you learned a fact      -> record
- Activity or a list across many accounts       -> query
- What needs attention, what has gone quiet     -> attention
- Your action items / what you owe an account    -> get_action_items
- A fact looks stale before you act on it       -> verify
- Our own rules: ICP, positioning, voice, outreach -> get_playbook
- Our ICP/positioning lives in our own files    -> sync_icp (file → graph) / export_icp_model (graph → file)
- You edited an ICP / context / playbook file   -> re-sync THIS turn: sync_icp (ICP/context) or sync_playbook (a playbook)
- A brief / note / transcript on a contact      -> save_note / search_notes
- What's set up here and what to do next        -> get_workspace_status

Read get_playbook at the start of GTM work for the user's own rules (voice,
outreach, icp, positioning). After every interaction you help with, call record so
the record stays current.

CRITICAL — edits don't apply until you sync. Editing an ICP / context / playbook
file (context/icp.md, positioning.md, references/voice.md, …) does NOT change the
ICP score, the exclusions, or what any other agent reads until it is synced into
the graph. After ANY such edit you MUST call sync_icp (for ICP/context files) or
sync_playbook (for a playbook) in the SAME turn. Never leave an edited file
unsynced — an unsynced edit is silently inert.`;

// ─── factory ──────────────────────────────────────────────────────────────────

export function createServer() {
  const server = new McpServer({
    name: "nous",
    version: SERVER_VERSION,
    description:
      "Nous — the Context Graph for AI Agents. Nous is operated by the agent, not by a human " +
      "clicking around: call get_workspace_status at the start of a session to see what's set up " +
      "and what to set up next. Call get_context before drafting outreach or preparing for a " +
      "meeting. Call record after every interaction, or whenever you learn something.",
    icons: [
      { src: "https://opennous.cloud/newlogoP.png", mimeType: "image/png", sizes: ["64x64"] },
    ],
  });

  // ===========================================================================
  // TOOL: get_context  —  POST /v2/context
  // The headline tool. Engineered, intent-shaped context for a specific task.
  // ===========================================================================
  server.tool(
    "get_context",
    "Get engineered context for a specific task about a person or company. Pass their email (or " +
    "entity id) and the intent. Returns a focused, ranked context block: the facts that matter for " +
    "that task — each with a confidence and a freshness — the durable FACTS we've learned about them " +
    "(their atomic memory: budget, authority, pain, stack, plans), the recent timeline, the buying-group " +
    "stakeholders, open predictions, and the account's ICP fit score (0-100 + why). Call this before " +
    "drafting outreach, preparing for a meeting, " +
    "or making any decision about a person. A fact's freshness tells you whether to trust it: 'fresh' " +
    "act on it, 'suspect'/'expired' verify first.",
    {
      focus: z.string().describe("Who to look up — an email, a LinkedIn URL, a domain, an entity UUID, or a name. A name may match several people; you'll get candidates to choose from."),
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

      const lines = [ctx.summary, ""];

      if (ctx.icp) {
        const label = ctx.icp.score >= 70 ? "strong fit" : ctx.icp.score >= 40 ? "moderate fit" : "weak fit";
        lines.push(`ICP FIT: ${ctx.icp.score}/100 — ${label}${ctx.icp.reason ? `  (${ctx.icp.reason})` : ""}`);
        lines.push("");
      }
      if (ctx.facts?.length) {
        // Atomic memory — the durable, decision-relevant facts learned about them.
        lines.push(`FACTS (${ctx.facts.length} — durable memory about them):`);
        for (const f of ctx.facts) lines.push(`  [${f.category}] ${f.content}${f.date ? `  (${relAge(f.date)})` : ""}`);
        lines.push("");
      }
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
        // (snippets only). To pull relevant content, use search_notes (semantic).
        lines.push("DOCUMENTS (notes & meeting records — use search_notes to search their content):");
        for (const d of ctx.documents) {
          const when = d.date ? `  [${relAge(d.date)}]` : "";
          lines.push(`  ${d.type.replace(/_/g, " ")}${d.title ? ` · ${d.title}` : ""}${when}`);
          if (d.snippet) lines.push(`    ${d.snippet}`);
        }
        lines.push("");
      }
      if (ctx.stakeholders?.length) {
        lines.push("STAKEHOLDERS:");
        for (const s of ctx.stakeholders) lines.push(`  ${s.name ?? "—"} — ${s.role ?? ""}`);
        lines.push("");
      }
      if (ctx.predictions?.length) {
        lines.push("PREDICTIONS:");
        for (const p of ctx.predictions) {
          lines.push(`  ${p.kind}: ${fmtVal(p.value)} (${pct(p.confidence)})`);
        }
      }
      return {
        content: [{ type: "text", text: `${lines.join("\n").trim()}\n\n(entity_id: ${ctx.entity?.id})` }],
      };
    }
  );

  // ===========================================================================
  // TOOL: get_account  —  GET /v2/accounts/:id
  // The full account-record projection. For a focused view, prefer get_context.
  // ===========================================================================
  server.tool(
    "get_account",
    "Get the full account record for a person or company — the durable FACTS we've learned about them " +
    "(their atomic memory: budget, authority, pain, stack, plans), every attribute (claim) with its " +
    "confidence and freshness, plus what they actually SAID and did, ranked by how much it tells you. " +
    "Pass an email or entity UUID, and the intent you're working toward so the record is shaped for it.",
    {
      id: z.string().describe("Email address or entity UUID"),
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
      const lines = [`${rec.type} · ${rec.entity_id}`, ""];

      if (rec.icp) {
        const label = rec.icp.score >= 70 ? "strong fit" : rec.icp.score >= 40 ? "moderate fit" : "weak fit";
        lines.push(`ICP FIT: ${rec.icp.score}/100 — ${label}${rec.icp.reason ? `  (${rec.icp.reason})` : ""}`);
        lines.push("");
      }
      if (rec.facts?.length) {
        // Atomic memory — the durable, decision-relevant facts learned about them.
        lines.push(`FACTS (${rec.facts.length} — durable memory about them):`);
        for (const f of rec.facts) lines.push(`  [${f.category}] ${f.content}${f.date ? `  (${relAge(f.date)})` : ""}`);
        lines.push("");
      }
      const docs = rec.documents ?? [];
      if (docs.length) {
        // Saved briefs / notes / transcripts kept on the contact — previews only.
        // The agent needs to KNOW these exist so it never reports "no brief on
        // file" when one is saved; the full body is read with search_notes.
        lines.push(`DOCUMENTS (${docs.length} — saved notes & meeting records, read with search_notes):`);
        for (const d of docs) {
          const when = d.date ? `  (${relAge(d.date)})` : "";
          lines.push(`  ${d.type.replace(/_/g, " ")}${d.title ? ` · ${d.title}` : ""}${when}`);
          if (d.snippet) lines.push(`      ${d.snippet}`);
        }
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
  // TOOL: merge_contacts  —  POST /v2/accounts/merge
  // Fold a duplicate person into one account record. Agent-only dedup.
  // ===========================================================================
  server.tool(
    "merge_contacts",
    "Merge two duplicate records for the SAME person into one account. Use when the same human exists " +
    "twice — e.g. one record from a LinkedIn connection (no email) and one from a Cal.com booking (email, " +
    "truncated name) that never got linked. Pass `keep` (the survivor) and `drop` (the duplicate to fold in); " +
    "each may be an email, LinkedIn URL, entity UUID, or name. Lossless — the duplicate's identifiers (a second " +
    "email, a LinkedIn URL) re-attach to the survivor, so a future match on EITHER resolves to the one account — " +
    "and reversible. If a name matches several people you'll get candidates: confirm the survivor with the user, " +
    "then re-call with the chosen entity ids. Prefer passing the keep that already has the most history.",
    {
      keep: z.string().describe("The survivor to keep — email, LinkedIn URL, entity UUID, or name."),
      drop: z.string().describe("The duplicate to fold into keep — email, LinkedIn URL, entity UUID, or name."),
    },
    async ({ keep, drop }) => {
      const r = await post("/v2/accounts/merge", { keep, drop });

      if (r.status === "ambiguous") {
        const opts = (r.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        const term = r.which === "keep" ? keep : drop;
        return { content: [{ type: "text", text:
          `"${term}" (the ${r.which}) matches several people. Re-call merge_contacts with one of these entity ids as ${r.which}:\n${opts}` }] };
      }

      const moved = Object.entries(r.rows_repointed ?? {}).map(([t, n]) => `${n} ${t}`).join(", ");
      const lines = [
        `Merged — folded ${r.drop_id} into ${r.keep_id}.`,
        `  identifiers re-attached: ${r.identifiers_moved}  (a future match on either now resolves to one account)`,
        `  claims moved: ${r.claims_moved}${r.claims_conflicted ? ` (${r.claims_conflicted} kept on survivor)` : ""}`,
        `  observations moved: ${r.observations_moved}`,
        (r.relationships_repointed || r.relationships_removed)
          ? `  relationships: ${r.relationships_repointed} re-pointed, ${r.relationships_removed} pruned` : null,
        moved ? `  re-pointed: ${moved}` : null,
        `The duplicate is now a reversible tombstone (merged into the survivor).`,
      ].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: record  —  POST /v2/observations
  // The single write verb. You observe — Nous derives the updated facts.
  // ===========================================================================
  server.tool(
    "record",
    "Record what happened or what you learned about a person or company. You never overwrite " +
    "anything — you observe, and Nous derives the updated facts. Use kind:'event' for an interaction " +
    "(property like 'interaction.email_sent', 'interaction.call_held', 'interaction.email_reply') and " +
    "kind:'state' for a fact (property like 'job_title', 'deal.proposal_amount'). Examples — sent an " +
    "email: {kind:'event',property:'interaction.email_sent',value:{description:'intro email'}}; " +
    "learned their title changed: {kind:'state',property:'job_title',value:'VP of Engineering'}; " +
    "a fact ended (they left): {kind:'state',property:'job_title',value:null}.",
    {
      focus: z.string().describe("Email address or entity UUID of the person or company"),
      observations: z.array(z.object({
        kind: z.enum(["event", "state"]).describe("event = an interaction; state = a fact"),
        property: z.string().describe("e.g. 'interaction.email_sent' or 'job_title'"),
        value: z.any().optional().describe("the event detail or the fact value; null = the fact ended"),
        source: z.string().optional().describe("where this came from (default: agent)"),
      })).describe("One or more observations to record"),
    },
    async ({ focus, observations }) => {
      const result = await post("/v2/observations", { focus, observations });
      const parts = [`Recorded ${result.recorded} observation${result.recorded !== 1 ? "s" : ""}.`];
      if (result.claims_recomputed?.length) {
        parts.push(`Facts updated: ${result.claims_recomputed.join(", ")}.`);
      }
      parts.push(`(entity_id: ${result.entity_id})`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: record_signal  —  a buying signal, as a structured signal.<class> fact
  // A validated wrapper over record: one canonical way to write a signal, so it
  // both shows on the account's Signals tab AND feeds the ICP scorecard as a
  // feature (signal.* claims flow into the feature map the scorer reads).
  // ===========================================================================
  server.tool(
    "record_signal",
    "Record a buying signal on a person or company — a concrete, current reason to reach out, " +
    "found by research (signal-scan). Stored as a structured signal.<class> fact so it shows on the " +
    "account's Signals tab AND feeds the ICP scoring model as a feature. One call per signal; one " +
    "current signal per class (the strongest). class is one of stack | hiring | momentum | friction | " +
    "intent | domain. score is 0-10 (exclusivity x intent — score honestly, a 4 is useful). Be " +
    "specific: 'posted 3 SDR roles in 30 days', not 'they're growing'.",
    {
      focus: z.string().describe("Email address or entity UUID of the person/company"),
      signal_class: z.enum(["stack", "hiring", "momentum", "friction", "intent", "domain"])
        .describe("the signal class"),
      detected: z.string().describe("the specific, factual finding"),
      implies: z.string().optional().describe("what the prospect is likely experiencing because of it"),
      score: z.number().min(0).max(10).describe("strength 0-10 (exclusivity x intent)"),
      approach: z.enum(["pain_led", "value_led", "fallback"]).optional()
        .describe("recommended outreach approach"),
      angle: z.string().optional().describe("one-line outreach angle this signal enables"),
    },
    async ({ focus, signal_class, detected, implies, score, approach, angle }) => {
      const result = await post("/v2/observations", {
        focus,
        observations: [{
          kind: "state",
          property: `signal.${signal_class}`,
          value: { detected, implies: implies ?? null, score, approach: approach ?? null, angle: angle ?? null },
          source: "signal-scan",
        }],
      });
      return {
        content: [{
          type: "text",
          text: `Recorded ${signal_class} signal (score ${score}/10) on ${result.entity_id || focus}.`,
        }],
      };
    }
  );

  // ===========================================================================
  // TOOL: query  —  POST /v2/query
  // Retrieve a corpus of activity across many people. You do the analysis.
  // ===========================================================================
  server.tool(
    "query",
    "Retrieve and summarise activity across many people. Three powers:\n" +
    "  1. return:'entities' groups results by person/company (one row per entity, ranked by " +
    "most-recent matching activity). Use for 'hottest leads', 'who replied this week', " +
    "'who's in evaluating stage'.\n" +
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
    "account's facts already come back inline with get_account.)",
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
      return "not in the graph yet — enrich this account first (signals/firmographics), then score.";
    }
    if (!r.scored) return `known, but awaiting enrichment — no scoreable claims yet (${r.entity_id}).`;
    const tier = (r.icp.tier || "").replace(/_/g, " ") || "untiered";
    return `ICP ${r.icp.score}/100 (${tier})${r.icp.fit ? " ✓fit" : ""} · intent ${r.intent.score}/100 ${r.intent.band}` +
           (r.icp.reason ? `\n    ${r.icp.reason}` : "");
  };
  server.tool(
    "score",
    "Score a lead against our live ICP model and intent axis, and write the judgment into the graph so " +
    "every other agent reads the same number. This is for scoring a list the user built ELSEWHERE (a " +
    "Google Sheet, a Clay column, a CRM export): the list stays where it is, Nous returns the score. " +
    "Give an email, domain, LinkedIn URL, or entity UUID (or up to 100 at once via `identifiers`). " +
    "Returns ICP fit 0-100 + tier (tier_1/2/3/not_icp, which drives the play) and decaying intent " +
    "0-100 + band. It reads the live score (staking one on demand for a known-but-unscored account); " +
    "the score keeps evolving on its own afterwards. If a row isn't in the graph yet it comes back " +
    "`unknown_identifier` — enrich that account first (signal-scan / a lead-builder), then score.",
    {
      identifier: z.string().optional().describe("One lead — an email, domain, LinkedIn URL, or entity UUID."),
      identifiers: z.array(z.string()).optional().describe("A batch of leads (max 100 per call; loop for a larger list)."),
      intent: z.string().optional().describe("Optional hint about why you're scoring (recorded, does not change the score)."),
    },
    async ({ identifier, identifiers, intent }) => {
      if (Array.isArray(identifiers) && identifiers.length) {
        const r = await post("/v2/score", { identifiers, intent });
        const lines = (r.results || []).map(x => `  ${x.identifier} — ${scoreOne(x)}`);
        const scored = (r.results || []).filter(x => x.scored).length;
        return { content: [{ type: "text", text: `Scored ${scored}/${(r.results || []).length}:\n${lines.join("\n")}` }] };
      }
      const r = await post("/v2/score", { identifier, intent });
      return { content: [{ type: "text", text: `${identifier} — ${scoreOne(r)}` }] };
    }
  );

  // ===========================================================================
  // TOOL: attach_list  —  POST /v2/lead-lists/attach
  // Batch-score a list the user built ELSEWHERE (a Google Sheet, a CRM export, a
  // Clay table). One call: create/reuse a Nous list, ingest the rows (entities
  // resolved+deduped), score every row into the graph. The list stays where it
  // is; Nous keeps the roster so the scores stay fresh and agents can read them.
  // ===========================================================================
  server.tool(
    "attach_list",
    "Score a whole list the user built somewhere ELSE — a Google Sheet, a CRM export, a Clay table — " +
    "in one call. Give the rows and Nous creates a lead list, resolves each row to a person/company " +
    "(deduped against everything already in the graph), and scores every one against the live ICP model " +
    "+ intent axis so the judgment lands in the graph for other agents. The spreadsheet stays the user's; " +
    "Nous just owns the score and keeps it fresh. Each row needs an email OR a LinkedIn URL. Rows we don't " +
    "know enough about yet come back `awaiting_enrichment` — run signal-scan / a lead-builder on them, then " +
    "re-attach. Pass `lead_list_id` instead of `name` to add to an existing list. Max 200 rows per call — " +
    "loop for a bigger sheet.",
    {
      name: z.string().optional().describe("Name for the new list (e.g. 'Q3 sheet — inbound'). Omit only when passing lead_list_id."),
      lead_list_id: z.string().optional().describe("Add to an existing list instead of creating one."),
      source: z.string().optional().describe("Where the list came from, e.g. 'google_sheet', 'crm_export' (default 'external')."),
      rows: z.array(z.object({
        email: z.string().optional(),
        linkedin_url: z.string().optional(),
        domain: z.string().optional(),
        company: z.string().optional(),
        name: z.string().optional(),
      }).passthrough()).describe("The list rows. Each needs an email or a linkedin_url."),
      import_duplicates: z.boolean().optional().describe("Force-insert rows already in this list (default false — deduped)."),
    },
    async ({ name, lead_list_id, source, rows, import_duplicates }) => {
      const r = await post("/v2/lead-lists/attach", { name, lead_list_id, source, rows, import_duplicates });
      const head = `Attached ${rows.length} rows to list ${r.lead_list_id} — ` +
        `${r.inserted} new, ${r.duplicate_skipped} already in list. ` +
        `Scored ${r.scored}; ${r.awaiting_enrichment} awaiting enrichment; ${r.unresolved} unresolved.`;
      const top = (r.results || [])
        .filter(x => x.scored)
        .sort((a, b) => (b.icp?.score ?? 0) - (a.icp?.score ?? 0))
        .slice(0, 10)
        .map(x => `  ${x.identifier} — ICP ${x.icp.score} (${(x.icp.tier || "").replace(/_/g, " ")}) · intent ${x.intent.score} ${x.intent.band}`);
      const tail = r.awaiting_enrichment ? `\n\n${r.awaiting_enrichment} rows need enrichment before they can score — run signal-scan or a lead-builder on the list, then re-attach.` : "";
      return { content: [{ type: "text", text: `${head}${top.length ? `\n\nTop scored:\n${top.join("\n")}` : ""}${tail}` }] };
    }
  );

  // ===========================================================================
  // TOOL: attention  —  GET /v2/attention
  // What to look at: accounts gone quiet, key facts decayed.
  // ===========================================================================
  server.tool(
    "attention",
    "What needs your attention across the workspace right now — upcoming meetings and calls in the " +
    "next 7 days (each with its date and time, soonest first), accounts that have gone quiet, and key " +
    "facts that have decayed. Returns ranked items (time-critical meetings lead), each with what's " +
    "happening and a suggested action. Call this to decide what to work next, or to answer 'what's " +
    "coming up' / 'what's on my calendar this week'. For a precise single-day list, use query with " +
    "property:'interaction.meeting_scheduled' and from/to.",
    {
      limit: z.number().min(1).max(100).optional().describe("Max items (default 25)"),
    },
    async ({ limit }) => {
      const r = await get("/v2/attention", limit ? { limit } : {});
      if (!r.items?.length) {
        return { content: [{ type: "text", text: "Nothing needs attention right now." }] };
      }
      // Upcoming meetings carry a `when` — render the absolute local date+time.
      //
      // Each item also names where it came from: the calendar holding the call, the
      // transcript the promise was captured from. An agent that can cite the call
      // someone made a promise ON is making an argument; one that just asserts the
      // promise is asking to be trusted.
      const lines = r.items.map(it => {
        const when = it.when ? `${fmtWhen(it.when)} — ` : "";
        const from = it.source ? `  [${it.source}]` : "";
        return `  ${when}${it.entity_name ?? it.entity_id} — ${it.what}${from}\n      → ${it.suggested_action}`;
      });
      return { content: [{ type: "text", text: `Needs attention (${r.items.length}):\n${lines.join("\n")}` }] };
    }
  );

  // ===========================================================================
  // TOOL: get_action_items  —  GET /v2/action-items
  // Commitments extracted from meetings/emails — what you owe each account.
  // ===========================================================================
  server.tool(
    "get_action_items",
    "Your open action items and commitments, pulled from meeting notes and emails — what you owe " +
    "which account (and what they owe you), so you don't have to dig through transcripts. Use for " +
    "'what are my action items', 'what do I owe <account>', 'what's outstanding this week'. Defaults " +
    "to YOUR open items across all accounts, grouped by account.",
    {
      owner:  z.enum(["me", "prospect", "all"]).optional().describe("Whose commitments — me (default), the prospect, or all"),
      status: z.enum(["open", "done", "all"]).optional().describe("open (default), done, or all"),
      focus:  z.string().optional().describe("Scope to one account — an email or entity UUID"),
      due:    z.enum(["today", "week", "all"]).optional().describe("Only items due today / this week (items that carry a due date) — default all"),
    },
    async ({ owner, status, focus, due }) => {
      const params = {};
      if (owner)  params.owner  = owner;
      if (status) params.status = status;
      if (focus)  params.focus  = focus;
      if (due)    params.due    = due;
      const r = await get("/v2/action-items", params);
      const items = r.items ?? [];
      if (!items.length) return { content: [{ type: "text", text: "No matching action items." }] };

      const byAccount = new Map();
      for (const it of items) {
        const key = it.account || it.account_email || it.entity_id || "—";
        if (!byAccount.has(key)) byAccount.set(key, []);
        byAccount.get(key).push(it);
      }
      const lines = [`${items.length} action item${items.length !== 1 ? "s" : ""}:`];
      for (const [account, list] of byAccount) {
        lines.push(`\n${account}:`);
        for (const it of list) {
          const who  = it.owner_kind === "prospect" ? "[them]" : "[you]";
          const when = it.due_at ? `  (due ${fmtWhen(it.due_at)})` : "";
          lines.push(`  ${who} ${it.title}${when}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ===========================================================================
  // TOOL: verify  —  POST /v2/verify
  // Re-check a fact before acting on it — the calibration check.
  // ===========================================================================
  server.tool(
    "verify",
    "Re-check a specific fact before you act on it — e.g. an email or a deal stage that looks stale " +
    "in get_context. Pass the person/company and the property name. Returns the fact re-derived from " +
    "current evidence, and tells you whether it is still unverified.",
    {
      focus: z.string().describe("Email, LinkedIn URL, entity UUID, or name"),
      property: z.string().describe("The fact to re-check — e.g. 'email', 'job_title', 'pipeline_stage'"),
    },
    async ({ focus, property }) => {
      const r = await post("/v2/verify", { focus, property });
      if (r.status === "ambiguous") {
        const opts = (r.candidates ?? []).map(c =>
          `  • ${c.name ?? "(unnamed)"}${c.detail ? ` — ${c.detail}` : ""}  [${c.entity_id}]`).join("\n");
        return { content: [{ type: "text", text:
          `"${focus}" matches several people. Call verify again with one of these entity ids:\n${opts}` }] };
      }
      const a = r.after ?? {};
      return { content: [{ type: "text", text:
        `${property}: ${fmtVal(a.value)}  [${pct(a.confidence)} · ${a.freshness}]\n${r.note ?? ""}` }] };
    }
  );

  // get_gtm_profile removed: the user's GTM lives in their files, mirrored into
  // the graph as playbooks (get_playbook) plus the learned ICP model. Read
  // get_playbook for the user's own rules, ICP, and positioning.

  // ===========================================================================
  // TOOLS: get_playbook / sync_playbook  —  the POLICY layer (vs. facts).
  // Playbooks are versioned rule-docs that GOVERN agent behavior: voice, outreach,
  // icp, positioning. Read the relevant one BEFORE acting; push file edits back so
  // every agent obeys the same rules. GET/POST /v2/playbooks.
  // ===========================================================================
  const getPlaybookSchema = {
    kind: z.enum(["voice", "outreach", "icp", "positioning"]).optional()
      .describe("Which policy to read. Omit to list all four."),
  };
  const getPlaybookHandler = async ({ kind }) => {
    const r = await get("/v2/playbooks", kind ? { kind } : undefined);
    const pbs = r.playbooks || [];
    if (!pbs.length) return { content: [{ type: "text", text:
      "No playbooks set up yet. The user can set them up on the Playbooks page or in their context files." }] };
    if (kind) {
      const pb = pbs[0];
      const src = pb.source === "claude_code" ? `mirrors ${pb.file_path}` : "stored in Nous";
      return { content: [{ type: "text", text:
        `# ${pb.title} — ${pb.kind} playbook (v${pb.version}, ${src})\n\n${pb.body_md}` }] };
    }
    const lines = pbs.map(p => `  ${p.kind.padEnd(12)} ${p.title}  (${p.source === "claude_code" ? p.file_path : "stored in Nous"})`);
    return { content: [{ type: "text", text:
      "The user's playbooks (read one with get_playbook(kind)):\n" + lines.join("\n") }] };
  };
  server.tool("get_playbook",
    "Read a PLAYBOOK — the user's policy/rules for a kind of action: voice, outreach, icp, or positioning. " +
    "These are RULES TO OBEY, not facts. Read the relevant playbook BEFORE you act: before writing outreach " +
    "read 'voice' and 'outreach'; before scoring or qualifying read 'icp'; for messaging read 'positioning'. " +
    "Omit kind to list all four.",
    getPlaybookSchema, getPlaybookHandler);

  const syncPlaybookSchema = {
    kind: z.enum(["voice", "outreach", "icp", "positioning"]).describe("Which playbook to update."),
    body_md: z.string().describe("The full markdown content of the playbook. Follow the Nous document house style so every playbook reads like a clean text file: a '# Title' line, a '> ' one-paragraph lede, an optional plain 'Key: value' block, a '---' divider, then '## Title-case' sections with plain '- ' bullets. Keep it markdown, no decorative formatting."),
    file_path: z.string().optional().describe("The repo file this mirrors, e.g. 'context/icp/icp.md'. Pass it when syncing a Claude Code file so the source is recorded as the file."),
  };
  const syncPlaybookHandler = async ({ kind, body_md, file_path }) => {
    const r = await post(`/v2/playbooks/${kind}`, { body_md, file_path });
    return { content: [{ type: "text", text:
      `Synced the ${r.playbook?.kind || kind} playbook into Nous (v${r.playbook?.version}). Other agents now read the same rules.` }] };
  };
  server.tool("sync_playbook",
    "Push a playbook's content into Nous so the graph stays current. You MUST call this in the SAME turn " +
    "whenever you edit a policy file in the repo (e.g. references/voice.md, outreach rules), passing the " +
    "file's new content and its path, so Nous mirrors it and every other agent obeys the same rules. An " +
    "edited playbook file that isn't synced is silently inert — other agents keep reading the old rules. " +
    "MIRROR, DO NOT REWRITE: when the user already has a playbook file, sync it AS-IS. Their file is the " +
    "author and Nous is the mirror — always pass file_path so the next sync knows where an in-app edit " +
    "lands. 'Improving' their wording on the way through means the copy in Nous silently disagrees with " +
    "the copy in their repo, and they will trust neither. If a file looks wrong, SAY SO; don't fix it in " +
    "transit. " +
    "(For the ICP/context files specifically, sync_icp is the sync — use that one.)",
    syncPlaybookSchema, syncPlaybookHandler);

  // The GTM context is no longer written through a dedicated MCP tool. In the file
  // symbiosis model the user's own files (context/icp.md, positioning.md, …) are
  // the source of truth: the agent edits those with its own file tools and calls
  // `sync_icp` to sync them into the graph (and `export_icp_model` to write the learned
  // model back). The shared POST /v2/workspace/facts route still backs that import.

  // ===========================================================================
  // TOOL: save_note  —  POST /v2/notes
  // Attach a long-form artifact to a CONTACT: a meeting brief you wrote, a
  // transcript, pre-meeting prep, or a plain note. Append-only and dated, so the
  // contact builds a record across meetings. Distinct from `record` (which logs
  // that an interaction happened) — this keeps the document itself.
  // ===========================================================================
  server.tool(
    "save_note",
    "Save a note or document onto a person or company so it is kept on their record — a meeting " +
    "brief you wrote, a transcript, pre-meeting prep, research, or a plain note. Use this whenever " +
    "you produce something durable about a specific contact that's worth keeping for next time (e.g. " +
    "after writing a meeting brief, save it to the contact so future meetings can reference it). " +
    "Notes are append-only and dated, so a contact builds a record across meetings — later you can " +
    "read the last few and see what changed. This is NOT for logging that an interaction happened " +
    "(use `record` with an interaction.* event for that), and NOT for the user's own GTM profile " +
    "(that lives in their context files — sync it with `sync_icp`). Put the full text in `content` — it's kept for agents to read; the " +
    "UI shows the title and date, not the whole body.",
    {
      focus: z.string().describe("Who to attach it to — an email, LinkedIn URL, domain, or entity UUID (not a bare name)."),
      content: z.string().describe("The full note or document text (a short note or a complete brief/transcript)."),
      type: z.enum(["note", "meeting_brief", "transcript", "meeting_notes", "pre_meeting", "research"])
        .optional().describe("What kind of document this is (default: note)."),
      title: z.string().optional().describe("A short name, e.g. 'Pre-meeting brief — renewal' or 'Transcript — Jun 1'."),
      date: z.string().optional().describe("The relevant date (e.g. the meeting date, ISO or plain). Defaults to now."),
    },
    async ({ focus, content, type, title, date }) => {
      const r = await post("/v2/notes", { focus, content, type, title, date });
      const label = title || (r.doc_type || "note").replace(/_/g, " ");
      return { content: [{ type: "text", text: `Saved ${label} to ${focus}.` }] };
    },
  );

  // ===========================================================================
  // TOOL: search_notes  —  POST /v2/notes/search
  // Semantic search over saved notes & documents (briefs, transcripts, notes).
  // The retrieval counterpart to save_note — pull relevant document content
  // instead of dumping whole documents into context.
  // ===========================================================================
  server.tool(
    "search_notes",
    "Semantically search the saved notes & documents (meeting briefs, transcripts, meeting notes) " +
    "kept on contacts. Use this to pull relevant content from the record — e.g. 'what did we discuss " +
    "about pricing', 'objections raised in past meetings', or to compare across a contact's meetings. " +
    "Pass `focus` to restrict to one person/company, or omit it to search across everyone. Returns the " +
    "matching documents (type, title, date, similarity, snippet); get the full body with get_account.",
    {
      question: z.string().describe("Natural-language query to match against document content."),
      focus: z.string().optional().describe("Optional — restrict to one person/company (email, LinkedIn URL, domain, or entity UUID)."),
      limit: z.number().optional().describe("Max documents to return (default 8)."),
    },
    async ({ question, focus, limit }) => {
      const r = await post("/v2/notes/search", { question, focus, limit });
      if (!r.documents?.length) {
        return { content: [{ type: "text", text: `No saved documents matched "${question}".` }] };
      }
      const lines = [`Documents matching "${question}":`, ""];
      for (const d of r.documents) {
        const when = d.date ? `  [${relAge(d.date)}]` : "";
        // similarity is null for recency-matched hits (a note too fresh to be
        // embedded yet) — label those "recent" instead of a bogus 0%.
        const match = d.similarity == null ? "recent" : pct(d.similarity);
        lines.push(`  ${d.type.replace(/_/g, " ")}${d.title ? ` · ${d.title}` : ""}  (${match})${when}`);
        if (d.snippet) lines.push(`    ${d.snippet}`);
        lines.push(`    (entity_id: ${d.entity_id})`);
      }
      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    },
  );

  // ===========================================================================
  // TOOL: get_workspace_status  —  GET /v2/workspace/status
  // The "one main call." Nous is operated by the agent, so the agent needs to
  // know the state of the workspace: is it onboarded, is the GTM playbook built,
  // which integrations are connected, is CRM sync configured, are events live —
  // and what to set up next. Call this at the start of a session.
  // ===========================================================================
  server.tool(
    "get_workspace_status",
    "See the whole setup state of this workspace in one call, plus a ranked NEXT STEPS list (each step " +
    "carries its own why/how). Nous is operated by you, the agent — call this at the START of a session " +
    "and walk the user top-down through the steps it returns; the server sequences them by current " +
    "state, so trust that order. Two constraints when acting on them: (1) Gmail (Google OAuth) and " +
    "LinkedIn (no public API — Nous uses Unipile) CANNOT be connected by you — point the user to the " +
    "Integrations page; key-based tools (Prospeo, Apollo, Instantly, HubSpot token) you CAN connect via " +
    "connect_integration, and CSV import is a user action in the app. (2) Respect the plan — never push " +
    "a feature it doesn't include (e.g. CRM sync on free). Recommend the next 1-2 steps, don't dump the " +
    "whole list.",
    {},
    async () => {
      const s = await get("/v2/workspace/status");
      const setup = s.setup ?? {};
      const lines = [];

      const ws = s.workspace ?? {};
      lines.push(`WORKSPACE: ${ws.name || "(unnamed)"}${ws.website ? ` · ${ws.website}` : ""}${ws.business_type ? ` · ${ws.business_type}` : ""}`);
      const pl = s.plan ?? {};
      lines.push(`PLAN: ${pl.name || pl.id || "free"}${pl.crm_sync === false ? "  (CRM sync not included — do not offer it)" : ""}`);
      if (s.self_hosted) {
        const e = s.env_integrations ?? {};
        const mk = (b) => (b ? "✓ set" : "✗ NOT set");
        lines.push("SELF-HOSTED — these channels are wired via nous.env (you can't set env vars; tell the operator to set + restart):");
        lines.push(`  LinkedIn/Unipile: ${mk(e.linkedin_unipile)}   Email/Resend: ${mk(e.email_resend)}   Gmail OAuth: ${mk(e.gmail_oauth)}`);
      }
      lines.push("");

      const mark = (b) => (b ? "✓" : "✗");
      lines.push("SETUP:");
      // The ICP first, because it IS the gate — a workspace without one is not set up, no
      // matter how many integrations are green. If it's mirrored from a file in their repo,
      // say so and say where: that file is the author, and editing anything else is a way of
      // losing their work on the next sync.
      const icp = setup.icp ?? {};
      lines.push(
        `  ${mark(icp.done)} ICP${icp.done
          ? (icp.source === "claude_code" && icp.file_path
              ? ` — mirrored from ${icp.file_path} (their repo is the author; edit the FILE, then sync)`
              : " — authored in Nous")
          : " — MISSING. The workspace is not set up until this exists. Scan their repo before you ask them anything."}`
      );
      lines.push(`  ${mark(setup.onboarding?.done)} Profile${setup.onboarding?.done ? "" : ` — missing ${(setup.onboarding?.missing ?? []).join(", ") || "details"}`}`);
      lines.push(`  ${mark(setup.gtm_playbook?.done)} GTM playbook${setup.gtm_playbook?.model ? " (scoring model live)" : ""}${setup.gtm_playbook?.stale_facts ? ` · ${setup.gtm_playbook.stale_facts} stale fact(s)` : ""}`);
      if (setup.icp_sync) {
        const sy = setup.icp_sync;
        lines.push(`  ⟳ ICP synced from ${sy.synced_from} (${relAge(sy.synced_at)})${sy.model_changed ? " · model has CHANGED since — run export_icp_model to refresh the file" : ""}`);
      }
      const ints = setup.integrations?.connected ?? [];
      lines.push(`  ${mark((setup.integrations?.count ?? 0) > 0)} Integrations (${setup.integrations?.count ?? 0})${ints.length ? `: ${ints.map((i) => i.name).join(", ")}` : ""}`);
      const crm = setup.crm_sync ?? {};
      if (crm.available === false) {
        lines.push(`  – CRM sync (not on the ${pl.name || pl.id || "current"} plan)`);
      } else {
        lines.push(`  ${mark(crm.configured)} CRM sync${crm.configured ? `: ${(crm.providers ?? []).map((p) => p.provider).join(", ")}` : ""}${crm.pending_hygiene_proposals ? ` · ${crm.pending_hygiene_proposals} hygiene proposal(s) to review` : ""}`);
      }
      lines.push(`  ${mark(setup.enrichment?.connected)} Enrichment${setup.enrichment?.provider ? `: ${setup.enrichment.provider}` : ""}`);
      lines.push(`  ${mark((setup.webhooks?.count ?? 0) > 0 || (setup.triggers?.count ?? 0) > 0)} Events — ${setup.webhooks?.count ?? 0} webhook(s), ${setup.triggers?.count ?? 0} trigger(s)`);
      const rec = setup.recommended ?? {};
      lines.push("");
      lines.push("RECOMMENDED CHANNELS (connect these first):");
      lines.push(`  ${mark(rec.email)} Email / Gmail   ${mark(rec.linkedin)} LinkedIn   ${mark(rec.meeting_notetaker)} Meeting note-taker`);
      lines.push(`  Records imported: ${setup.records?.count ?? 0}`);

      if (s.next_steps?.length) {
        lines.push("");
        lines.push("NEXT STEPS:");
        for (const step of s.next_steps) {
          lines.push(`  • ${step.title}`);
          if (step.why) lines.push(`      why: ${step.why}`);
          if (step.how) lines.push(`      how: ${step.how}`);
        }
      } else {
        lines.push("");
        lines.push("Everything's set up. Nothing pending.");
      }

      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );

  // ===========================================================================
  // TOOL: set_workspace_profile  —  POST /v2/workspace/onboarding
  // Agent-driven onboarding. Instead of a human clicking through a wizard in the
  // app, you collect the basics from the user in conversation and write them
  // here. This is the first thing get_workspace_status asks for when a workspace
  // is new.
  // ===========================================================================
  server.tool(
    "set_workspace_profile",
    "Onboard the workspace, or update its basic profile. Nous is set up by you, the agent, in " +
    "conversation — not by the user clicking through a wizard. Ask the user for their company name, " +
    "their website, whether they sell a SERVICE or SOFTWARE, and a sentence describing their ideal " +
    "customer, then write them here. This seeds the GTM context and the ICP scoring model. Call " +
    "get_workspace_status first to see what's already set; send only the fields you're setting or " +
    "changing. " +
    "IMPORTANT for the ICP: before asking the user to describe their ICP from scratch, if you're in " +
    "Claude Code, look for an ICP they ALREADY wrote — folders like context/, .claude/, gtm/ and files " +
    "named icp*, positioning*, pricing*, competitors*. If you find them, read them and call sync_icp to " +
    "sync them (don't retype the ICP here); if none exists, scaffold a context/ folder (icp.md, " +
    "positioning.md, pricing.md, market.md, competitors.md, gtm-motion.md) from the conversation + your " +
    "site research, then sync_icp it — so their ICP lives in their repo. (Not in Claude Code? Capture a " +
    "first cut in the `icp` field here instead.) " +
    "After this, the next step is the context files: call sync_icp to sync them into the graph.",
    {
      name: z.string().optional().describe("The user's company / workspace name."),
      website: z.string().optional().describe("The company website (used to seed the GTM context)."),
      business_type: z.enum(["service", "software"]).optional()
        .describe("Whether they sell a service or software — sets the CRM's buyer terminology and default signup stage."),
      plan_model: z.enum(["free_plan", "free_trial", "both", "paid_only"]).optional()
        .describe("For software only: how they package (free plan, free trial, both, or paid only)."),
      default_signup_stage: z.string().optional()
        .describe("The pipeline stage a brand-new signup lands in (e.g. 'Lead', 'Free User'). Defaults sensibly from business_type."),
      icp: z.string().optional()
        .describe("A sentence or two describing their ideal customer — seeds the ICP scoring model."),
    },
    async ({ name, website, business_type, plan_model, default_signup_stage, icp }) => {
      const r = await post("/v2/workspace/onboarding", { name, website, business_type, plan_model, default_signup_stage, icp });
      const w = r.workspace ?? {};
      const set = [
        w.name && `name=${w.name}`,
        w.website && `site=${w.website}`,
        w.business_type && `type=${w.business_type}`,
        icp && "ICP recorded",
      ].filter(Boolean);
      return { content: [{ type: "text", text:
        `Workspace profile saved.${set.length ? ` ${set.join(" · ")}.` : ""}\n` +
        `Next: call get_workspace_status to see what to set up next (usually syncing the ICP/context files with sync_icp).` }] };
    }
  );

  // ===========================================================================
  // TOOL: build_icp_model  —  POST /v2/workspace/scoring-model
  // The second half of building the GTM playbook. The agent syncs the GTM context
  // from the user's files with sync_icp, then calls this to turn it into a weighted
  // ICP scoring model. After this, accounts get scored for fit and
  // get_workspace_status shows the playbook as done.
  // ===========================================================================
  server.tool(
    "build_icp_model",
    "Build (or rebuild) the user's ICP scoring model from their synced GTM context. This is " +
    "the second half of setting up the GTM playbook: first sync the user's ICP/positioning/pricing " +
    "files with sync_icp, then call this to translate that context into a weighted set of scoring " +
    "signals so accounts get scored for fit. (sync_icp usually builds the model on first sync, so you " +
    "often won't need this directly.) If a model already exists it is left alone unless you " +
    "pass force:true (use that when the context files have changed and the model should be rebuilt). If " +
    "it reports no GTM context yet, sync the user's context files with sync_icp first, then call this again. " +
    "STRONGER than this tool: if the user can name a few closed-WON and closed-LOST customer domains, " +
    "call train_icp_model instead (or as well) — it trains the model on real outcomes via " +
    "contrastive lift, which beats a model inferred from a description.",
    {
      force: z.boolean().optional()
        .describe("Rebuild the model even if one already exists — use when the GTM context has changed."),
    },
    async ({ force }) => {
      try {
        const r = await post("/v2/workspace/scoring-model", { force: force === true });
        const signals = r.signals ?? [];
        const lines = [`Built the ICP scoring model — ${signals.length} signal${signals.length === 1 ? "" : "s"}:`];
        for (const s of signals) lines.push(`  • ${s.label ?? s.key} (weight ${s.weight})`);
        lines.push("", "Accounts will now be scored for fit. Check it on the GTM Context page.");
        return { content: [{ type: "text", text: lines.join("\n").trim() }] };
      } catch (e) {
        // Surface the actionable cases (no context yet / model already exists) as
        // guidance rather than a raw error, so the agent knows what to do next.
        const msg = String(e?.message ?? e);
        if (msg.includes("no_gtm_context")) {
          return { content: [{ type: "text", text:
            "No GTM context yet. Sync the user's ICP/context files with sync_icp first (or scaffold context/icp.md, then sync_icp), then build the model." }] };
        }
        if (msg.includes("model_exists")) {
          return { content: [{ type: "text", text:
            "A scoring model already exists. Call build_icp_model again with force:true to rebuild it from the current GTM context." }] };
        }
        throw e;
      }
    }
  );

  // ===========================================================================
  // TOOL: train_icp_model  —  POST /v2/workspace/closed-deals
  // Build the ICP model from REAL outcomes via contrastive lift (won vs lost).
  // ===========================================================================
  server.tool(
    "train_icp_model",
    "Build (or sharpen) the ICP scoring model from the user's REAL closed deals. Pass closed-WON " +
    "customer domains and closed-LOST domains; Nous enriches each, links the contacts you already " +
    "have there, and runs contrastive lift (what's true of winners but not losers) to discover the " +
    "signals that actually predict revenue — then re-scores open accounts. This is the strongest way " +
    "to build the playbook: a model trained on who actually bought beats one inferred from a " +
    "description. Ask the user for a handful of each (even 3-5 won + 3-5 lost helps). Domains only " +
    "(e.g. 'acme.com'), no scheme.",
    {
      won: z.array(z.string()).optional().describe("Closed-won customer domains, e.g. ['acme.com','globex.com']."),
      lost: z.array(z.string()).optional().describe("Closed-lost domains, e.g. ['tinyco.io']."),
    },
    async ({ won, lost }) => {
      try {
        const r = await post("/v2/workspace/closed-deals", { won: won ?? [], lost: lost ?? [] });
        const disc = r.discovered ?? [];
        const lines = [
          `Learned from ${r.won ?? 0} won + ${r.lost ?? 0} lost deal${(r.won ?? 0) + (r.lost ?? 0) === 1 ? "" : "s"} ` +
          `(${r.enriched ?? 0} enriched, ${r.mode === "winners" ? "winner-signal" : "contrastive-lift"} mode).`,
        ];
        if (disc.length) {
          lines.push("", "Signals discovered:");
          for (const d of disc) lines.push(`  • ${d.label} (weight ${d.weight})${d.note ? ` — ${d.note}` : ""}`);
        }
        lines.push("", "The model updated and open accounts were re-scored. See the GTM Context page.");
        return { content: [{ type: "text", text: lines.join("\n").trim() }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes("need_more_deals")) {
          return { content: [{ type: "text", text: "Give me at least one closed-won or closed-lost domain to learn from." }] };
        }
        throw e;
      }
    }
  );

  // ===========================================================================
  // TOOL: sync_icp  —  POST /v2/workspace/icp/import
  // The file→Nous half of the ICP symbiosis. In Claude Code the user often
  // already keeps their ICP/positioning as markdown (context/icp.md, etc.). Don't
  // make them re-author it in Nous — READ those files and sync them here. Nous
  // mirrors each section and remembers the file path so export_icp_model can write
  // the learned model back into the same file. Their file stays the source of
  // truth for the prose; Nous owns the learned scoring half.
  // ===========================================================================
  server.tool(
    "sync_icp",
    "Sync the user's EXISTING ICP/positioning files into Nous, instead of making them re-author their " +
    "ICP in a second place. CLAUDE CODE flow: when onboarding (or whenever their ICP files change), look " +
    "in the project for an existing GTM setup — folders like context/, .claude/, gtm/, and files named " +
    "icp*, positioning*, pricing*, competitors*, messaging*, market*. READ the ones you find with your " +
    "own file tools, then call this with each file's content mapped to a section, AND its path in " +
    "`source_path`. MAP GRANULARLY: map each FILE to the single section it best fits (icp.md -> ICP, " +
    "positioning.md -> Positioning, pricing.md -> Pricing, competitors.md -> Competitors, market.md -> " +
    "Market, messaging.md -> Notes) — one entry per file, do NOT dump several files' content into ICP. " +
    "If one file holds several sections under headers, split it by header into multiple entries. " +
    "Nous keeps a served copy of the prose and rebuilds the ICP scoring model from it; " +
    "the recorded source_path is what export_icp_model writes the learned model back into. " +
    "INCLUDE EXCLUSIONS: if the ICP names who they will NOT work with (e.g. 'not cold-calling " +
    "agencies', 'no pure branding/messaging shops'), keep that text IN the ICP section — Nous turns " +
    "each stated exclusion into a hard disqualifier that caps those accounts below Not-ICP, even when " +
    "they also match the firmographics. So a 'Not a fit' list in icp.md actively lowers their score. " +
    "IF NO ICP FILES EXIST: don't invent context in Nous. Offer to SCAFFOLD a context/ folder in their " +
    "repo — context/icp.md, positioning.md, pricing.md, market.md, competitors.md, gtm-motion.md — " +
    "filled from what the user tells you plus your own research of their website (write them with your " +
    "file tools), then call this on those files — so their GTM context lives in their repo where they'll " +
    "keep editing it. At minimum create context/icp.md if that's all they'll give you. " +
    "MANDATORY RE-SYNC: whenever you (or the user) edit the ICP/context file — add or change an exclusion, " +
    "reword the ICP, retarget — you MUST call sync_icp again in the SAME turn. The edit does NOT change the " +
    "ICP score, the exclusions, or the scoring model until you do; an unsynced file edit is silently inert. " +
    "The ICP section's source_path matters most (it's the write-back target for export_icp_model).",
    {
      sections: z.array(z.object({
        section: z.enum(["ICP", "Market", "Product", "Pricing", "Competitors", "Positioning", "GTM Motion", "Notes"])
          .describe("Which GTM context section this file/content maps to."),
        content: z.string().describe("The section's content, read from the file (trimmed prose, not the whole repo)."),
        source_path: z.string().optional()
          .describe("The file this came from, relative to the project root, e.g. 'context/icp.md'. Required on the ICP section so the learned model can be written back."),
      })).describe("One entry per ICP/positioning file (or section) you read."),
    },
    async ({ sections }) => {
      try {
        const r = await post("/v2/workspace/icp/import", { sections });
        const imp = r.imported ?? [];
        const lines = [
          `Synced ${imp.length} section${imp.length === 1 ? "" : "s"} from the user's files:`,
          ...imp.map((s) => `  • ${s.section}${s.source_path ? `  ← ${s.source_path}` : ""}`),
        ];
        if (r.skipped?.length) lines.push("", `Skipped (unknown/empty): ${r.skipped.join(", ")}`);
        // Section-check nudges from the server — the ICP file synced but is missing
        // canonical sections (buyer, fit, triggers, …). Surface them so the agent
        // rounds the file out and re-syncs, instead of the gaps passing silently.
        for (const w of (r.warnings ?? [])) {
          lines.push("", `⚠ ${w.message}`);
        }
        const sig = r.signals ?? [];
        if (r.model_status === "created" && sig.length) {
          lines.push("", `Built the ICP scoring model — ${sig.length} signal${sig.length === 1 ? "" : "s"}.`);
          lines.push("Next: if the user can name a few closed-won + closed-lost domains, call train_icp_model to sharpen it on real outcomes, then call export_icp_model to write the learned model back into their ICP file.");
        } else if (r.model_status === "no_icp_memory") {
          lines.push("", "Synced, but there wasn't enough ICP content to build a scoring model — make sure the ICP section has real content.");
        } else {
          lines.push("", "Context synced. Call export_icp_model when you want to write the learned model back into their ICP file.");
        }
        return { content: [{ type: "text", text: lines.join("\n").trim() }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes("no_sections") || msg.includes("no_valid_sections")) {
          return { content: [{ type: "text", text:
            "Nothing to sync. Read the user's ICP/positioning file(s) first and pass each as a section " +
            "(ICP, Positioning, Pricing, …) with its source_path. If they have no such file, offer to create context/icp.md." }] };
        }
        throw e;
      }
    }
  );

  // ===========================================================================
  // TOOL: export_icp_model  —  GET /v2/workspace/icp/model
  // The Nous→file half of the ICP symbiosis. Nous learns which signals actually
  // predict a win (lift + calibration) from real outcomes; this returns that
  // learned model as a ready-to-write fenced block, which the agent writes back
  // into the user's own ICP file with its native editor. Server renders the
  // block so the format is controlled centrally — the agent just persists it.
  // ===========================================================================
  server.tool(
    "export_icp_model",
    "Get the LEARNED ICP scoring model (which signals predict a win, their weight, lift, and the " +
    "calibration gap) as a ready-to-write markdown block, and write it back into the user's own ICP " +
    "file. This is the payoff of the symbiosis: their file keeps the words, Nous keeps the model, and " +
    "this writes the model under their words. CLAUDE CODE flow: call this after sync_icp or after " +
    "train_icp_model, then with your file tools open `target_path`, and if the file already has a " +
    "block between '<!-- nous:icp start -->' and '<!-- nous:icp end -->' REPLACE that whole block with " +
    "the returned `block`; if not, append the returned `block` (e.g. replacing a '## [To refine]' " +
    "placeholder). Never edit inside the markers by hand — this tool regenerates them. Everything " +
    "OUTSIDE the markers is the user's; never touch it.",
    {},
    async () => {
      const r = await get("/v2/workspace/icp/model");
      if (!r.has_model) {
        return { content: [{ type: "text", text:
          "No ICP scoring model yet. Sync the user's ICP file with sync_icp first (or build one with " +
          "build_icp_model / train_icp_model), then call this to write it back." }] };
      }
      // Lift can only be learned from WINS, so a win-less cohort (losses only) is
      // still seed estimates — don't claim it's "trained on real closed deals".
      const wonCount = r.calibration?.won ?? 0;
      const lostCount = r.calibration?.lost ?? 0;
      const note = wonCount > 0
        ? "This model is trained on real closed deals (lift + calibration shown)."
        : lostCount > 0
          ? `Still seed estimates — ${lostCount} closed-lost recorded but no closed-won yet to learn lift from. Add closed-won with train_icp_model to sharpen it.`
          : "This model is seeded from the ICP only — add closed deals with train_icp_model to sharpen it.";
      return { content: [{ type: "text", text:
        `Write the block below into ${r.target_path} with your file editor — replace any existing block ` +
        `between the nous:icp markers, or append it if there's none (create the file/section if absent). ` +
        `Leave everything outside the markers untouched. ${note}\n\n${r.block}` }] };
    }
  );

  // ===========================================================================
  // TOOL: connect_integration  —  POST /v2/workspace/integrations
  // The agent connects a KEY-BASED integration for the user (no clicking through
  // the Integrations page). OAuth providers still need a browser, so this is
  // limited to providers that authenticate with an API key/token.
  // ===========================================================================
  server.tool(
    "connect_integration",
    "Connect a key-based integration for the user — an enrichment, CRM, or sequencer provider that " +
    "authenticates with an API key or token (e.g. Apollo, Prospeo, Instantly, HubSpot private-app " +
    "token, Pipedrive, Attio, Smartlead, HeyReach). Ask the user for the provider's API key, then " +
    "call this; it verifies the credentials before saving. Providers that use a browser sign-in " +
    "(OAuth, e.g. Gmail) can't be connected this way — for those, point the user to the Integrations " +
    "page. After connecting an enrichment provider, the account record starts filling in.",
    {
      provider: z.string().describe("Provider name, lowercase — e.g. 'apollo', 'prospeo', 'instantly', 'hubspot', 'pipedrive', 'attio'."),
      credentials: z.record(z.string()).describe("The provider's credentials as key/value, e.g. { api_key: '...' } or { access_token: '...' }."),
      name: z.string().optional().describe("Optional label for the connection."),
    },
    async ({ provider, credentials, name }) => {
      try {
        const r = await post("/v2/workspace/integrations", { provider, credentials, name });
        return { content: [{ type: "text", text: `Connected ${r.connection?.provider ?? provider}.${r.message ? ` ${r.message}` : ""}` }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes("oauth_provider")) {
          return { content: [{ type: "text", text: `${provider} uses a browser sign-in, so it can't be connected with a key. Tell the user to connect it on the Integrations page.` }] };
        }
        if (msg.includes("invalid_credentials")) {
          return { content: [{ type: "text", text: `Those credentials didn't verify for ${provider}. Ask the user to double-check the key and try again.` }] };
        }
        if (msg.includes("unknown_provider")) {
          return { content: [{ type: "text", text: `No provider named "${provider}". Ask the user which tool they mean.` }] };
        }
        throw e;
      }
    }
  );

  // ===========================================================================
  // TOOL: configure_crm_sync  —  POST /v2/workspace/crm-sync
  // The agent sets the CRM sync rules — the same options as the CRM Sync page.
  // The CRM must already be connected (OAuth connect stays a human step).
  // ===========================================================================
  server.tool(
    "configure_crm_sync",
    "(Nous Cloud only) Configure how Nous keeps a connected CRM in sync — the same settings as the CRM Sync page. The " +
    "CRM must already be connected (HubSpot/Pipedrive/Attio). Set any of: auto-sync (daily pull), " +
    "push of touchpoints, the create policy (when a new record is auto-created and the ICP-fit " +
    "threshold), and the hygiene cadence. Only send the fields you want to change. If it reports the " +
    "CRM isn't connected, tell the user to connect it on the Integrations page first.",
    {
      provider: z.enum(["hubspot", "pipedrive", "attio"]).describe("Which connected CRM to configure."),
      autoSync: z.boolean().optional().describe("Pull contacts/companies/deals daily."),
      pushActivities: z.boolean().optional().describe("Push touchpoints (meetings, replies, proposals) back to the CRM."),
      createInCrm: z.boolean().optional().describe("Auto-create new records in the CRM when they earn it."),
      createTrigger: z.enum(["any_reply_or_meeting", "positive_reply_or_meeting", "meeting_only", "interested_stage"]).optional()
        .describe("What earns a new record."),
      createRequireIcpFit: z.boolean().optional().describe("Require an ICP-fit score before creating a record."),
      createIcpThreshold: z.number().optional().describe("Minimum ICP-fit score to create (0-100)."),
      hygieneEnabled: z.boolean().optional().describe("Run scheduled hygiene reconciliation."),
      hygieneCadence: z.enum(["weekly", "monthly"]).optional().describe("How often hygiene runs."),
    },
    async (args) => {
      try {
        const r = await post("/v2/workspace/crm-sync", args);
        const c = r.config ?? {};
        return { content: [{ type: "text", text:
          `CRM sync configured for ${args.provider}. auto-sync ${c.auto_sync ? "on" : "off"}, ` +
          `create ${c.create_in_crm ? `on (${c.create_trigger}${c.create_require_icp_fit ? `, ICP ≥ ${c.create_icp_threshold}` : ""})` : "off"}, ` +
          `hygiene ${c.hygiene_enabled ? c.hygiene_cadence : "off"}.` }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes("crm_not_connected")) {
          return { content: [{ type: "text", text: `${args.provider} isn't connected yet. Tell the user to connect it on the Integrations page, then configure sync.` }] };
        }
        throw e;
      }
    }
  );

  // ===========================================================================
  // TOOL: sync_crm_now  —  POST /v2/workspace/crm-sync-now
  // Run an immediate incremental CRM pull right now, instead of waiting for the
  // daily auto-sync cron — e.g. straight after configure_crm_sync, or whenever
  // the user wants the latest. Same engine the scheduled sync uses.
  // ===========================================================================
  server.tool(
    "sync_crm_now",
    "(Nous Cloud only) Pull the latest from a connected CRM (HubSpot/Pipedrive/Attio) RIGHT NOW, instead of waiting for " +
    "the daily auto-sync. Use it just after configure_crm_sync to seed the data, or whenever the user " +
    "wants an immediate refresh. Incremental by default (only what changed since the last pull); pass " +
    "full:true to re-fetch everything. The CRM must already be connected and sync configured — if not, " +
    "it'll tell you to connect/configure first.",
    {
      provider: z.enum(["hubspot", "pipedrive", "attio"]).optional().describe("Which connected CRM to pull from (default hubspot)."),
      full: z.boolean().optional().describe("true = re-fetch everything; default = incremental since the last sync."),
    },
    async ({ provider, full }) => {
      try {
        const r = await post("/v2/workspace/crm-sync-now", { provider: provider || "hubspot", full: full === true });
        const errs = (r.errors && r.errors.length) ? ` · ${r.errors.length} error(s)` : "";
        return { content: [{ type: "text", text:
          `Pulled from ${r.provider}: ${r.fetched ?? 0} records — ${r.created ?? 0} new, ${r.updated ?? 0} updated${errs}.` }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/sync_not_configured/.test(msg)) return { content: [{ type: "text", text: `Sync isn't configured for that CRM yet — call configure_crm_sync first.` }] };
        if (/crm_not_connected/.test(msg)) return { content: [{ type: "text", text: `That CRM isn't connected. Tell the user to connect it on the Integrations page, then try again.` }] };
        if (/salesforce_not_yet_supported/.test(msg)) return { content: [{ type: "text", text: `Salesforce pull isn't supported yet — only HubSpot, Pipedrive, and Attio.` }] };
        return { content: [{ type: "text", text: `Couldn't sync: ${msg}` }] };
      }
    }
  );

  // ===========================================================================
  // TOOL: set_trigger / list_triggers  —  /v2/workspace/triggers
  // Outbound event triggers (webhooks) — wire the user's stack to fire when the
  // record changes.
  // ===========================================================================
  server.tool(
    "set_trigger",
    "Create an outbound event trigger (a webhook) so an external tool is notified when something " +
    "happens in the workspace — e.g. a new contact, a reply, a meeting booked. Pass the destination " +
    "URL and which events to fire on. Call list_triggers first to see the available event names.",
    {
      url: z.string().describe("The destination URL the event is POSTed to."),
      events: z.array(z.string()).describe("Event names to fire on (see list_triggers for the catalog)."),
      name: z.string().optional().describe("Optional label for the trigger."),
    },
    async ({ url, events, name }) => {
      try {
        const r = await post("/v2/workspace/triggers", { url, events, name });
        return { content: [{ type: "text", text: `Trigger created for ${events.join(", ")} → ${url}.` }] };
      } catch (e) {
        const msg = String(e?.message ?? e);
        return { content: [{ type: "text", text: `Couldn't create the trigger: ${msg}. Call list_triggers to see valid event names.` }] };
      }
    }
  );
  server.tool(
    "list_triggers",
    "List the workspace's outbound event triggers (webhooks) and the catalog of available event names.",
    {},
    async () => {
      const r = await get("/v2/workspace/triggers");
      const lines = [];
      if (r.triggers?.length) {
        lines.push(`TRIGGERS (${r.triggers.length}):`);
        for (const t of r.triggers) lines.push(`  ${t.name || "(unnamed)"} → ${t.url}  [${(t.events || []).join(", ")}]`);
      } else {
        lines.push("No triggers set up yet.");
      }
      if (r.available_events?.length) {
        lines.push("", `AVAILABLE EVENTS: ${r.available_events.join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );

  // ===========================================================================
  // TOOL: lead_list_operations  —  GET /api/lead-lists[/:id/operations]
  // The operations trail for a lead list: imports, enrichment runs, pushes to
  // campaigns, and replies — filterable by category and time window. This is how
  // you answer "what happened on this list?" and attribute campaign performance
  // back to where the leads came from (the list's source). Call with no
  // lead_list_id to discover the lists and their ids first.
  // ===========================================================================
  server.tool(
    "lead_list_operations",
    "(Nous Cloud only) Inspect the operations trail of a lead list — imports, enrichment runs, pushes to campaigns, " +
    "and classified replies — to report on what happened and attribute outcomes to a list's source. " +
    "Call with NO lead_list_id to list the workspace's lead lists (id, name, count, source), then " +
    "call again with an id. Filter with `event` (import | enrich | export | reply) and `days`. " +
    "Each operation is a run-level summary (one row per import/enrich/push), not per-lead noise.",
    {
      lead_list_id: z.string().optional().describe("The lead list's UUID. Omit to list the available lead lists first."),
      event: z.enum(["import", "enrich", "export", "reply"]).optional().describe("Filter to one category of operation."),
      days: z.number().optional().describe("Look back this many days (default 30). Pass a large number for all-time."),
      limit: z.number().optional().describe("Max operations to return (default 100, cap 200)."),
    },
    async ({ lead_list_id, event, days, limit }) => {
      // Discovery mode — no list id yet. Return the lists so the agent can pick.
      if (!lead_list_id) {
        const r = await get("/api/lead-lists");
        const lists = r.lead_lists || [];
        const lines = lists.length
          ? [`LEAD LISTS (${lists.length}):`,
             ...lists.map(l => `  ${l.id}  ${l.name}  · ${l.lead_count ?? 0} leads · source: ${l.source || "—"}`),
             "", "Call lead_list_operations again with one of these ids (and an optional event filter)."]
          : ["No lead lists yet."];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const r = await get(`/api/lead-lists/${encodeURIComponent(lead_list_id)}/operations`, { event, days, limit });
      const ops = r.operations || [];
      const lines = [];
      const summary = Object.entries(r.by_category || {}).map(([k, v]) => `${k} ${v}`).join(" · ");
      lines.push(`OPERATIONS${event ? ` · ${event}` : ""} (${ops.length})${summary ? ` — ${summary}` : ""}`);
      if (!ops.length) {
        lines.push("", "No operations in this window.");
      } else {
        for (const o of ops) {
          const cat = o.metadata?.category || o.event_type;
          lines.push(`  ${relAge(o.occurred_at).padEnd(8)} ${String(cat).padEnd(8)} ${o.summary}`);
        }
      }
      return { content: [{ type: "text", text: lines.join("\n").trim() }] };
    }
  );

  // ===========================================================================
  // TOOL: get_coverage  —  POST /v2/dedup (exact) | GET /v2/people/coverage (estimate)
  // "What do I already have?" before spending on a list elsewhere. One tool, two
  // modes: pass identifiers for an EXACT per-lead net-new/re-enrich/reuse check
  // (the pre-spend gate), or a title/keyword for a rough attribute ESTIMATE.
  // (Replaces the former check_leads + lead_coverage tools.)
  // ===========================================================================
  server.tool(
    "get_coverage",
    "(Nous Cloud only) Check what you ALREADY have before spending on a list elsewhere (Apollo, Sales Navigator, Clay). " +
    "Two modes:\n" +
    "  • EXACT — pass candidate identifiers (emails / linkedin_urls / domains, free in any tool's " +
    "preview). Returns per-lead buckets: net_new (acquire + enrich), needs_enrichment (you OWN these " +
    "but stale >90d — re-enrich, don't re-buy), reusable (fresh verified email on file — reuse, spend " +
    "nothing), plus engaged/recent/known/bounced to skip. Each result carries entity_id, email_status, " +
    "enriched_at, stale.\n" +
    "  • ESTIMATE — pass a title and/or keyword instead. Returns how many people you already have " +
    "matching (e.g. title='founder', keyword='agency'), split by freshness: never-enriched, stale >90d, " +
    "fresh-verified. Rough by design (title precise; keyword matches title/company/department).\n" +
    "Pass identifiers for the exact pre-spend check, OR title/keyword for the planning estimate — not both.",
    {
      emails: z.array(z.string()).optional().describe("EXACT mode — candidate email addresses (up to 50,000)."),
      linkedin_urls: z.array(z.string()).optional().describe("EXACT mode — candidate LinkedIn profile URLs (up to 50,000)."),
      domains: z.array(z.string()).optional().describe("EXACT mode — company domains, 'do I already have anyone here?' (up to 50,000)."),
      title: z.string().optional().describe("ESTIMATE mode — role match, e.g. 'founder', 'VP Sales' (matches job_title)."),
      keyword: z.string().optional().describe("ESTIMATE mode — extra match across title/company/department, e.g. 'agency'."),
      stale_days: z.number().optional().describe("ESTIMATE mode — days after which enrichment counts as stale (default 90)."),
    },
    async ({ emails, linkedin_urls, domains, title, keyword, stale_days }) => {
      const hasIds  = !!(emails?.length || linkedin_urls?.length || domains?.length);
      const hasAttr = !!(title || keyword);
      if (hasIds && hasAttr) {
        return { content: [{ type: "text", text:
          "Pass identifiers (emails/linkedin_urls/domains) for the exact check, OR title/keyword for the estimate — not both." }] };
      }

      // EXACT mode — per-identifier coverage against /v2/dedup.
      if (hasIds) {
        const body = {};
        if (emails?.length) body.emails = emails;
        if (linkedin_urls?.length) body.linkedin_urls = linkedin_urls;
        if (domains?.length) body.domains = domains;
        const r = await post("/v2/dedup", body);
        const s = r.summary || {};
        const lines = [
          `COVERAGE (${s.total ?? 0} checked)`,
          `  net_new          ${s.net_new ?? 0}   → acquire + enrich`,
          `  needs_enrichment ${s.needs_enrichment ?? 0}   → you OWN these but stale (>90d) → re-enrich, don't re-buy`,
          `  reusable         ${s.reusable ?? 0}   → fresh verified email on file → reuse, spend nothing`,
          `  engaged          ${s.engaged ?? 0}   → in an active conversation, don't cold-send`,
          `  recent           ${s.recent ?? 0}   → contacted <30d, defer`,
          `  known            ${s.known ?? 0}   → company already in the workspace`,
          `  bounced/unsub    ${(s.bounced ?? 0) + (s.unsubscribed ?? 0) + (s.suppressed ?? 0)}   → skip`,
        ];
        // Surface a few stale entities the caller should re-enrich (with their last date).
        const stale = (r.results || []).filter(x => x.entity_id && x.stale).slice(0, 15);
        if (stale.length) {
          lines.push("", "RE-ENRICH (sample):");
          for (const x of stale) {
            lines.push(`  ${x.value}  [${x.enriched_at ? `last enriched ${relAge(x.enriched_at)}` : "never enriched"}]  ${x.entity_id}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ESTIMATE mode — attribute coverage against /v2/people/coverage.
      if (hasAttr) {
        const r = await get("/v2/people/coverage", { title, keyword, stale_days });
        const lines = [
          `COVERAGE — ${[title && `title~"${title}"`, keyword && `keyword~"${keyword}"`].filter(Boolean).join(" + ")}`,
          `  ${r.total ?? 0} already in your workspace`,
          `    ${r.needs_enrichment ?? 0} need (re-)enrichment  (${r.never_enriched ?? 0} never enriched · ${r.stale ?? 0} stale >90d)`,
          `    ${r.fresh_verified ?? 0} have a fresh verified email`,
        ];
        const sample = r.sample || [];
        if (sample.length) {
          lines.push("", "SAMPLE (oldest first):");
          for (const s of sample.slice(0, 12)) {
            lines.push(`  ${[s.job_title, s.company].filter(Boolean).join(" @ ") || s.entity_id}  [${s.enriched_at ? `enriched ${relAge(s.enriched_at)}` : "never enriched"}]`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      return { content: [{ type: "text", text:
        "Pass at least one of: emails / linkedin_urls / domains (exact check), or title / keyword (estimate)." }] };
    }
  );

  // ===========================================================================
  // TOOLS: enrich_leads / verify_leads  —  POST /api/lead-lists/:id/enrich|verify
  // The agent OPERATES the lead list. Both are two-step: a dry-run preview that
  // quotes the chargeable count + provider + $ estimate (report it to the user
  // first), then a confirmed run as a background job. Target by `filter` so no
  // ids are needed (enrich {emailStatus:'none'} = all missing an email; verify
  // defaults to all unverified). BYOK — the $ is the user's own provider spend.
  // ===========================================================================
  const fmtCost = (c) => {
    if (!c) return "no chargeable records — nothing to spend";
    const money = c.low === c.high ? `~$${c.low.toFixed(2)}` : `~$${c.low.toFixed(2)}–$${c.high.toFixed(2)}`;
    return `${money} via ${c.label} (${(c.count ?? 0).toLocaleString()} ${c.action})`;
  };
  const LEAD_FILTER_SHAPE = {
    emailStatus: z.enum(["has", "none", "unverified"]).optional().describe("none = no email yet; unverified = has an email but no verification verdict; has = has any email."),
    domain: z.enum(["has", "none"]).optional().describe("has = a company domain is known; none = no domain."),
    icp: z.enum(["true", "false"]).optional().describe("true = ICP-qualified leads only."),
    status: z.string().optional().describe("Lifecycle: pending | sent | replied | bounced."),
    source: z.string().optional().describe("Substring of where the lead came from (campaign / import name)."),
    size: z.string().optional().describe("Substring of company size, e.g. '1 to 10'."),
    channel: z.string().optional().describe("Last-contacted channel substring, or 'none' for not-yet-contacted."),
  };

  server.tool(
    "enrich_leads",
    "(Nous Cloud only) Find missing emails for leads in a lead list, on the workspace's own Prospeo/Apollo key. ALWAYS two " +
    "steps: call WITHOUT confirm for a dry-run cost preview (chargeable count, provider, $ estimate) — " +
    "report it and get the user's go-ahead — then call again with confirm:true to run as a background job. " +
    "Pick leads with `filter` (e.g. {emailStatus:'none'} = every lead missing an email, the usual case) or " +
    "explicit `ids`; defaults to {emailStatus:'none'}. Call lead_list_operations with no id first to get the " +
    "list's id.",
    {
      lead_list_id: z.string().describe("The lead list's UUID."),
      filter: z.object(LEAD_FILTER_SHAPE).optional().describe("Pick leads by attribute. Omit (with no ids) to default to all leads missing an email."),
      ids: z.array(z.string()).optional().describe("Explicit lead ids — an alternative to filter."),
      confirm: z.boolean().optional().describe("Omit or false = dry-run cost preview only (spends nothing). true = actually run it as a background job."),
    },
    async ({ lead_list_id, filter, ids, confirm }) => {
      const sel = (ids && ids.length) ? { ids } : { filter: filter || { emailStatus: "none" } };
      const path = `/api/lead-lists/${encodeURIComponent(lead_list_id)}/enrich`;
      try {
        if (!confirm) {
          const r = await post(path, { ...sel, preview: true });
          const lines = [
            `ENRICH PREVIEW — list ${lead_list_id}`,
            `  ${r.total ?? 0} selected · ${r.chargeable ?? 0} chargeable · ${r.reused ?? 0} already on file (free) · ${r.no_identifier ?? 0} no identifier`,
            `  provider: ${r.provider || "—"}`,
            `  estimated cost: ${fmtCost(r.cost)}`,
            "",
            r.chargeable
              ? "Report this to the user. To run it, call enrich_leads again with the same selection and confirm:true."
              : "Nothing chargeable to enrich.",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        const r = await post(path, { ...sel, background: true });
        return { content: [{ type: "text", text:
          `Enrichment started — job ${r.job_id}, ${r.total} lead${r.total === 1 ? "" : "s"} queued. It runs in the background; report back to the user that it's running.` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Couldn't enrich: ${e.message}` }] };
      }
    }
  );

  server.tool(
    "verify_leads",
    "(Nous Cloud only) Validate email deliverability for leads in a lead list, on the workspace's own MillionVerifier / " +
    "NeverBounce key. ALWAYS two steps: call WITHOUT confirm for a dry-run cost preview (chargeable count, " +
    "connected verifiers, $ estimate) — report it to the user — then call again with confirm:true to run as " +
    "a background job. Defaults to every UNVERIFIED email (has an address, no verdict yet); narrow with " +
    "`filter` or pass `ids`. If no verifier is connected it says so — tell the user to add a MillionVerifier " +
    "or NeverBounce key in Integrations.",
    {
      lead_list_id: z.string().describe("The lead list's UUID."),
      filter: z.object(LEAD_FILTER_SHAPE).optional().describe("Pick leads by attribute. Omit (with no ids) to default to all unverified emails."),
      ids: z.array(z.string()).optional().describe("Explicit lead ids — an alternative to filter."),
      provider: z.enum(["millionverifier", "neverbounce"]).optional().describe("Which verifier to use. Defaults to MillionVerifier, then NeverBounce."),
      confirm: z.boolean().optional().describe("Omit or false = dry-run cost preview only. true = actually run it as a background job."),
    },
    async ({ lead_list_id, filter, ids, provider, confirm }) => {
      const sel = (ids && ids.length) ? { ids } : { filter: filter || { emailStatus: "unverified" } };
      const path = `/api/lead-lists/${encodeURIComponent(lead_list_id)}/verify`;
      try {
        if (!confirm) {
          const r = await post(path, { ...sel, provider, preview: true });
          const lines = [
            `VERIFY PREVIEW — list ${lead_list_id}`,
            `  ${r.total ?? 0} selected · ${r.chargeable ?? 0} chargeable · ${r.reused ?? 0} recently verified (free) · ${r.no_email ?? 0} no email`,
            `  verifier: ${r.provider || "—"}${r.connected_verifiers ? `  (connected: ${r.connected_verifiers.join(", ") || "none"})` : ""}`,
            `  estimated cost: ${fmtCost(r.cost)}`,
            "",
            r.chargeable
              ? "Report this to the user. To run it, call verify_leads again with the same selection and confirm:true."
              : "Nothing chargeable to verify.",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        const r = await post(path, { ...sel, provider, background: true });
        return { content: [{ type: "text", text:
          `Verification started — job ${r.job_id}, ${r.total} email${r.total === 1 ? "" : "s"} queued via ${r.provider}. It runs in the background; report back to the user.` }] };
      } catch (e) {
        const msg = /no_verifier_connected/.test(e.message)
          ? "No email verifier is connected. Tell the user to add a MillionVerifier or NeverBounce API key in Integrations, then try again."
          : `Couldn't verify: ${e.message}`;
        return { content: [{ type: "text", text: msg }] };
      }
    }
  );

  // ===========================================================================
  // TOOL: scrape_engagers
  // On-demand LinkedIn engager scrape — mine who commented/reacted on the
  // workspace's own recent posts into the native "LinkedIn Engagers" list, NOW,
  // instead of waiting for the weekly cron. Backfill a wider window with `days`.
  // ===========================================================================
  server.tool(
    "scrape_engagers",
    "Scrape the people who commented or reacted on YOUR OWN recent LinkedIn posts into the native " +
    "\"LinkedIn Engagers\" lead list — right now, instead of waiting for the weekly auto-run. Each " +
    "engager is saved with the engagement captured (the actual comment text for comments, the " +
    "reaction for likes) on their timeline. Use when the user says \"scrape engagers\", \"who " +
    "engaged with my last post\", or \"backfill my engagers for the last N months\". `days` sets the " +
    "look-back window (default 7, since the weekly run already covers the recent past; pass a larger " +
    "value like 60 to backfill). Runs on the workspace's OWN Apify key (bring-your-own-key) — if none " +
    "is connected it says so; tell the user to add an Apify key in Integrations. The scrape runs in " +
    "the background (within a minute); the new engagers then appear in the list.",
    {
      days: z.number().int().min(1).max(120).optional().describe("Look-back window in days. Default 7. Use a larger value (e.g. 60) to backfill a gap since the last scrape."),
    },
    async ({ days }) => {
      try {
        const r = await post("/api/linkedin/engagement/scrape", { days });
        const lastLine = r.last_scraped_at
          ? `Last scraped ${relAge(r.last_scraped_at)}.`
          : "First scrape for this workspace.";
        return { content: [{ type: "text", text:
          `Engager scrape queued — mining the last ${r.days} day(s) across ${r.accounts} connected ` +
          `LinkedIn account${r.accounts === 1 ? "" : "s"}. ${lastLine} It runs in the background; ` +
          `new engagers land in the "LinkedIn Engagers" list within a minute or two.` }] };
      } catch (e) {
        const msg = /apify_not_connected/.test(e.message)
          ? "Engager scraping is bring-your-own-key. Tell the user to add their own Apify key in Integrations, then try again."
          : /linkedin_not_connected/.test(e.message)
          ? "No LinkedIn account is connected. Tell the user to connect LinkedIn in Integrations first."
          : /needs_plan/.test(e.message)
          ? "LinkedIn engager scraping is on the Pro plan and up. Tell the user to upgrade to use it."
          : `Couldn't start the scrape: ${e.message}`;
        return { content: [{ type: "text", text: msg }] };
      }
    }
  );

  // ===========================================================================
  // TOOL: get_routing_preferences
  // The routing preferences that make THIS agent default to Nous for GTM. The
  // agent applies them itself in Claude Code (write to CLAUDE.md); for claude.ai
  // the user pastes them into Org preferences. Not applicable to Codex/others.
  // ===========================================================================
  server.tool(
    "get_routing_preferences",
    "Get the routing preferences that make this agent treat Nous as the DEFAULT for GTM — so it " +
    "reaches for get_context / get_account instead of raw CRM or HubSpot / Salesforce / Gong / " +
    "Granola when someone forgets to say \"Nous\". This is an OPTIONAL onboarding step, and " +
    "CLAUDE CODE-specific. If you are running in Claude Code, set it up for the user: ask whether to " +
    "apply it to this project (write the returned text to ./CLAUDE.md) or to all projects " +
    "(~/.claude/CLAUDE.md), then write it there. The user can also paste it into claude.ai → Settings " +
    "→ Organization preferences (Team/Enterprise) or Personal preferences (Pro). If you are NOT Claude " +
    "Code (Codex, Cursor, n8n, …), this does not apply — skip it.",
    {},
    async () => {
      return { content: [{ type: "text", text:
        `Routing preferences (write to the user's CLAUDE.md in Claude Code, or have them paste into ` +
        `claude.ai → Settings → Organization/Personal preferences):\n\n${ROUTING_PREFERENCES}` }] };
    }
  );

  return server;
}
