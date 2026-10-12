// Preview API — a dependency-free stand-in for apps/api on :3000.
//
// Serves the fixture world (world.mjs) on the SAME port, paths and shapes the
// real API uses, so the untouched frontend runs against it via its normal
// VITE_API_URL. When real credentials exist, stop this and start the real API —
// nothing in the frontend knows the difference.
//
//   node apps/frontend/preview/server.mjs        (or: pnpm --filter ./apps/frontend run preview:api)
//
// Unmatched /api|/v2 paths 404 with a console line, so gaps are visible instead
// of silently blanking a page.
import http from "node:http";
import {
  WS, USERS, COMPANIES, CONTACTS, FLAGS, TASKS, PORTFOLIO, GRAPH, CAMPAIGNS,
  companyDetail, personRecord, icpRecord,
  THREADS, THREAD_MESSAGES, SKILLS, NOTIFICATIONS, ACTIVITY_STATS,
  SYSTEM_LOG, SYSTEM_LOG_STATS, ADOPTION, INSIGHT_THEMES, INSIGHT_BOARD, HOME,
  SUBSTRATE, SCORECARD, SCORECARD_RUNS, CONTEXT_CHANGES, WORKSPACE_MEMORIES,
  ME, USAGE, BILLING_STATE, ONBOARDING_STATUS, OPS_BREAKDOWN,
  readScope, homeFor, companiesList, accountHealthFor, dealsPayload, crmPipelines, stagesFor, csPayload, HANDOFFS, DEALS,
  FOLLOW_UPS, followUpCrm, followUpInScope, PREVIEW_VIEWER,
  reportsOverview, TH1_PENDING_ACTIONS, TH1_AGENT_ACTIONS, PENDING_DRAFTS, NOT_IN_CRM,
} from "./world.mjs";

const PORT = Number(process.env.PORT) || 3000;

// Mutable copies so PATCHes stick for the session (resolve a flag, close a task).
// Contacts are mutated IN PLACE on the world's array so companyDetail()/
// personRecord() see org-chart additions too.
const flags = structuredClone(FLAGS);
const threads = structuredClone(THREADS);
const threadMessages = structuredClone(THREAD_MESSAGES);
const taskState = structuredClone(TASKS);
const handoffs = structuredClone(HANDOFFS);
// Follow-up cards: approve, skip and the deal answer stick, and an approval files its tasks onto
// the Tasks fixture, so the Tasks page and the account's Tasks tab show them afterwards.
const followUps = structuredClone(FOLLOW_UPS);
// Drafts waiting on approval (GET-681): approve and reject stick, so a decided draft leaves the list.
const pendingDrafts = structuredClone(PENDING_DRAFTS);
const FU_STATUSES = ["ready", "approved", "synced", "skipped", "merged"];
const LEGACY_RECS = HOME.recommendations.filter((r) => !r.id.startsWith("fu:"));
/** GET /api/home/recommendations/:id as the live route answers it, per kind: a handoff carries
 *  its written brief, a meeting brief is "ready to prepare", the rest are follow-ups to draft. */
function recDetail(r) {
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
  const name = r.account?.name ?? "this account";
  const base = { ...r, status: "open", decided_at: null, why_now: r.why, person_name: r.person ?? null, auto_draft: false };
  if (r.kind === "handoff") {
    return { ...base, impact: null, sources: [], move: `Read the handoff brief on ${name} before you take the account over.`, ready: "document",
      brief: { document_id: r.document_id, written_at: r.created_at, sections: [
        { label: "Summary", body: `${name} signed a 12-month contract after a three-week pilot. The champion is the head of operations; finance signed off on the annual plan.` },
        { label: "What was promised", body: "- Onboarding call in week one with the ops team\n- CRM sync live before the first monthly review\n- A named contact for support questions" },
        { label: "Risks", body: "- The IT lead was not on the final calls and may slow the SSO setup" },
      ] } };
  }
  const sources = [
    { kind: "meeting_held", when: ago(12), system: "fathom", title: `${name} weekly sync`, ref: null },
    { kind: "email_received", when: ago(19), system: "gmail", title: "Re: pricing sheet", ref: null },
  ];
  const impact = { deal: `${name} · Platform`, value: 48000, stage: "Evaluation", close_date: new Date(Date.now() + 20 * 864e5).toISOString() };
  if (r.kind === "meeting_brief") return { ...base, impact, sources, move: `Read the brief on ${name} before the meeting.`, ready: "brief" };
  return { ...base, auto_draft: true, impact, sources, move: `Send ${r.person ?? name} a short follow-up that picks up where you left off.`, ready: "draft_email" };
}
const viewer = USERS.find((u) => u.name === PREVIEW_VIEWER);
let nextPersonId = 100;

/** An approved task as GET /api/tasks returns it (the shape the action_item claim reads as). */
function followUpTask(f, t, sent, now) {
  const last = f.meetings[f.meetings.length - 1] ?? null;
  const due = typeof sent.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sent.due) ? sent.due : t.due ?? null;
  return {
    id: `${f.account.id}:action_item.followup_${f.id}_${t.id}`, entity_id: f.account.id,
    title: String(sent.text ?? "").trim() || t.text,
    owner_kind: "user", owner_name: viewer?.name ?? null, owner_email: viewer?.email ?? null, status: "open",
    due_at: due, due_phrase: due === (t.due ?? null) ? t.due_phrase ?? null : null,
    source_type: "follow_up", source_id: f.id, source_title: last?.title ?? null, occurred_at: last?.at ?? null,
    recorded_at: now, completed_at: null, completed_reason: null, completed_by: null,
    account: f.account.name, company: f.account.name, company_id: f.account.id, internal: false, kind: "general",
    quote: t.quote ?? null, stated_by: t.stated_by ?? null, deal_id: f.deal_id, deal_link: f.deal_id ? "filed" : null,
    actions: [], assignee: viewer ? { id: viewer.id, name: viewer.name, avatar: null } : null, owner_is_member: true,
  };
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
});

// ── Chat stream: SSE-shaped frames over a plain fetch body ───────────────────
async function chatStream(req, res) {
  const body = await readBody(req);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const now = new Date().toISOString();
  const msg = String(body.message ?? "");
  // Mirror the live API: the first message names the thread.
  const th = threads.find(t => t.id === body.threadId);
  if (th && th.title === "New chat" && msg) th.title = msg.slice(0, 80);
  send({ type: "user_message", message: { id: `mu_${Date.now()}`, role: "user", content: msg, created_at: now, tool_calls: null } });

  const reply = [
    "**Preview mode** — the live agent isn't connected on this machine, so this is a canned reply from the fixture world.\n\n",
    "What I can tell you from the record: **Meridian Analytics** is the account most at risk (health 38, security review gating the pilot, questionnaire 2 days overdue), ",
    "**Redwood Insurance** has been quiet 26 days mid-review, and **Nina Rossi at Vantage Legal** fired a buying signal this week.\n\n",
    "With real credentials this thread runs the actual agent against your live graph.",
  ];
  send({ type: "tool_start", name: "get_context" });
  await new Promise(r => setTimeout(r, 350));
  send({ type: "tool_end", name: "get_context", status: "ok", duration_ms: 350, rows: 12, sources: [{ system: "Nous", detail: "preview fixtures", when: now, derived: true }] });
  let acc = "";
  for (const chunk of reply) {
    acc += chunk;
    send({ type: "text", text: chunk });
    await new Promise(r => setTimeout(r, 120));
  }
  // Follow-ups ride on the finished row, as the live API sends them (GET-649).
  const suggestions = body.followUps === true ? ["Brief me on Meridian Analytics", "Draft a check-in to Redwood Insurance"] : null;
  send({ type: "done", assistantMessage: { id: `ma_${Date.now()}`, role: "assistant", content: acc, suggestions, created_at: new Date().toISOString(), tool_calls: [{ name: "get_context", status: "ok", duration_ms: 350, rows: 12, sources: [{ system: "Nous", detail: "preview fixtures", when: now, derived: true }] }] } });
  res.end();
}

// ── API plan (PREVIEW_PLAN=api) ──────────────────────────────────────────────
// The fixture world is a Workspace-plan team. `PREVIEW_PLAN=api node preview/server.mjs` serves
// the same world as an API-plan team instead, with the few payloads only that plan's pages read
// (the plan, the onboarding checklist; credits live in api-plan-p4.mjs, API keys in
// api-plan-p2.mjs), so the API-plan pages can be looked at. Off by default, so the visual
// baselines never see it. Earlier entries win, so each path is mocked in exactly one place.
const API_PLAN = process.env.PREVIEW_PLAN === "api";
const apiPlanRoutes = !API_PLAN ? [] : [
  ...(await import("./fixtures/api-plan-p3.mjs")).apiPlanP3Routes, // Integrations pages (GET-631, GET-638)
  ...(await import("./fixtures/api-plan-p5.mjs")).routes,
  ["GET", /^\/api\/usage$/, () => ({ ...USAGE, plan: "api", planName: "API" })],
  ["GET", /^\/api\/onboarding\/checklist$/, () => ({
    crm: { done: true, provider: "hubspot", imported: true, accounts: 12 },
    mail: { done: true, providers: ["gmail"] }, notes: { done: true, providers: ["fireflies"] },
    backfill: { state: "done", started: true }, plan: { live: true }, seat: "founder",
    api_key: { created: true, used: false },
  })],
];

