// Preview fixtures for the API plan's Webhooks (GET-632) and Usage and billing (GET-633) pages.
// Served only with PREVIEW_PLAN=api (server.mjs spreads these into its route table then), so the
// visual baselines never see them. Shapes match the real routes: /api/triggers (+ C2's
// deliveries, stats, resend, test), /api/webhooks/urls, /api/usage/by-key (C1), /api/usage/conversations,
// /api/billing/invoices.
import { BILLING_STATE } from "../world.mjs";

const MIN = 60_000;
const DAY = 86_400_000;
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const triggers = [
  {
    id: "7b0c4a8e-1f2d-4c3b-9a5e-0d1e2f3a4b5c", workspace_id: "ws", name: "n8n production",
    url: "https://hooks.n8n.cloud/webhook/nous", events: ["deal.stage_changed", "interaction.email_received", "interaction.meeting_held", "deal.won"],
    active: true, created_at: at(30 * DAY), updated_at: at(2 * DAY),
  },
  {
    id: "c2e9d1f0-3a4b-4d5e-8f6a-7b8c9d0e1f2a", workspace_id: "ws", name: "Slack relay",
    url: "https://relay.example.com/nous/events", events: ["deal.won", "deal.lost", "conversation.call_ended", "conversation.reply_received", "interaction.meeting_scheduled"],
    active: true, created_at: at(12 * DAY), updated_at: at(12 * DAY),
  },
  // Paused, and subscribed to the rest of the catalog, so every event the API emits shows (GET-660).
  {
    id: "e4f5a6b7-8c9d-4e0f-a1b2-c3d4e5f6a7b8", workspace_id: "ws", name: "Clay enrichment",
    url: "https://api.clay.com/v3/sources/webhook/nous", events: ["interaction.email_bounced", "interaction.linkedin_connection_accepted", "interaction.linkedin_message_received"],
    active: false, created_at: at(5 * DAY), updated_at: at(1 * DAY),
  },
  // A GitHub destination (GET-670): the repo's Actions run on each event via repository_dispatch.
  {
    id: "a9b8c7d6-5e4f-4a3b-8c2d-1e0f9a8b7c6d", workspace_id: "ws", name: "Follow-up drafts",
    url: null, destination_type: "github", github_repo: "opennous/revenue-agents",
    events: ["conversation.call_ended", "conversation.reply_received"],
    active: true, created_at: at(3 * DAY), updated_at: at(3 * DAY),
  },
].map((t) => ({ ...t, destination: t.destination_type === "github" ? { type: "github", repo: t.github_repo } : { type: "url", url: t.url } }));

const row = (sub, n, msAgo, event, status_code, attempt, duration_ms, error = null) => ({
  id: `${sub.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`, subscription_id: sub,
  outbound_event_id: `oe-${n}`, event, event_id: `evt_${n}`, attempt, status_code,
  ok: status_code != null && status_code >= 200 && status_code < 300, error, duration_ms,
  created_at: at(msAgo), resent_from: null,
});

const deliveries = {
  [triggers[0].id]: [
    row(triggers[0].id, 1, 12 * MIN, "deal.stage_changed", 200, 1, 184),
    row(triggers[0].id, 2, 14 * MIN, "interaction.email_received", 200, 1, 161),
    row(triggers[0].id, 3, 2 * 60 * MIN, "interaction.meeting_held", null, 2, 10_000, "timeout"),
    row(triggers[0].id, 4, 3 * 60 * MIN, "deal.stage_changed", 200, 1, 203),
    row(triggers[0].id, 5, 5 * 60 * MIN, "deal.won", 200, 2, 240),
    row(triggers[0].id, 6, 6 * 60 * MIN, "deal.stage_changed", 500, 5, 1200, "Internal Server Error"),
  ],
  [triggers[1].id]: [
    row(triggers[1].id, 7, 40 * MIN, "deal.won", 502, 3, 930, "Bad Gateway"),
    row(triggers[1].id, 8, 41 * MIN, "deal.won", 502, 2, 880, "Bad Gateway"),
    row(triggers[1].id, 9, 3 * 60 * MIN, "deal.lost", 503, 1, 1020, "Service Unavailable"),
    row(triggers[1].id, 10, 2 * DAY, "deal.won", 200, 1, 210),
  ],
  [triggers[3].id]: [
    row(triggers[3].id, 13, 25 * MIN, "conversation.call_ended", 204, 1, 412),
    row(triggers[3].id, 14, 4 * 60 * MIN, "conversation.reply_received", 204, 1, 388),
  ],
  [triggers[2].id]: [
    row(triggers[2].id, 11, 2 * DAY, "interaction.linkedin_message_received", 200, 1, 132),
    row(triggers[2].id, 12, 3 * DAY, "interaction.email_bounced", 200, 1, 118),
  ],
};
const stats = {
  [triggers[0].id]: { success_rate_7d: 0.9917, deliveries_7d: 120, failures_7d: 1, last_delivery_at: at(12 * MIN) },
  [triggers[1].id]: { success_rate_7d: 0.4, deliveries_7d: 10, failures_7d: 6, last_delivery_at: at(40 * MIN) },
  [triggers[2].id]: { success_rate_7d: 1, deliveries_7d: 2, failures_7d: 0, last_delivery_at: at(2 * DAY) },
  [triggers[3].id]: { success_rate_7d: 1, deliveries_7d: 14, failures_7d: 0, last_delivery_at: at(25 * MIN) },
};

