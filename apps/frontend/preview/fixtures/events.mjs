// Preview fixtures for the Events page (GET-939): GET /v2/events and /v2/events/:id, shaped like the
// real envelope (packages/core/src/services/events.mjs). Times are relative to now, so the feed
// always reads as live. Served on every preview plan.
import { COMPANIES } from "../world.mjs";

const MIN = 60_000;
const ago = (m) => new Date(Date.now() - m * MIN).toISOString();
const co = (id) => COMPANIES.find((c) => c.id === id);
const account = (id) => {
  const c = co(id);
  return { entity_id: c.id, name: c.name, domain: c.domain, industry: c.industry, icp: { score: c.icp_score, tier: c.icp_score >= 80 ? "Tier 1" : "Tier 2" }, health: c.deal_health_score, api_url: `/v2/accounts/${c.id}` };
};
const uuid = (n) => `e0e0e0e0-0000-4000-8000-${String(n).padStart(12, "0")}`;

function envelope(n, type, minutesAgo, accountId, rest = {}) {
  return {
    id: uuid(n), type, api_version: "2026-10-01", occurred_at: ago(minutesAgo), workspace_id: "preview",
    account: accountId ? account(accountId) : null, people: [], deal: null, deals_count: 0,
    evidence: { claims: [], facts: [] }, data: {}, ...rest,
  };
}

const EVENTS = [
  envelope(1, "signal.stakeholder_left", 12, "c1", {
    people: [{ name: "Sarah Chen", title: "VP Operations", stage: "champion" }, { name: "Tom Reyes", title: "Director of Operations" }],
    deal: { name: "Meridian renewal", stage: "negotiation", amount: 84000, currency: "USD", close_date: "2026-12-13", owner: { name: "Dana Whitfield", email: null } },
    deals_count: 1,
    evidence: {
      claims: [{ property: "champion", value: "Sarah Chen", confidence: 0.92, freshness: "suspect" }],
      facts: [
        { fact: "Sarah Chen moved to a new role at another company.", source: "linkedin", observed_at: ago(60 * 26) },
        { fact: "Email to Sarah Chen bounced.", source: "gmail", observed_at: ago(60 * 20) },
      ],
    },
    data: { signal: "stakeholder_left", label: "Stakeholder left", title: "Champion left: Sarah Chen, VP Operations", text: "Sarah Chen has left Meridian Analytics; Tom Reyes now runs Operations.", said_by: null },
  }),
  envelope(2, "conversation.call_ended", 38, "c3", { data: { title: "Cobalt Systems: pilot kickoff", source: "fireflies", call_type: "customer" } }),
  envelope(3, "signal.expansion_signal", 41, "c4", {
    data: { signal: "expansion_signal", label: "Expansion signal", title: "Finance team asked for access", text: "Their CFO asked whether the finance team can get seats next quarter.", quote: "Could finance get on this too?", said_by: "Priya Nair" },
  }),
  envelope(4, "signal.objection_raised", 95, "c1", { data: { signal: "objection_raised", label: "Objection raised", title: "Security review before any rollout", quote: "Nothing goes live until security signs off." } }),
  envelope(5, "conversation.reply_received", 140, "c2", { data: { source: "gmail", thread_id: "t-northwind-pricing" } }),
  envelope(6, "deal.stage_changed", 60 * 3, "c3", { data: { stage: "pilot", changed_at: ago(60 * 3) } }),
  envelope(7, "signal.competitor_evaluating", 60 * 5, "c6", { data: { signal: "competitor_evaluating", label: "Evaluating a competitor", title: "Running a Gong trial in parallel" } }),
  envelope(8, "icp.score_changed", 60 * 7, "c5", { data: { from: { score: 71, tier: "Tier 2" }, to: { score: 88, tier: "Tier 1" }, scorer: "nous" } }),
  envelope(9, "deal.won", 60 * 26, "c4", { deal: { name: "Atlas Health: platform", stage: "closed_won", amount: 120000, currency: "USD" }, data: { outcome: "won" } }),
  envelope(10, "people.added", 60 * 30, null, { data: { count: 14, person_ids: [], more: false } }),
  envelope(11, "signal.next_step", 60 * 32, "c2", { data: { signal: "next_step", label: "Next step", title: "Send the security questionnaire by Friday" } }),
];

function list(q) {
  const type = q.get("type");
  const acc = q.get("account");
  const after = q.get("starting_after");
  const limit = Math.min(Number(q.get("limit")) || 25, 100);
  let rows = EVENTS.filter((e) => !type || (type.endsWith(".*") ? e.type.startsWith(type.slice(0, -1)) : e.type === type))
    .filter((e) => !acc || e.account?.entity_id === acc);
  if (after) rows = rows.slice(rows.findIndex((e) => e.id === after) + 1);
  const page = rows.slice(0, limit);
  return { object: "list", api_version: "2026-10-01", data: page, has_more: rows.length > limit, next_starting_after: rows.length > limit ? page.at(-1).id : null };
}

export const routes = [
  ["GET", /^\/v2\/events$/, (_m, q) => list(q)],
  ["GET", /^\/v2\/events\/([^/]+)$/, (m) => EVENTS.find((e) => e.id === m[1]) ?? { error: "event_not_found" }],
];