// The API plan's page data on the Workspace plan (GET-660): `PREVIEW_DATA=api` serves the keys,
// integrations, webhooks, usage and activity payloads above without switching the plan, so the
// pages both plans now share can be looked at with data on the Workspace plan too. Billing state
// stays the Workspace one (the Custom contract). Off by default, so the baselines never see it.
const API_DATA = !API_PLAN && process.env.PREVIEW_DATA === "api";
const apiDataRoutes = !API_DATA ? [] : [
  // The Custom contract as GET /api/billing/state sends it for a quoted account: the quote's
  // basics and its custom block (customPlans.mjs), no allowance, and credits used this period.
  ["GET", /^\/api\/billing\/state$/, () => ({
    ...BILLING_STATE, plan: "custom", planName: "Headless",
    customPlan: { priceUsd: null, credits: null, customLabel: "Custom integrations",
      basics: ["Unified accounts", "Automated insights and reporting", "Task and workflow automation"],
      custom: ["HubSpot two-way sync", "Phone system call recordings"] },
    aiCredits: { used: 312, included: null, remaining: null, percentUsed: 0, state: "ok", needsPlan: false, notLiveReason: null, unlimited: true },
    stripe: { customer: false, subscription: false },
  })],
  ...(await import("./fixtures/api-plan-p2.mjs")).routes,
  ...(await import("./fixtures/api-plan-p4.mjs")).apiPlanP4Routes.filter(([, re]) => String(re) !== String(/^\/api\/billing\/state$/)),
  ...(await import("./fixtures/api-plan-p3.mjs")).apiPlanP3Routes,
  ...(await import("./fixtures/api-plan-p1.mjs")).routes,
];