const inbound = ["instantly", "smartlead", "lemlist", "emailbison", "rb2b"].map((source, i) => ({
  source, url: `https://api.opennous.cloud/webhooks/${source}/wk_8f2c1d`, auto_registered: source === "lemlist",
  last_event_at: i < 3 ? at((i + 1) * 60 * MIN) : null, status: i < 3 ? "live" : "pending", active: i < 3, manual: false,
}));
// Fireflies is the Integrations pages' manual-webhook source (api-plan-p3.mjs); this route is the
// one both pages read, so it carries that row too.
inbound.push({
  source: "fireflies", url: "https://api.opennous.cloud/inbound/fireflies/ws-preview", auto_registered: false,
  last_event_at: at(9 * MIN), status: "live", active: true, manual: true,
});
// Every status on the Webhooks page (GET-675): Calendly was set up for us and has gone quiet
// (stale), RB2B was added by hand and has not sent anything yet (pending).
inbound.push({
  source: "calendly", url: "https://api.opennous.cloud/webhooks/calendly/wk_8f2c1d", auto_registered: true,
  last_event_at: at(29 * DAY), status: "stale", active: true, manual: false,
});
Object.assign(inbound.find((w) => w.source === "rb2b"), { active: true, manual: true });

// 30 days of credits, the shape /api/usage/conversations returns. Fixed values so a screenshot
// today matches one tomorrow.
const DAILY = [4, 6, 3, 2, 9, 12, 8, 5, 7, 14, 11, 6, 3, 2, 10, 13, 9, 8, 15, 18, 12, 31, 16, 9, 4, 3, 11, 14, 17, 12];
const daily = () => DAILY.map((credits, i) => {
  const d = new Date(Date.now() - (DAILY.length - 1 - i) * DAY);
  return { day: d.toISOString().slice(0, 10), credits, calls: credits * 6 };
});

const invoices = [0, 1, 2].map((m) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - m);
  return { id: `in_${m}`, number: `NOUS-00${3 - m}`, amount: 49, currency: "USD", status: "paid", created: d.toISOString(), url: "https://invoice.stripe.com/preview", pdf: "https://pay.stripe.com/invoice/preview/pdf" };
});

export const apiPlanP4Routes = [
  ["GET", /^\/api\/triggers$/, () => ({ triggers, available_events: [
    "interaction.email_received", "interaction.email_bounced", "interaction.linkedin_connection_accepted",
    "interaction.linkedin_message_received", "interaction.meeting_scheduled", "interaction.meeting_held",
    "conversation.call_ended", "conversation.reply_received", "deal.won", "deal.lost", "deal.stage_changed",
  ] })],
  ["GET", /^\/api\/triggers\/([^/]+)\/stats$/, (m) => stats[m[1]] ?? { error: "not_found" }],
  ["GET", /^\/api\/triggers\/([^/]+)\/deliveries$/, (m) => {
    const list = deliveries[m[1]];
    return list ? { deliveries: list, next_before: null } : { error: "not_found" };
  }],
  ["POST", /^\/api\/triggers\/deliveries\/([^/]+)\/resend$/, (m) => {
    const all = Object.values(deliveries).flat();
    const d = all.find((x) => x.id === m[1]);
    if (!d) return { error: "not_found" };
    // The oldest row stands in for an event whose payload has aged out.
    if (d.created_at < at(DAY)) return { __status: 410, error: "payload_gone" };
    return { delivery: { ...d, id: `${d.id}-r`, resent_from: d.id, created_at: at(0) }, result: { ok: true, status_code: 200, error: null, duration_ms: 172 } };
  }],
  // Send test (E4): the test lands at the top of that endpoint's log, like the real route, which
  // sends it now and records a webhook.test attempt. The Slack relay one answers 503.
  ["POST", /^\/api\/triggers\/([^/]+)\/test$/, (m) => {
    const list = deliveries[m[1]];
    if (!list) return { __status: 404, error: "not_found" };
    const failing = m[1] === triggers[1].id;
    const n = 100 + list.length;
    const d = row(m[1], n, 0, "webhook.test", failing ? 503 : 200, 1, failing ? 412 : 143, failing ? "503 Service Unavailable" : null);
    list.unshift(d);
    return { event_id: d.event_id, account: "Northwind", delivery: d, result: { ok: d.ok, status_code: d.status_code, error: d.error, duration_ms: d.duration_ms } };
  }],
  // The list never carries a signing secret; a rotate hands the new one back once (GET-620 review).
  ["PATCH", /^\/api\/triggers\/([^/]+)$/, async (m, _q, req) => {
    const t = triggers.find((x) => x.id === m[1]);
    if (!t) return { error: "not_found" };
    const raw = await new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty */ }
    return body.rotate_secret ? { trigger: t, signing_secret: "whsec_Rn4Tq8Vb2Lm6Xc9Pz3Kd7Hs1Wf5Jy0c4e" } : { trigger: t };
  }],
  ["GET", /^\/api\/webhooks\/urls$/, () => ({ urls: inbound })],
  // One by-key fixture for both readers: Home asks for today (?days=1), Usage for 30 days. The
  // ids are the keys fixture's (api-plan-p2.mjs), so the Usage page's "By key" rows open /keys/:id.
  ["GET", /^\/api\/usage\/by-key$/, (_m, q) => {
    const today = Number(q.get("days")) === 1;
    return { days: today ? 1 : 30, keys: [
      { api_key_id: "11111111-1111-4111-8111-111111111111", name: "claude-code", revoked: false, calls: today ? 412 : 9812, credits: today ? 12 : 214 },
      { api_key_id: "22222222-2222-4222-8222-222222222222", name: "n8n-prod", revoked: false, calls: today ? 144 : 2410, credits: today ? 2 : 36 },
      { api_key_id: "33333333-3333-4333-8333-333333333333", name: "metabase-readonly", revoked: false, calls: today ? 33 : 640, credits: 0 },
    ], credits_complete: true };
  }],
  ["GET", /^\/api\/usage\/conversations$/, () => ({ daily: daily() })],
  ["GET", /^\/api\/billing\/invoices$/, () => ({ invoices })],
  ["GET", /^\/api\/billing\/state$/, () => ({
    ...BILLING_STATE, plan: "api", planName: "Nous",
    stripe: { customer: true, subscription: true },
    // PREVIEW_CREDITS=over shows the over-the-allowance state (GET-733); the baselines never set it.
    aiCredits: process.env.PREVIEW_CREDITS === "over" ? {
      used: 1040, included: 960, remaining: 0, percentUsed: 108, state: "over", nextTier: { credits: 2000, priceUsd: 99 },
      untilStop: 112, daysUntilStop: 1, periodEnd: BILLING_STATE.subscription.current_period_end,
      needsPlan: false, notLiveReason: null, periodStart: BILLING_STATE.subscription.current_period_start, unlimited: false,
    } : {
      used: 312, included: 960, remaining: 648, percentUsed: 33, state: "ok", nextTier: { credits: 2000, priceUsd: 99 },
      needsPlan: false, notLiveReason: null, periodStart: BILLING_STATE.subscription.current_period_start, unlimited: false,
      backfill: { used: 2140, allowance: 3000, startedAt: at(6 * DAY), showUntil: new Date(Date.now() + 24 * DAY).toISOString() },
    },
  })],
];