// ── Route table ──────────────────────────────────────────────────────────────
// [method, regex, handler(match, query, req, res)]
const routes = [
  ...(API_PLAN ? (await import("./fixtures/api-plan-p2.mjs")).routes : []),
  ...(API_PLAN ? (await import("./fixtures/api-plan-p4.mjs")).apiPlanP4Routes : []),
  ...apiPlanRoutes,
  ...(API_PLAN ? (await import("./fixtures/api-plan-p1.mjs")).routes : []),
  ...apiDataRoutes,
  ["GET", /^\/me$/, () => ME],
  ["GET", /^\/api\/me$/, () => ME],
  ["GET", /^\/api\/onboarding\/status$/, () => ONBOARDING_STATUS],
  ["POST", /^\/api\/onboarding\/tour-seen$/, () => ({ ok: true })],
  // Which CRM is connected (GET-602): the app names it everywhere ("View in HubSpot").
  ["GET", /^\/api\/onboarding\/checklist$/, () => ({ crm: { done: true, provider: "hubspot", imported: true, accounts: 20 } })],
  // Forecast (GET-842): the open deals carried as a weighted forecast, the shape POST /v2/forecast
  // returns, plus a few weeks of snapshots so the accuracy panel has rows.
  ["POST", /^\/v2\/forecast$/, async (_m, _q, req) => {
    const { period = "month" } = (await readBody(req)) ?? {};
    const open = DEALS.filter((d) => d.status === "open" && d.value);
    const deals = open.map((d) => {
      const pWin = Math.round((d.health_score ?? 50) * 0.8) / 100;
      const pClose = period === "quarter" ? 0.85 : 0.45;
      return { entityId: d.company_id, name: d.name, amount: d.value, stage: d.stage, pWinBase: pWin, pWin, pCloseBase: pClose, pClose, contribution: Math.round(d.value * pWin * pClose) };
    }).sort((a, b) => b.contribution - a.contribution);
    const expected = deals.reduce((s, d) => s + d.contribution, 0);
    const end = new Date(); end.setMonth(end.getMonth() + (period === "quarter" ? 3 : 1), 0);
    return {
      period: { start: new Date().toISOString(), end: end.toISOString(), label: period === "quarter" ? "This quarter" : "This month", days_remaining: Math.ceil((end - Date.now()) / 86400000) },
      expected, bands: { p10: Math.round(expected * 0.6), p50: expected, p90: Math.round(expected * 1.45) },
      dealCount: deals.length, openPipeline: open.reduce((s, d) => s + d.value, 0), basis: "blended", deals,
      win_model: { basis: "fitted", applied: true }, intent_coverage: { with_band: 12, accounts: 20 },
    };
  }],
  ["GET", /^\/v2\/forecast\/snapshots$/, () => ({ snapshots: [4, 3, 2, 1].map((w, i) => ({
    id: `fs-${w}`, period_start: new Date(Date.now() - w * 7 * 86400000).toISOString(), period_end: new Date().toISOString(),
    taken_at: new Date(Date.now() - w * 7 * 86400000).toISOString(), expected: 88000 + i * 6000, p10: 52000 + i * 4000,
    p50: 88000 + i * 6000, p90: 128000 + i * 7000, open_pipeline: 310000 - i * 9000, basis: "blended" })) })],
  ["GET", /^\/api\/usage$/, () => USAGE],
  ["GET", /^\/api\/usage\/ops-breakdown$/, () => OPS_BREAKDOWN],
  ["GET", /^\/api\/billing\/state$/, () => BILLING_STATE],
  ["GET", /^\/api\/workspaces$/, () => ({ workspaces: [{ id: WS, name: "Nous", icon: null }] })],
  ["GET", /^\/api\/teams\/[^/]+\/members$/, () => ({ members: USERS.map(u => ({ user_id: u.id, name: u.name, email: u.email, role: u.role, avatar: null })) })],
  ["GET", /^\/api\/teams\/[^/]+\/invitations$/, () => ({ invitations: [] })],
  // Invites (GET-600): the first address gets an email, others return a link, so both result
  // rows show; an example.com address is refused the way the real route refuses a bad one.
  ["POST", /^\/api\/teams\/[^/]+\/invitations$/, async (_m, _q, req) => {
    const body = await readBody(req);
    const email = String(body?.email ?? "");
    if (email.endsWith("@example.com")) return { __status: 400, error: "That address can't be invited." };
    return email.startsWith("maya") ? { emailSent: true } : { emailSent: false, inviteLink: `https://app.opennous.cloud/accept-invitation?token=preview-${email.split("@")[0]}` };
  }],
  ["GET", /^\/api\/me\/agent-profile$/, () => ({ job_role: "founder", agent_instructions: "", job_roles: ["founder", "sales", "sdr", "revops"] })],
  ["PATCH", /^\/api\/me\/agent-profile$/, () => ({ ok: true })],
  ["GET", /^\/api\/me\/notification-prefs$/, () => ({ notification_prefs: null })],
  ["PATCH", /^\/api\/me\/notification-prefs$/, () => ({ ok: true })],

  ["GET", /^\/api\/contacts$/, (_m, q) => {
    let rows = CONTACTS;
    const needle = (q.get("search") ?? "").trim().toLowerCase();
    if (needle) rows = rows.filter(c =>
      `${c.first_name} ${c.last_name}`.toLowerCase().includes(needle) ||
      (c.email ?? "").toLowerCase().includes(needle) ||
      (c.company ?? "").toLowerCase().includes(needle));
    const limit = Math.min(parseInt(q.get("limit") ?? "50", 10) || 50, 2000);
    return { contacts: rows.slice(0, limit).map(c => ({ ...c, in_crm: !NOT_IN_CRM.has(c.id) })), limit, offset: 0, crm_connected: true };
  }],
  ["GET", /^\/api\/contacts\/counts$/, () => ({ active: CONTACTS.length, total: CONTACTS.length })],
  ["GET", /^\/api\/contacts\/enrich-active$/, () => ({ jobs: [] })],
  ["GET", /^\/api\/contacts\/(p\d+)$/, (m) => personRecord(m[1]) ?? { error: "not_found" }],
  ["PATCH", /^\/api\/contacts\/[^/]+$/, () => ({ ok: true })],
  ["POST", /^\/api\/contacts\/[^/]+\/(mark-lost|mark-client|personal|enrich)$/, () => ({ ok: true })],
  ["POST", /^\/api\/contacts\/bulk-(delete|personal|internal|client)$/, () => ({ ok: true })],
  // Org chart "Add person" — append to the shared world array so the detail
  // re-fetch (onRefresh) shows the new stakeholder immediately.
  ["POST", /^\/api\/contacts$/, async (_m, _q, req) => {
    const b = await readBody(req);
    if (!b.email) return { error: "invalid_email_format" };
    const co = COMPANIES.find(x => x.id === b.company_id) ?? null;
    const contact = {
      id: `p${nextPersonId++}`, workspace_id: WS,
      first_name: b.firstName ?? b.first_name ?? "New", last_name: b.lastName ?? b.last_name ?? "",
      email: b.email, job_title: b.jobTitle ?? null, seniority: null, department: null,
      company: co?.name ?? b.company ?? null, company_id: b.company_id ?? null, domain: co?.domain ?? null,
      linkedin_url: null, pipeline_stage: "identified", source: "manual", status: "active", lead_source: null,
      phone: null, city: null, country: null, photo_url: null,
      created_at: new Date().toISOString(), first_seen_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      deal_stage: null, deal_value: null, deal_health_score: null, memory_summary: null, notes: null,
      enrichment_status: null, interaction_count: 0, is_internal: false, is_personal: false,
      owner_user_id: null, owner_name: null, owner_members: [],
      icp_score: null, intent_score: 0, intent_band: "Dormant", reply_signal: null, reply_at: null,
      last_activity_at: null,
    };
    CONTACTS.push(contact);
    return { contact };
  }],
  ["DELETE", /^\/api\/contacts\/[^/]+$/, () => ({ ok: true })],

  // scope=mine|team: the redesign's My book / Team toggle. The preview viewer (Avery) is a CRM
  // owner, so "mine" always has rows; the CS page scopes by the CS owner, never the AE.
  ["GET", /^\/api\/companies\/list$/, (_m, q) => companiesList(readScope(q.get("scope")))],
  ["GET", /^\/api\/companies\/deals$/, (_m, q) => dealsPayload(readScope(q.get("scope")), q.get("status") ?? "all")],
  ["GET", /^\/api\/crm-pipelines$/, () => crmPipelines()],
  // The CRM sync's config, for the Pipeline's "Synced 12m ago" (GET-604).
  ["GET", /^\/api\/crm\/sync-config$/, (_m, q) => ({ config: { provider: q.get("provider") ?? "hubspot", last_synced_at: new Date(Date.now() - 12 * 60_000).toISOString() } })],
  ["GET", /^\/api\/workspaces\/[^/]+\/stages$/, (_m, q) => stagesFor((q.get("pipelineId") ?? "").trim() || null)],
  ["GET", /^\/api\/customer-success\/accounts$/, (_m, q) => csPayload(readScope(q.get("scope")))],
  ["POST", /^\/api\/customer-success\/dismiss$/, () => ({ ok: true })],
  ["GET", /^\/api\/lifecycle\/handoffs$/, () => ({ handoffs, unacknowledged: handoffs.filter((h) => !h.acknowledged_at).length })],
  ["PATCH", /^\/api\/lifecycle\/handoffs\/([^/]+)$/, (m) => {
    const h = handoffs.find((x) => x.id === m[1]);
    if (h) h.acknowledged_at = new Date().toISOString();
    return { ok: true };
  }],
  // One account's deals and tasks (the account page's Overview, Deals and Tasks tabs), in the
  // real routes' shapes: listAccountDeals and GET /api/tasks/account/:id.
  ["GET", /^\/api\/companies\/([^/]+)\/deals$/, (m) => ({
    implied: false, primary_pipeline_ref: null,
    deals: DEALS.filter((d) => d.company_id === m[1]).map((d) => ({
      id: d.id, implied: false, name: d.name, stage: d.stage, status: d.status, value: d.value,
      close_date: d.close_date, owner_email: null, roster: d.roster_people, roster_known: d.roster_known,
      roster_count: d.roster_count, last_stage_change_at: null, products: [], pipeline: d.pipeline,
      hubspot_url: followUpCrm(d.id)?.url ?? null,
      pipeline_id: d.pipeline_id, owners: d.owner_name ? [{ name: d.owner_name }] : [], days_in_stage: 12,
      health: { score: d.health_score, band: d.health_score == null ? null : d.health_score >= 70 ? "healthy" : d.health_score >= 50 ? "watch" : "at_risk" },
    })),
  })],
  // One deal for the deal page (GET-598, so the visual baselines show a real deal rather than a
  // loader): GET /api/companies/:id/deals/:dealId in getAccountDeal's shape. The stage history is
  // a plausible three-step ladder ending in the deal's current stage.
  // "How to win this deal" (GET-793): the worker writes it; here, a fixed paragraph per deal.
  ["POST", /^\/api\/companies\/([^/]+)\/deals\/([^/]+)\/overview$/, (m) => ({
    overview: `${COMPANIES.find((x) => x.id === m[1])?.name ?? "The account"} is in a pilot and the security review is the gate: the questionnaire has sat with their infosec team for two weeks. They want proof the rollout will not add work for the RevOps team, and the CFO has not been on a call yet. Send the completed questionnaire with the SOC 2 report this week, and ask Dana to bring the CFO to the pricing review.`,
    generated_at: new Date().toISOString(),
  })],
  // The intel timeline (GET-794/797): the account's facts on lanes, with one fact replaced.
  ["GET", /^\/api\/companies\/([^/]+)\/intel-timeline$/, (m) => {
    const LANES = [["buying", "Buying signals", ["buying_signal", "expansion_signal"]], ["blockers", "Blockers", ["blocker"]],
      ["objections", "Objections", ["objection"]], ["timeline", "Timeline & budget", ["timeline", "budget", "requirement"]],
      ["stakeholders", "Stakeholders", ["authority", "relationship"]], ["tech", "Tech stack", ["tech_stack"]], ["risks", "Risks", ["risk_signal"]]];
    const laneOf = (c) => LANES.find(([, , cats]) => cats.includes(c))?.[0] ?? null;
    const notes = (companyDetail(m[1])?.notes ?? []).filter((n) => laneOf(n.category));
    const facts = notes.map((n) => ({ id: n.id, category: n.category, lane: laneOf(n.category), label: n.label ?? null, content: n.content ?? "",
      said_at: n.created_at, live: true, superseded_by: null, supersedes: null, status: null, quote: n.metadata?.quote ?? null,
      speaker: null, voiced_by_contact_id: n.metadata?.voiced_by_contact_id ?? null, entity_id: m[1] }))
      .sort((a, b) => String(a.said_at).localeCompare(String(b.said_at)));
    const links = [];
    const obj = facts.filter((f) => f.lane === "objections");
    if (obj.length >= 2) { obj[0].live = false; obj[0].superseded_by = obj[1].id; obj[1].supersedes = obj[0].id; links.push({ from: obj[0].id, to: obj[1].id }); }
    const lanes = LANES.map(([key, label]) => ({ key, label, count: facts.filter((f) => f.lane === key).length }));
    return { days: null, since: null, lanes, facts, links };
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/deals\/([^/]+)$/, (m) => {
    const d = DEALS.find((x) => x.id === m[2] && x.company_id === m[1]);
    if (!d) return { error: "not_found" };
    const co = COMPANIES.find((x) => x.id === m[1]);
    const detail = companyDetail(m[1]);
    const day = 86_400_000;
    const at = (daysAgo) => new Date(Date.now() - daysAgo * day).toISOString();
    const band = d.health_score == null ? null : d.health_score >= 70 ? "healthy" : d.health_score >= 50 ? "watch" : "at_risk";
    return {
      deal: {
        id: d.id, implied: false, name: d.name, stage: d.stage, status: d.status, value: d.value, currency: "USD",
        close_date: d.close_date, opened_date: at(64).slice(0, 10), owner_name: d.owner_name, owner_email: null,
        pipeline: d.pipeline, pipeline_id: d.pipeline_id, days_in_stage: 12, products: [],
        roster: d.roster_people, roster_known: d.roster_known, roster_count: d.roster_count,
        hubspot_url: followUpCrm(d.id)?.url ?? null,
      },
      account: { id: co.id, name: co.name, domain: co.domain },
      people: CONTACTS.filter((c) => c.company_id === m[1]).slice(0, 4).map((c) => ({
        id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email, title: c.job_title ?? null, photo_url: null, conversations: 2,
      })),
      stages: [
        { label: "Discovery", status: "open", entered_at: at(64), days: 17, current: false },
        { label: "Demo completed", status: "open", entered_at: at(47), days: 35, current: false },
        { label: d.stage, status: d.status, entered_at: at(12), days: 12, current: true },
      ],
      // HubSpot line items as the sync stores them (string-valued properties), so the deal's
      // Products section has something real to total.
      line_items: d.id === "dl-01" ? [
        { name: "Platform licence", quantity: "1", price: "36000", amount: "36000", hs_recurring_billing_period: "P12M", observed_at: at(20) },
        { name: "Onboarding", quantity: "1", price: "6000", amount: "6000", observed_at: at(20) },
      ] : [],
      activity: (detail?.activity ?? []).slice(0, 12),
      // The facts whose source conversation was filed to this deal in the CRM (GET-404).
      notes: (detail?.notes ?? []).map((n) => ({ ...n, filed_to_deal: d.id === "dl-01" && ["n_obj1", "n_obj1b", "n_obj2", "n_buy1", "n_tl1"].includes(n.id) })),
      intel_topics: detail?.intel_topics ?? [],
      // The account's signal set where the fixture has one (Meridian), scored with this deal.
      health: {
        smart: [], numeric: [], history: [],
        ...(detail?.deal_health ?? {}),
        score: d.health_score, band, reason: d.health_reason,
      },
      attributed_count: 0,
      primary_pipeline_ref: null,
    };
  }],
  // Automations (GET-598: its baseline was a loader). The routes' shapes with nothing built
  // yet, so the page shows its templates; the connected tools let the template cards resolve.
  // GET-616: a few of the workspace's own, so the list, its last-run states and History draw.
  ["GET", /^\/api\/automations$/, () => ({ plan: "Custom", limit: null, used: PREVIEW_AUTOMATIONS.length, automations: PREVIEW_AUTOMATIONS, catalogue: [], destinations: [], triggers: [] })],
  ["GET", /^\/api\/automations\/runs$/, (_m, q) => previewAutomationRuns(q)],
  // GET-713: one step waiting on a person, so the Approvals tab has something to show.
  ["GET", /^\/api\/automations\/approvals$/, () => ({ approvals: [{
    run_id: "run-ap-1", requested_at: new Date(Date.now() - 12 * 60000).toISOString(),
    automation: { id: "au-follow-up", name: "Follow-up after every call", trigger: "call_ended" },
    account: { id: "c4", name: "Atlas Health", domain: "atlashealth.example" },
    why: "After the call: Q4 expansion scoping", step: "Step 3 · HubSpot · Create a task", type: "hubspot",
    rows: [{ label: "Tasks", value: "• Send the SOC 2 report to Grace\n• Book the pilot kickoff for the Boston team\n• Share pricing for the Forecasting add-on" }],
    // The review's shape since GET-726: each task on its own, the email it drafted, the summary.
    source: "fireflies", call_to: "grace@atlashealth.example",
    items: [{ index: 2, step: "Step 3 · HubSpot · Create a task", type: "hubspot", action: "task", rows: [], due_days: 1, tasks: [
      { key: 0, title: "Send the SOC 2 report to Grace", due_at: null },
      { key: 1, title: "Book the pilot kickoff for the Boston team", due_at: "2026-10-09T00:00:00Z" },
      { key: 2, title: "Share pricing for the Forecasting add-on", due_at: null },
    ] }],
    earlier: [
      { step: 1, name: "OpenNous · Call summary", detail: "Wrote it", output: { kind: "brief", id: "d-ap-1", title: "Atlas Health call", headline: "Atlas wants Forecasting for the Boston team before Q4 planning.", text: "", parts: [{ label: "What happened", body: "Grace walked through the Boston rollout. Security review is the last gate; she needs the SOC 2 report this week." }] } },
      { step: 2, name: "OpenNous · Draft follow-up", detail: "Wrote the email · Draft in Gmail", mail: { kind: "draft", mailbox: "avery@opennous.example", to: "grace@atlashealth.example", cc: null }, output: { kind: "email", id: "d-ap-2", title: null, subject: "SOC 2 and the Boston pilot", body: "Hi Grace,\n\nThanks for today. The SOC 2 report is attached, and I'll send times for the Boston kickoff tomorrow.\n\nAvery" } },
    ],
  }] })],
  ["POST", /^\/api\/automations\/approvals\/[^/]+\/(approve|reject)$/, () => ({ ok: true, status: "ok" })],
  // The From picker on every draft (GET-745): your own Gmail accounts.
  ["GET", /^\/api\/actions\/mailboxes$/, () => ({ mailboxes: [
    { id: "mb-1", kind: "gmail", email: "avery@opennous.example" },
    { id: "mb-2", kind: "gmail", email: "test.user.0001@gmail.com" },
  ], default_id: "mb-1" })],
  // The simple editor's email preview (GET-664), by the live route's shape: the email a run
  // would send for a recent trigger, notice + PDF or the AI's words, as the step says.
  ["POST", /^\/api\/automations\/email-preview$/, async (_m, _q, req) => previewEmail(await readBody(req))],
  ["GET", /^\/api\/automations\/tools$/, () => ({
    meeting: [{ slug: "fireflies", label: "Fireflies" }], crm: [{ slug: "hubspot", label: "HubSpot" }], models: [],
    connected: ["fireflies", "hubspot", "gmail", "slack"],
  })],
  ["GET", /^\/api\/tasks\/account\/([^/]+)$/, (m) => {
    const ofAccount = (t) => t.entity_id === m[1] || CONTACTS.find((c) => c.id === t.entity_id)?.company_id === m[1];
    const commitments = (taskState.commitments ?? []).filter(ofAccount).map((t) => ({ ...t, filed_to_deal: false }));
    const completed = (taskState.completed ?? []).filter(ofAccount).map((t) => ({ ...t, filed_to_deal: false }));
    return { commitments, completed, auto_closed: [], counts: { commitments: commitments.length, completed: completed.length, filed_to_deal: 0 } };
  }],
  // The raw behind a citation (POST /api/evidence/source, GET-612): Meridian's two calls as
  // transcripts and its pricing thread as an email, so a record's source chips open something real.
  ["POST", /^\/api\/evidence\/source$/, async (_m, _q, req) => {
    const { ref } = await readBody(req);
    const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
    if (ref === "source://fireflies/mtg-meridian-security") return { kind: "transcript", title: "Meridian security review", system: "fireflies", date: day(17), content: [
      "Avery Castellan: Thanks for making the time. Where does the pilot stand on your side?",
      "Dana Whitfield: Honestly, the blocker is infosec.",
      "Dana Whitfield: Our infosec team has to clear any tool that touches customer email before we can pilot it",
      "Avery Castellan: Understood. What do they need from us?",
      "Dana Whitfield: The questionnaire, your sub-processor list, and where the data is hosted.",
      "Avery Castellan: I'll send the pack this week and loop in our solutions engineer.",
    ].join("\n") };
    if (ref === "source://fireflies/mtg-meridian-discovery") return { kind: "transcript", title: "Meridian discovery call", system: "fireflies", date: day(21), content: [
      "Avery Castellan: How do forecast calls run today?",
      "Nate Holloway: Clari owns the forecast call today",
      "Dana Whitfield: We're four weeks into a Gong pilot on the enterprise team",
      "Nate Holloway: The per-seat price is hard to justify while we're paying for Gong too",
      "Meera Raman: There's an efficiency budget this half that this could come out of",
      "Meera Raman: I want one forecast number I actually trust",
      "Dana Whitfield: We want a decision before the September board meeting",
    ].join("\n") };
    if (ref === "source://gmail/thr-meridian-pricing") return { kind: "email", title: "Re: Pricing for Meridian", system: "gmail", date: day(2), who: "Meera Raman", content: "Hi Avery,\n\nCan you send annual pricing with onboarding broken out? These reviews normally take us about two weeks, so the sooner the better.\n\nMeera" };
    return { __status: 404, error: "no_content", message: "We have the pointer to this source but not its contents." };
  }],
  // The second-oldest objection replaces the oldest, as the intel-timeline fixture draws it, so the
  // Intel view has a "Changed" topic with its "was → now" (GET-799).
  ["GET", /^\/api\/companies\/([^/]+)\/detail$/, (m) => {
    const d = companyDetail(m[1]);
    if (!d) return { error: "not_found" };
    const obj = (d.notes ?? []).filter((n) => n.category === "objection").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (obj.length >= 2) obj[1].metadata = { ...(obj[1].metadata ?? {}), supersedes: obj[0].id };
    return d;
  }],
  ["GET", /^\/api\/companies\/([^/]+)\/account-health$/, (m) => accountHealthFor(m[1])],
  ["PATCH", /^\/api\/companies\/[^/]+$/, () => ({ ok: true })],
  ["PUT", /^\/api\/companies\/[^/]+\/reports-to$/, () => ({ ok: true })],
  ["POST", /^\/api\/companies\/[^/]+\/mark-client$/, () => ({ ok: true })],
  ["DELETE", /^\/api\/companies\/[^/]+$/, () => ({ ok: true })],

  ["GET", /^\/api\/tasks$/, () => tasksPayload(taskState)],
  ["PATCH", /^\/api\/tasks\/([^/]+)\/([^/]+)$/, async (m, _q, req) => {
    const body = await readBody(req);
    return { ok: true, status: body.status ?? "done" };
  }],
  // Tasks made and moved by hand (routes/api/tasks.mjs, Phase 3.7): new, snoozed, bulk-closed.
  ["POST", /^\/api\/tasks$/, async (_m, _q, req) => previewCreateTask(await readBody(req))],
  ["POST", /^\/api\/tasks\/bulk$/, async (_m, _q, req) => previewBulkTasks(await readBody(req))],
  ["PATCH", /^\/api\/tasks\/([^/]+)\/([^/]+)\/due$/, async (m, _q, req) => previewSnooze(`${m[1]}:${decodeURIComponent(m[2])}`, await readBody(req))],
  // An Insights topic's owner and "Close the loop" (routes/api/insights.mjs).
  ["GET", /^\/api\/insights\/topic-states$/, () => ({ ready: true, owner_ready: true, states: [...topicStates.values()] })],
  ["PUT", /^\/api\/insights\/topic-state$/, async (_m, _q, req) => previewTopicState(await readBody(req))],
  ["POST", /^\/api\/insights\/topics\/([^/]+)\/close-loop$/, (m) => previewCloseLoop(decodeURIComponent(m[1]))],
  ["GET", /^\/api\/flags$/, () => ({ flags: flags.filter(f => f.status === "open") })],
  ["PATCH", /^\/api\/flags\/([^/]+)$/, async (m, _q, req) => {
    const body = await readBody(req);
    const f = flags.find(x => x.id === m[1]);
    if (!f) return { error: "not_found" };
    f.status = body.status ?? f.status;
    if (body.status === "snoozed") f.snoozed_until = body.snoozedUntil ?? null;
    return { flag: f };
  }],

  ["GET", /^\/api\/graph$/, () => GRAPH],
  ["GET", /^\/v2\/pipeline\/portfolio$/, () => PORTFOLIO],
  // The Reports page (routes/api/reportsOverview.mjs): `sections=` as the page asks, over the
  // session's live follow-up and task copies.
  ["GET", /^\/api\/reports\/overview$/, (_m, q) => reportsOverview(q.get("sections"), followUps, taskState)],
  ["GET", /^\/v2\/campaigns\/performance$/, () => CAMPAIGNS],

  ["GET", /^\/api\/mind\/substrate$/, () => SUBSTRATE],
  ["GET", /^\/api\/mind\/scorecard$/, () => SCORECARD],
  ["GET", /^\/api\/mind\/scorecard\/runs$/, () => SCORECARD_RUNS],
  ["GET", /^\/api\/mind\/context-changes$/, () => CONTEXT_CHANGES],
  ["GET", /^\/api\/mind\/account\/([^/]+)$/, (m) => icpRecord(m[1]) ?? { error: "not_found" }],
  ["PATCH", /^\/api\/mind\/scorecard\/signals\/[^/]+$/, () => ({ signal: SCORECARD.signals[0] })],
  ["DELETE", /^\/api\/mind\/scorecard\/signals\/[^/]+$/, () => ({ ok: true })],
  ["POST", /^\/api\/mind\/(scorecard\/seed|closed-deals)$/, () => ({ ok: true })],
  ["GET", /^\/api\/workspace\/memories$/, () => WORKSPACE_MEMORIES],
  ["GET", /^\/api\/workspace\/memories\/history$/, () => ({ history: [] })],
  ["POST", /^\/api\/workspace\/memories$/, () => ({ ok: true })],
  ["PATCH", /^\/api\/workspace\/memories\/[^/]+$/, () => ({ ok: true })],
  ["DELETE", /^\/api\/workspace\/memories\/[^/]+$/, () => ({ ok: true })],
  ["GET", /^\/api\/foundations$/, () => ({ foundations: [] })],

  ["GET", /^\/api\/playground\/threads$/, () => ({ threads })],
  ["GET", /^\/api\/playground\/threads\/([^/]+)\/messages$/, (m) => ({ messages: threadMessages[m[1]] ?? [] })],
  ["POST", /^\/api\/playground\/threads$/, () => {
    // Live API creates threads titled 'New chat' and retitles on first message —
    // Home.tsx only client-swaps a title that strictly equals 'New chat'.
    const t = { id: `th_${Date.now()}`, title: "New chat", updated_at: new Date().toISOString(), created_at: new Date().toISOString(), routine: null, unseen: false };
    threads.unshift(t);
    threadMessages[t.id] = [];
    return { thread: t };
  }],
  ["DELETE", /^\/api\/playground\/threads\/([^/]+)$/, (m) => {
    const i = threads.findIndex(t => t.id === m[1]);
    if (i >= 0) threads.splice(i, 1);
    return { ok: true };
  }],
  ["GET", /^\/api\/skills$/, () => SKILLS],
  // The composer's model levels (GET /api/models): the three the live route offers, Low by default.
  ["GET", /^\/api\/models$/, () => ({
    default: "low",
    models: [
      { key: "low", label: "Low", vendor: "Z.ai", modelLabel: "GLM 5.2" },
      { key: "medium", label: "Medium", vendor: "Anthropic", modelLabel: "Sonnet 5" },
      { key: "high", label: "High", vendor: "Anthropic", modelLabel: "Opus 4.8" },
    ],
  })],
  // The composer's @ picker (GET-613): accounts and people whose name starts with what's typed.
  ["GET", /^\/api\/mentions$/, (_m, q) => {
    const t = String(q.get("q") ?? "").trim().toLowerCase();
    const hit = (name) => !t || name.toLowerCase().split(/\s+/).some(w => w.startsWith(t)) || name.toLowerCase().startsWith(t);
    const companies = COMPANIES.filter(c => hit(c.name)).map(c => ({ id: c.id, kind: "company", label: c.name, detail: c.domain }));
    const people = CONTACTS.filter(p => hit(`${p.first_name} ${p.last_name}`)).map(p => ({ id: p.id, kind: "person", label: `${p.first_name} ${p.last_name}`, detail: p.company }));
    return { results: [...companies, ...people].slice(0, 6) };
  }],
  // The chat fixture's draft (GET-613) by thread; Priorities' drafts (GET-681) for status=pending.
  ["GET", /^\/api\/actions$/, (_m, q) => ({
    actions: q.get("threadId") === "th1" ? TH1_PENDING_ACTIONS
      : !q.get("threadId") && q.get("status") === "pending" ? pendingDrafts.filter((a) => a.status === "pending") : [],
  })],
  ["GET", /^\/api\/agent-actions$/, (_m, q) => ({ actions: q.get("messageId") === "m2" ? TH1_AGENT_ACTIONS : [] })],
  ["POST", /^\/api\/feedback$/, () => ({ ok: true })],
  ["POST", /^\/api\/actions\/([^/]+)\/(approve|reject)$/, (m) => {
    const a = pendingDrafts.find((x) => x.id === m[1]);
    if (a) a.status = m[2] === "approve" ? "sent" : "rejected";
    return m[2] === "approve" ? { status: "sent", result: { id: `msg-${m[1]}` } } : { ok: true };
  }],

  ["GET", /^\/api\/notifications$/, (_m, q) => q.get("archived") === "true" ? { notifications: [], unreadCount: NOTIFICATIONS.unreadCount } : NOTIFICATIONS],
  ["PATCH", /^\/api\/notifications(\/[^/]+)?$/, () => ({ ok: true })],

  // Settings › Repo (GET-668): PREVIEW_REPO=1 serves a connected repo; otherwise nothing is connected.
  ["GET", /^\/api\/personal\/source$/, () => ({ source: process.env.PREVIEW_REPO === "1"
    ? { source_type: "github", connected: true, repo: "avery/opennous-evidence", branch: "main", base_path: "nous", last_synced_at: new Date(Date.now() - 4 * 60_000).toISOString(), auto_sync: true, sync_mode: "webhook" }
    : { source_type: "none", connected: false, repo: null, branch: null, base_path: null, last_synced_at: null } })],
  ["GET", /^\/api\/workspace\/system-log$/, () => SYSTEM_LOG],
  ["GET", /^\/api\/workspace\/system-log\/stats$/, () => SYSTEM_LOG_STATS],
  ["GET", /^\/api\/requests\/log$/, () => ({ requests: [] })],
  ["GET", /^\/api\/activity-stats$/, () => ACTIVITY_STATS],
  ["GET", /^\/api\/adoption$/, () => ADOPTION],
  ["GET", /^\/api\/insights\/themes$/, () => INSIGHT_THEMES],
  ["GET", /^\/api\/insights\/board$/, () => INSIGHT_BOARD],
  ["GET", /^\/api\/home$/, (_m, q) => homeFor(readScope(q.get("scope")), followUps)],
  // The follow-up cards (routes/api/followUps.mjs): the same filters, the same answers, the same
  // 409s for a card already decided.
  ["GET", /^\/api\/follow-ups$/, (_m, q) => {
    const scope = readScope(q.get("scope"));
    const asked = (q.get("status") ?? "").split(",").map((s) => s.trim()).filter((s) => FU_STATUSES.includes(s));
    const statuses = asked.length ? asked : ["ready", "approved", "synced", "skipped"];
    const account = q.get("accountId");
    const rows = followUps.filter((f) => statuses.includes(f.status) && (!account || f.account.id === account)).filter(followUpInScope(scope));
    return { follow_ups: rows, writeback: rows[0]?.writeback ?? followUps[0]?.writeback ?? false, ...(scope ? { scope, scope_unmapped: false } : {}) };
  }],
  // Write-back (routes/api/followUps.mjs POST /:id/sync): approves through the approve fixture
  // below, then answers as a sync that landed everything. Made-up HubSpot ids and a Gmail drafts
  // link; nothing leaves this process.
  ["POST", /^\/api\/follow-ups\/([^/]+)\/sync$/, async (m, q, req) => {
    const f = followUps.find((x) => x.id === m[1]);
    if (!f) return { error: "not_found" };
    if (!f.writeback) return { __status: 409, error: "writeback_off" };
    if (f.status === "merged") return { __status: 409, error: "merged", follow_up: f };
    if (f.status === "synced") return { follow_up: f, filed: 0, sync: f.verdict?.sync ?? null, failed: [], draft: null, complete: true };
    let filed = 0;
    if (f.status === "ready" || f.status === "skipped") {
      const approve = routes.find(([verb, re]) => verb === "POST" && String(re).includes("follow-ups") && String(re).includes("approve"));
      const out = await approve[2](m, q, req);
      if (out?.__status) return out;
      filed = out?.filed ?? 0;
    }
    const now = new Date().toISOString();
    const key = `action_item.followup_${f.id}_`;
    const taskIds = (taskState.commitments ?? []).filter((t) => t.source_id === f.id).map((t) => t.id.slice(t.id.indexOf(key) + key.length));
    const draft = f.email ? { url: "https://mail.google.com/mail/u/0/#drafts", mailbox: viewer?.email ?? null } : null;
    const sync = {
      tasks: Object.fromEntries(taskIds.map((id, i) => [id, String(61800000000 + i)])),
      note: f.verdict?.updates_ticked ? "62900000001" : null,
      draft, synced_at: now, locked_at: null,
    };
    Object.assign(f, { status: "synced", updated_at: now, verdict: { ...(f.verdict ?? {}), sync } });
    return { follow_up: f, filed, sync, failed: [], draft: draft ? { status: "created", ...draft } : null, complete: true };
  }],
  ["POST", /^\/api\/follow-ups\/([^/]+)\/approve$/, async (m, _q, req) => {
    const f = followUps.find((x) => x.id === m[1]);
    if (!f) return { error: "not_found" };
    if (f.status === "approved" || f.status === "synced") return { follow_up: f, filed: 0 };
    if (f.status === "merged") return { __status: 409, error: "merged", follow_up: f };
    if (f.attribution && !f.attribution.chosen) return { __status: 409, error: "attribution_required" };
    const b = await readBody(req);
    const byId = new Map(f.tasks.map((t) => [t.id, t]));
    const seen = new Set();
    const picked = (Array.isArray(b.tasks) ? b.tasks : []).map((x) => ({ x, t: byId.get(String(x?.id)) }))
      .filter(({ x, t }) => t && !t.existing && (!t.dropped || x.restored === true) && !seen.has(t.id) && seen.add(t.id));
    const now = new Date().toISOString();
    taskState.commitments = [...picked.map(({ x, t }) => followUpTask(f, t, x, now)), ...(taskState.commitments ?? [])];
    const sentEmail = b.email && f.email ? b.email : null;
    Object.assign(f, {
      status: "approved", decided_at: now, updated_at: now,
      verdict: {
        tasks_ticked: picked.length,
        tasks_edited: picked.filter(({ x, t }) => String(x.text ?? "").trim() !== t.text).length,
        updates_ticked: (Array.isArray(b.updates) ? b.updates : []).length,
        email_edited: !!sentEmail && (String(sentEmail.subject).trim() !== f.email.subject.trim() || String(sentEmail.body).trim() !== f.email.body.trim()),
      },
    });
    return { follow_up: f, filed: picked.length };
  }],
  ["POST", /^\/api\/follow-ups\/([^/]+)\/skip$/, (m) => {
    const f = followUps.find((x) => x.id === m[1]);
    if (!f) return { error: "not_found" };
    if (f.status === "skipped") return { follow_up: f };
    if (f.status !== "ready") return { __status: 409, error: f.status === "merged" ? "merged" : "already_decided", follow_up: f };
    const now = new Date().toISOString();
    Object.assign(f, { status: "skipped", decided_at: now, updated_at: now });
    return { follow_up: f };
  }],
  ["POST", /^\/api\/follow-ups\/([^/]+)\/attribution$/, async (m, _q, req) => {
    const f = followUps.find((x) => x.id === m[1]);
    if (!f) return { error: "not_found" };
    if (f.status !== "ready" && f.status !== "skipped") return { __status: 409, error: f.status === "merged" ? "merged" : "already_decided", follow_up: f };
    if (!f.attribution) return { __status: 400, error: "no_attribution_question" };
    const choice = String((await readBody(req)).choice ?? "");
    if (choice !== "both" && choice !== "neither" && !f.attribution.options.some((o) => o.id === choice)) return { __status: 400, error: "not_an_option" };
    const dealId = choice === "both" || choice === "neither" ? null : choice;
    const crm = dealId ? followUpCrm(dealId) : null;
    Object.assign(f, {
      attribution: { ...f.attribution, chosen: choice }, deal_id: dealId, crm, hubspot_url: crm?.url ?? null,
      updated_at: new Date().toISOString(),
    });
    return { follow_up: f };
  }],
  ["GET", /^\/api\/home\/settings$/, () => ({ settings: { kinds: { follow_up_quiet: true, meeting_brief: true, follow_up_call: true, reach_out: false }, auto_draft: true } })],
  ["PUT", /^\/api\/home\/settings$/, () => ({ settings: {} })],
  ["GET", /^\/api\/home\/members$/, () => ({ members: USERS.map((u) => ({ id: u.id, name: u.name, avatar: null })) })],
  // The older recommendations' pages only: an engine card ("fu:") has none.
  ["GET", /^\/api\/home\/recommendations\/[^/]+$/, (m) => ({ recommendation: recDetail(LEGACY_RECS.find((r) => m[0].endsWith(`/${r.id}`)) ?? LEGACY_RECS[0]) })],
  ["POST", /^\/api\/home\/recommendations\/[^/]+\/[a-z]+$/, () => ({ ok: true })],
  ["PATCH", /^\/api\/insights\/themes\/[^/]+$/, () => ({ ok: true })],
  ["GET", /^\/api\/routines$/, () => ({ routines: [] })],
  ["GET", /^\/api\/users\/me\/export$/, () => ({ ok: true })],
  ["PATCH", /^\/api\/(users\/me|workspaces\/[^/]+|teams\/[^/]+)$/, () => ({ ok: true })],

  // ── Personal workspace (the private vault) ──
  ["GET", /^\/api\/personal\/source$/, () => ({ source: { source_type: "none" } })],
  ["GET", /^\/api\/personal\/files$/, (m, q) => {
    const folder = q.get("folder");
    const files = personalFiles.filter(f => !folder || f.folder === folder)
      .map(({ content, ...rest }) => rest);
    return { folders: PERSONAL_FOLDERS, files };
  }],
  ["GET", /^\/api\/personal\/files\/([^/]+)$/, (m) => {
    const f = personalFiles.find(x => x.id === m[1]);
    return f ? { file: f } : { error: "not_found" };
  }],
  ["POST", /^\/api\/personal\/files$/, async (m, q, req) => {
    const b = await readBody(req);
    const f = { id: `pf_${personalFiles.length + 1}_${Date.now() % 10000}`, folder: b.folder, subfolder: b.subfolder ?? null, name: (b.name || "Untitled.md"), content: b.content ?? "", source: "human", status: "local_only", updated_at: new Date().toISOString() };
    personalFiles.unshift(f);
    return { file: f };
  }],
  ["PATCH", /^\/api\/personal\/files\/([^/]+)$/, async (m, q, req) => {
    const b = await readBody(req);
    const f = personalFiles.find(x => x.id === m[1]);
    if (!f) return { error: "not_found" };
    if (typeof b.name === "string") f.name = b.name;
    if (typeof b.content === "string") f.content = b.content;
    f.updated_at = new Date().toISOString();
    return { file: f };
  }],
  ["DELETE", /^\/api\/personal\/files\/([^/]+)$/, (m) => {
    const i = personalFiles.findIndex(x => x.id === m[1]);
    if (i >= 0) personalFiles.splice(i, 1);
    return { ok: true };
  }],
];

// ── Tasks made and moved by hand, topic owners, closing the loop (Phase 3.7) ──
// The real routes' shapes over the session's task copy. The board's accounts get stand-in ids
// (the live board sends `companyIds`), so a task made from a topic has an account to hang on.
INSIGHT_BOARD.companyIds = INSIGHT_BOARD.companies.map((_, i) => `ib${i}`);
const topicStates = new Map();
const closedLoops = new Set();
const PREVIEW_DAY = /^\d{4}-\d{2}-\d{2}$/;
const previewFace = (u) => (u ? { id: u.id, name: u.name, avatar: null } : null);

function previewAccount(entityId) {
  const co = COMPANIES.find((c) => c.id === entityId);
  if (co) return { company: co.name, company_id: co.id, company_domain: co.domain, account: null };
  const p = CONTACTS.find((c) => c.id === entityId);
  if (p) return { company: p.company, company_id: p.company_id, company_domain: p.domain, account: `${p.first_name} ${p.last_name}`.trim() };
  const ib = /^ib(\d+)$/.exec(entityId);
  if (ib) return { company: INSIGHT_BOARD.companies[Number(ib[1])] ?? null, company_id: entityId, company_domain: null, account: null };
  return null;
}

// GET /api/tasks as the live route fills it in (GET-607): the said-on-the-call phrase resolved to a
// day (resolveDuePhrase), the contact's company bound by id and domain, and the deal the
// conversation belongs to (the account's open deal) with its name. The stored fixture keeps its
// raw shape, so the account page and the reports read what they always did.
const PHRASE_DAYS = { tomorrow: 1, "in 2 days": 2, "by end of week": 5, Monday: 7, "next Tuesday": 7, "in a couple of weeks": 14, "end of month": 30 };
// Where a task was said, as the extractor stamps it (taskProvenance): Meridian's two promises came
// out of the security review, whose transcript POST /api/evidence/source serves.
const TASK_SOURCE = {
  "p1:action_item.t1": { source_ref: "source://fireflies/mtg-meridian-security", source_title: "Meridian security review", quote: "I'll send the pack this week and loop in our solutions engineer." },
  "p1:action_item.t2": { source_ref: "source://fireflies/mtg-meridian-security", source_title: "Meridian security review", quote: "I'll send the pack this week and loop in our solutions engineer." },
};
function tasksPayload(state) {
  const fill = (t) => {
    const contact = CONTACTS.find((c) => c.id === t.entity_id);
    const companyId = t.company_id ?? contact?.company_id ?? (COMPANIES.some((c) => c.id === t.entity_id) ? t.entity_id : null);
    const co = COMPANIES.find((c) => c.id === companyId);
    const n = PHRASE_DAYS[t.due_phrase ?? ""];
    const due = t.due_at ?? (n == null ? null : new Date(Date.parse(t.recorded_at) + n * 86_400_000).toISOString().slice(0, 10));
    const open = DEALS.filter((d) => d.company_id === companyId && d.status === "open").sort((a, b) => b.value - a.value);
    const deal = t.deal_id ? DEALS.find((d) => d.id === t.deal_id) : open[0];
    return {
      ...TASK_SOURCE[t.id], ...t, due_at: due, occurred_at: t.occurred_at ?? t.recorded_at,
      company: t.company ?? co?.name ?? null, company_id: companyId, company_domain: t.company_domain ?? co?.domain ?? null,
      deal_id: deal?.id ?? null, deal_name: deal?.name ?? null,
      deal_link: t.deal_link ?? (deal ? (open.length === 1 ? "only_open_deal" : "filed") : null),
    };
  };
  return { ...state, commitments: (state.commitments ?? []).map(fill), completed: (state.completed ?? []).map(fill) };
}

function previewTask({ entityId, property, title, due, source, owner, now }) {
  const acct = previewAccount(entityId);
  return {
    id: `${entityId}:${property}`, entity_id: entityId, title, owner_kind: "user",
    owner_name: owner?.name ?? null, owner_email: owner?.email ?? null, status: "open",
    due_at: due ?? null, due_phrase: null, source_type: source.kind, source_id: source.key ?? null,
    source_title: source.title ?? null, source_url: source.kind !== "manual" && source.key ? `/insights/${encodeURIComponent(source.key)}` : null,
    occurred_at: now, recorded_at: now, completed_at: null, completed_reason: null, completed_by: null,
    quote: null, stated_by: null, deal_id: null, deal_link: null, internal: false, kind: "general", actions: [],
    ...(acct ?? { company: null, company_id: null, company_domain: null, account: null }),
    assignee: owner?.id ? previewFace(owner) : owner ? { id: `person:${owner.email ?? owner.name}`, name: owner.name, avatar: null } : null,
    owner_is_member: !!owner?.id, owner_label: owner?.name ?? null,
  };
}

function previewCreateTask(b) {
  if (!String(b.title ?? "").trim()) return { __status: 400, error: "title_required" };
  if (!b.entityId) return { __status: 400, error: "entity_id_required" };
  if (!previewAccount(b.entityId)) return { __status: 404, error: "entity_not_found" };
  if (b.due_at && !PREVIEW_DAY.test(b.due_at)) return { __status: 400, error: "invalid_due_at" };
  const source = { kind: b.source?.kind ?? "manual", key: b.source?.key ?? null, title: b.source?.title ?? null };
  const property = `action_item.manual_${b.client_id ?? Date.now()}`;
  const existing = (taskState.commitments ?? []).find((t) => t.id === `${b.entityId}:${property}`);
  if (existing) return { task: existing, created: false, settled: true };
  const owner = b.owner_user_id ? USERS.find((u) => u.id === b.owner_user_id) : viewer;
  if (b.owner_user_id && !owner) return { __status: 400, error: "owner_not_a_member" };
  const task = previewTask({ entityId: b.entityId, property, title: String(b.title).trim(), due: b.due_at || null, source, owner, now: new Date().toISOString() });
  const deal = b.deal_id ? DEALS.find((d) => d.id === b.deal_id) : null;
  if (deal) Object.assign(task, { deal_id: deal.id, deal_name: deal.name, deal_link: "filed" });
  taskState.commitments = [task, ...(taskState.commitments ?? [])];
  return { __status: 201, task, created: true, settled: true };
}

function previewBulkTasks(b) {
  if (!["open", "done"].includes(b.status)) return { __status: 400, error: "invalid_status" };
  const ids = [...new Set(Array.isArray(b.ids) ? b.ids : [])];
  if (!ids.length) return { __status: 400, error: "ids_required" };
  if (ids.length > 200) return { __status: 400, error: "too_many_ids", max: 200 };
  const now = new Date().toISOString();
  taskState.commitments = taskState.commitments ?? [];
  taskState.completed = taskState.completed ?? [];
  const results = ids.map((id) => {
    const from = b.status === "done" ? taskState.commitments : taskState.completed;
    const i = from.findIndex((t) => t.id === id);
    if (i < 0) return { id, ok: false, error: "not_found" };
    const [t] = from.splice(i, 1);
    const next = b.status === "done"
      ? { ...t, status: "done", completed_at: now, completed_by: "user", completed_reason: "you marked it done" }
      : { ...t, status: "open", completed_at: null, completed_by: null, completed_reason: null, reopened_at: now };
    (b.status === "done" ? taskState.completed : taskState.commitments).unshift(next);
    return { id, ok: true, status: b.status };
  });
  const ok = results.filter((r) => r.ok).length;
  return { status: b.status, results, counts: { ok, failed: results.length - ok } };
}

function previewSnooze(id, b) {
  if (b.due_at === undefined) return { __status: 400, error: "due_at_required" };
  if (b.due_at !== null && b.due_at !== "" && !PREVIEW_DAY.test(b.due_at)) return { __status: 400, error: "invalid_due_at" };
  const t = [...(taskState.commitments ?? []), ...(taskState.completed ?? [])].find((x) => x.id === id);
  if (!t) return { error: "not_found" };
  Object.assign(t, { due_at: b.due_at || null, due_phrase: null });
  return { ok: true, id, due_at: t.due_at, due_phrase: null, settled: true };
}

function previewTopicState(b) {
  if (typeof b.key !== "string" || !b.key.includes("|")) return { __status: 400, error: "invalid_state" };
  if (b.owner_user_id && !USERS.some((u) => u.id === b.owner_user_id)) return { __status: 400, error: "owner_not_a_member" };
  const prev = topicStates.get(b.key) ?? { topic_key: b.key, status: "new", priority: null, notes: "", owner_user_id: null };
  const next = { ...prev, updated_at: new Date().toISOString(), editor: viewer?.name ?? null };
  for (const k of ["status", "priority", "notes", "owner_user_id"]) if (b[k] !== undefined) next[k] = b[k];
  next.owner_name = USERS.find((u) => u.id === next.owner_user_id)?.name ?? null;
  topicStates.set(b.key, next);
  return { state: next };
}

// Customers (the board's money says so) go to the CS owner, everyone else to the AE: Maya Chen and
// Jordan Reyes stand in, the way the CS fixtures name them.
function previewCloseLoop(key) {
  const st = topicStates.get(key);
  if ((st?.status ?? "new") !== "shipped") return { __status: 409, error: "not_shipped", status: st?.status ?? "new" };
  const [sub, tag] = key.split("|");
  const cos = [...new Set(INSIGHT_BOARD.items.filter((i) => i[5] === sub && (i[6] ?? "none") === tag && i[7] >= 0).map((i) => i[7]))];
  if (!cos.length) return { error: "not_found" };
  const topic = INSIGHT_BOARD.tags.find((t) => t.id === tag)?.name ?? null;
  const due = (() => { const d = new Date(); let n = 3; while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() % 6) n--; } return d.toISOString().slice(0, 10); })();
  const now = new Date().toISOString();
  const tasks = cos.map((co) => {
    const entityId = `ib${co}`;
    const account = INSIGHT_BOARD.companies[co];
    const customer = !!INSIGHT_BOARD.money?.[co]?.[0];
    const owner = customer ? { name: "Maya Chen", email: "maya@opennous.example" } : USERS.find((u) => u.id === "u2");
    const extKey = `close_loop:${key}:${entityId}`;
    const created = !closedLoops.has(extKey);
    const property = `action_item.manual_loop_${co}_${tag}`;
    if (created) {
      closedLoops.add(extKey);
      taskState.commitments = [previewTask({ entityId, property, title: topic ? `Tell ${account} the ${topic} fix is live` : `Tell ${account} the fix is live`, due, source: { kind: "close_loop", key, title: topic }, owner, now }), ...(taskState.commitments ?? [])];
    }
    return { id: `${entityId}:${property}`, account_id: entityId, account, owner_name: owner?.name ?? null, owner_role: customer ? "cs" : "ae", created };
  });
  const created = tasks.filter((t) => t.created).length;
  return { created, skipped_existing: tasks.length - created, due_at: due, settled: true, capped: false, tasks };
}

const PERSONAL_FOLDERS = ["inbox", "thoughts", "decisions", "projects", "briefs", "content"];
const personalFiles = [
  { id: "pf_seed_1", folder: "thoughts", subfolder: null, name: "Why agents need a context graph.md", content: "# Why agents need a context graph\n\nAccess is not context...", source: "human", status: "local_only", updated_at: new Date(Date.now() - 3600e3).toISOString() },
  { id: "pf_seed_2", folder: "briefs", subfolder: "meeting-briefs", name: "Pre-call — Meridian Analytics.md", content: "## Meridian Analytics\n\nSecurity review is the gate...", source: "agent", status: "inbox_pending", updated_at: new Date(Date.now() - 7200e3).toISOString() },
  { id: "pf_seed_3", folder: "decisions", subfolder: null, name: "Locked revenue-engineer niche.md", content: "Decision: niche = the Revenue Engineer.", source: "human", status: "local_only", updated_at: new Date(Date.now() - 86400e3).toISOString() },
  { id: "pf_seed_4", folder: "inbox", subfolder: null, name: "Proposed: re-engage cooled accounts.md", content: "Agent proposal awaiting approval.", source: "agent", status: "inbox_pending", updated_at: new Date(Date.now() - 1800e3).toISOString() },
];

const server = http.createServer(async (req, res) => {
  // CORS — the app is on :8080 and calls :3000 directly (VITE_API_URL).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-nous-client");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "POST" && path === "/api/playground/chat/stream") return chatStream(req, res);
  if (path === "/health") return json(res, { ok: true, preview: true });

  for (const [method, re, handler] of routes) {
    if (req.method !== method) continue;
    const m = path.match(re);
    if (!m) continue;
    const out = await handler(m, url.searchParams, req, res);
    let status = out && out.error === "not_found" ? 404 : 200;
    let body = out;
    // A handler that needs another status (the follow-ups' 409s) says so in `__status`.
    if (out && typeof out === "object" && "__status" in out) { const { __status, ...rest } = out; status = __status; body = rest; }
    return json(res, body, status);
  }

  console.warn(`[preview-api] no mock for ${req.method} ${path}`);
  return json(res, { error: "not_mocked", path }, 404);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[preview-api] port ${PORT} is already in use.`);
    console.error(`  If that's the REAL API, stop this server — the app talks to :${PORT} either way.`);
    console.error(`  If it's a stale preview server, kill it and rerun.`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => {
  console.log(`[preview-api] fixture world on http://localhost:${PORT} — ${COMPANIES.length} companies, ${CONTACTS.length} contacts, ${flags.length} flags`);
});


// ── Automations (GET-616) ─────────────────────────────────────────────────────
// The workspace's own automations and their runs, by the live routes' shapes
// (routes/api/automations.mjs). Times count back from the preview clock.
const agoIso = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
const PREVIEW_AUTOMATIONS = [
  { id: "au-follow-up", name: "Follow-up after every call", artifact: null, custom: true, prompt: null, when: "call_ended", destination: "none", destination_target: null,
    enabled: true, last_run_at: agoIso(120), tools: [], version: 3, draft: null,
    steps: [
      { id: "s1", type: "agent", config: { mode: "pick", job: "follow_up", extra: "", prompt: "", model: "opennous" } },
      { id: "s2", type: "approval", config: {} },
      { id: "s3", type: "gmail", config: { mode: "draft", to: "{{call.attendees}}" } },
    ] },
  { id: "au-brief", name: "Brief before every external meeting", artifact: null, custom: true, prompt: null, when: "before_meeting", destination: "none", destination_target: null,
    enabled: true, last_run_at: agoIso(40), tools: [], offset_minutes: 30, version: 1, draft: null,
    steps: [
      { id: "s1", type: "agent", config: { mode: "pick", job: "premeeting_brief", extra: "", prompt: "", model: "opennous" } },
      { id: "s2", type: "slack", config: { channel: "#sales", text: "{{steps.s1.output}}" } },
    ] },
  { id: "au-handoff", name: "Hand over won deals to CS", artifact: null, custom: true, prompt: null, when: "deal_closed_won", destination: "none", destination_target: null,
    enabled: true, last_run_at: agoIso(60 * 26), tools: ["hubspot"], version: 2, draft: null,
    steps: [
      { id: "s1", type: "agent", config: { mode: "pick", job: "deal_handoff", extra: "", prompt: "", model: "opennous" } },
      { id: "s2", type: "hubspot", config: { action: "note", body: "{{steps.s1.output}}" } },
    ] },
  { id: "au-digest", name: "Monday pipeline digest", artifact: null, custom: true, prompt: null, when: "clock", destination: "none", destination_target: null,
    enabled: true, last_run_at: agoIso(60 * 24 * 4 + 570), tools: [], frequency: "weekly", at_time: "08:00", version: 1, draft: null,
    steps: [
      { id: "s1", type: "agent", config: { mode: "write", job: null, extra: "", prompt: "Summarise what moved in the pipeline last week.", model: "opennous" } },
      { id: "s2", type: "email", config: { to: "avery@opennous.example", subject: "Pipeline digest", body: "{{steps.s1.output}}" } },
    ] },
  { id: "au-score", name: "Score every call", artifact: "call_score", custom: false, prompt: null, when: "call_ended", destination: "none", destination_target: null,
    enabled: false, last_run_at: null, tools: [], version: 1, draft: null },
];
// The email step's own subject or body with its variables filled for the sample, as the runner does.
function fillPreview(text, sample, ai) {
  const values = { "account.name": sample.name, "deal.close_date": "September 30, 2026", "deal.amount": "$48,000", "deal.owner": "Avery Castellan", "deal.name": `${sample.name} — Platform` };
  const out = String(text ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => (k.endsWith(".output") ? ai : values[k] ?? ""));
  return out.trim();
}

function previewEmail(body) {
  const steps = body?.steps ?? [];
  const mail = steps.find((s) => s.type === "email");
  const samples = [
    { entity_id: "c1", deal_id: "dl-01", name: "Meridian Health", at: agoIso(60 * 30) },
    { entity_id: "c2", deal_id: null, name: "Northwind Logistics", at: agoIso(60 * 24 * 3) },
  ];
  const sample = samples.find((x) => x.entity_id === body?.entity_id) ?? samples[0];
  if (!mail) return { samples, sample, email: null };
  const [to, ...cc] = [mail.config?.to, mail.config?.cc].join(",").split(",").map((x) => x.trim()).filter(Boolean);
  const inline = mail.config?.attach === "none";
  const ai = `${sample.name} signed a three-year agreement for 12 sites.\n\nWho is involved\nDana Ortiz, VP Operations, signed. Sam Lee runs the rollout.\n\nWhat we promised\nKickoff within two weeks; SSO before go-live.`;
  return {
    samples, sample, written: true, ai_text: ai,
    email: {
      to: to ?? null, cc, attach: !inline, filename: `${sample.name} Account Brief.pdf`,
      subject: fillPreview(mail.config?.subject, sample, ai) || `${sample.name} · September 30, 2026 · Closed Won`,
      text: fillPreview(mail.config?.body, sample, ai) || (inline ? ai : `${sample.name} closed won on September 30, 2026.\n\nWe created the account summary for you. You'll find it in the attached PDF, or you can read it in OpenNous: https://app.opennous.cloud/pages/preview`),
    },
  };
}

// Newest first. [automation, minutes ago, status, report title?]
const PREVIEW_RUN_ROWS = [
  ["au-brief", 40, "ok", "Brief: Meridian Analytics security review"],
  ["au-follow-up", 120, "ok", "Follow-up: Northwind Logistics"],
  ["au-brief", 60 * 5, "ok", "Brief: Beacon Financial renewal"],
  ["au-follow-up", 60 * 7, "ok", "Follow-up: Summit Manufacturing"],
  ["au-handoff", 60 * 26, "awaiting_approval", null],
  ["au-brief", 60 * 27, "ok", "Brief: Juniper Labs kickoff"],
  ["au-follow-up", 60 * 29, "ok", "Follow-up: Cobalt Systems"],
  ["au-follow-up", 60 * 50, "error", null],
  ["au-brief", 60 * 52, "ok", "Brief: Vantage Legal pricing call"],
  ["au-digest", 60 * 24 * 4 + 570, "error", null],
  ["au-follow-up", 60 * 24 * 5, "ok", "Follow-up: Halcyon Retail Group"],
  ["au-handoff", 60 * 24 * 6, "ok", "Handoff: Redwood Insurance"],
  ["au-brief", 60 * 24 * 6 + 200, "ok", "Brief: Orbital Media"],
  ["au-digest", 60 * 24 * 11 + 570, "ok", "Pipeline digest, week 39"],
  ["au-follow-up", 60 * 24 * 12, "ok", "Follow-up: Pinecrest Foods"],
  ["au-digest", 60 * 24 * 18 + 570, "ok", "Pipeline digest, week 38"],
];
function previewAutomationRuns(q) {
  const days = Number(q.get("days"));
  const routines = (q.get("routines") ?? "").split(",").filter(Boolean);
  const statuses = (q.get("status") ?? "").split(",").filter(Boolean);
  const inWindow = PREVIEW_RUN_ROWS.filter(([id, mins]) => (!(days > 0) || mins <= days * 1440) && (!routines.length || routines.includes(id)));
  const name = (id) => PREVIEW_AUTOMATIONS.find((a) => a.id === id);
  const runs = inWindow.filter(([, , st]) => !statuses.length || statuses.includes(st)).map(([id, mins, status, title], i) => ({
    id: `run-${id}-${i}`, routine_id: id, when: name(id)?.when ?? null, automation: name(id)?.name ?? "Deleted automation", artifact: null,
    status, started_at: agoIso(mins), error: status === "error" ? "The model timed out before it finished." : null,
    document_id: title ? `doc-${id}-${i}` : null, document_title: title, version: name(id)?.version ?? 1,
  }));
  return {
    stats: { days: days > 0 ? days : null, runs: inWindow.length, failed: inWindow.filter((r) => r[2] === "error").length, reports: inWindow.filter((r) => r[3]).length },
    runs,
  };
}
