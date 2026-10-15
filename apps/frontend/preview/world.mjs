// The preview world — one coherent GTM story served by every mock endpoint.
//
// Twelve companies, three team members (one manager, two reps), ~22 contacts,
// flags, commitments, campaigns, claim patterns. Every number on every page
// traces back to THIS file, so the Reporting tab, the account records, the
// board, and the radar all agree — exactly the property the real substrate has.
//
// Shapes mirror the real API responses field-for-field (see the recon notes in
// the repo history). If a page blanks in preview, the shape here drifted.
//
// The workspace redesign added eight customer accounts (c13-c20), a CRM deal book
// (DEALS, two pipelines), the Customer Success payload and handoffs, and the
// scope=mine|team contract. The preview viewer is Avery Castellan, who is a CRM owner
// here, so "My book" always has rows. Fields the live API sends as null today
// (deal health_score/health_reason, renewal_date, hubspot_url, meeting purpose)
// carry realistic values here so the design can be reviewed in every state.

import { dealVerdict, stalePipeline } from "../../api/src/lib/dealSignals.mjs";

const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const isoIn = (days) => new Date(Date.now() + days * DAY).toISOString();

export const WS = "ws-preview";

// ── Team ─────────────────────────────────────────────────────────────────────
export const USERS = [
  { id: "u1", name: "Avery Castellan", email: "avery@opennous.example", role: "admin" },
  { id: "u2", name: "Jordan Reyes", email: "jordan@opennous.example", role: "member" },
  { id: "u3", name: "Imogen Farrow", email: "imogen@opennous.example", role: "member" },
];
const owner = (id) => {
  const u = USERS.find(x => x.id === id);
  return u ? { user_id: u.id, name: u.name } : null;
};

// ── Companies ────────────────────────────────────────────────────────────────
// activity_count/meeting_count feed the board card footers.
export const COMPANIES = [
  { id: "c1", name: "Meridian Analytics", domain: "meridiananalytics.example", industry: "Analytics", location: "Austin, TX", revenue_range: "$10M-$50M", employee_count: 140, icp_score: 84, deal_health_score: 38, memory_summary: "Four-week Gong pilot running; security review is the gate.", activity_count: 48, meeting_count: 3 },
  { id: "c2", name: "Northwind Logistics", domain: "northwindlog.example", industry: "Logistics", location: "Chicago, IL", revenue_range: "$50M-$100M", employee_count: 420, icp_score: 75, deal_health_score: 76, memory_summary: "Ops-led evaluation; CS org brought Gong in first.", activity_count: 26, meeting_count: 2 },
  { id: "c3", name: "Cobalt Systems", domain: "cobaltsystems.example", industry: "DevTools", location: "Seattle, WA", revenue_range: "$10M-$50M", employee_count: 95, icp_score: 81, deal_health_score: 74, memory_summary: "CRO-sponsored; pilot kickoff scheduled.", activity_count: 39, meeting_count: 4 },
  { id: "c4", name: "Atlas Health", domain: "atlashealth.example", industry: "Healthcare", location: "Boston, MA", revenue_range: "$100M+", employee_count: 800, icp_score: 90, deal_health_score: 92, memory_summary: "Closed-won; onboarding complete, expansion talk in Q4.", activity_count: 74, meeting_count: 8 },
  { id: "c5", name: "Juniper Labs", domain: "juniperlabs.example", industry: "Biotech SaaS", location: "San Diego, CA", revenue_range: "$1M-$10M", employee_count: 30, icp_score: 88, deal_health_score: 55, memory_summary: "Founder-led; budget opens in January planning cycle.", activity_count: 18, meeting_count: 1 },
  { id: "c6", name: "Beacon Financial", domain: "beaconfin.example", industry: "Financial services", location: "Charlotte, NC", revenue_range: "$50M-$100M", employee_count: 350, icp_score: 61, deal_health_score: 41, memory_summary: "Went quiet after pricing; budget is next fiscal year.", activity_count: 12, meeting_count: 1 },
  { id: "c7", name: "Halcyon Retail Group", domain: "halcyonretail.example", industry: "Retail", location: "Minneapolis, MN", revenue_range: "$100M+", employee_count: 1200, icp_score: 70, deal_health_score: 68, memory_summary: "Integration objection resolved; pricing revision requested.", activity_count: 31, meeting_count: 3 },
  { id: "c8", name: "Orbital Media", domain: "orbitalmedia.example", industry: "Media", location: "Los Angeles, CA", revenue_range: "$1M-$10M", employee_count: 45, icp_score: 54, deal_health_score: null, memory_summary: "Connected on LinkedIn; no conversation yet.", activity_count: 4, meeting_count: 0 },
  { id: "c9", name: "Summit Manufacturing", domain: "summitmfg.example", industry: "Manufacturing", location: "Denver, CO", revenue_range: "$100M+", employee_count: 950, icp_score: 72, deal_health_score: 47, memory_summary: "Clari owns the forecast call; security assessment required.", activity_count: 22, meeting_count: 2 },
  { id: "c10", name: "Redwood Insurance", domain: "redwoodins.example", industry: "Insurance", location: "Hartford, CT", revenue_range: "$100M+", employee_count: 2100, icp_score: 78, deal_health_score: 33, memory_summary: "Regulated: 300-question security review; procurement frozen this quarter.", activity_count: 17, meeting_count: 2 },
  { id: "c11", name: "Vantage Legal", domain: "vantagelegal.example", industry: "Legal", location: "New York, NY", revenue_range: "$10M-$50M", employee_count: 210, icp_score: 66, deal_health_score: 58, memory_summary: "Partners split on AI policy; buying signal from managing partner.", activity_count: 14, meeting_count: 1 },
  { id: "c12", name: "Pinecrest Foods", domain: "pinecrestfoods.example", industry: "Food & beverage", location: "Portland, OR", revenue_range: "$50M-$100M", employee_count: 500, icp_score: 49, deal_health_score: null, memory_summary: null, activity_count: 1, meeting_count: 0 },
  // Customers (Customers page). Atlas Health above is one too; Harbor Logistics cancelled.
  { id: "c13", name: "Kingsway Distribution", domain: "kingswaydist.example", industry: "Logistics", location: "Columbus, OH", revenue_range: "$50M-$100M", employee_count: 380, icp_score: 77, deal_health_score: 40, memory_summary: "Customer since 2025; dispatch usage falling after a reorg.", activity_count: 28, meeting_count: 2 },
  { id: "c14", name: "Parkside Clinics", domain: "parksideclinics.example", industry: "Healthcare", location: "Raleigh, NC", revenue_range: "$10M-$50M", employee_count: 160, icp_score: 82, deal_health_score: 57, memory_summary: "Customer; we owe them the weekend-shift report from the QBR.", activity_count: 33, meeting_count: 3 },
  { id: "c15", name: "Elmstreet Media", domain: "elmstreetmedia.example", industry: "Media", location: "Brooklyn, NY", revenue_range: "$1M-$10M", employee_count: 40, icp_score: 58, deal_health_score: 35, memory_summary: "Customer; champion left in August and nobody has logged in since.", activity_count: 9, meeting_count: 1 },
  { id: "c16", name: "Northshore Freight", domain: "northshorefreight.example", industry: "Logistics", location: "Vancouver, BC", revenue_range: "$50M-$100M", employee_count: 520, icp_score: 80, deal_health_score: 82, memory_summary: "Customer; asked for the service desk at a second warehouse.", activity_count: 41, meeting_count: 4 },
  { id: "c17", name: "Valley Credit Union", domain: "valleycu.example", industry: "Financial services", location: "Fresno, CA", revenue_range: "$10M-$50M", employee_count: 210, icp_score: 69, deal_health_score: 75, memory_summary: "Customer; the lending team asked about member insights.", activity_count: 19, meeting_count: 2 },
  { id: "c18", name: "Ridgeline Software", domain: "ridgelinesoftware.example", industry: "DevTools", location: "Boulder, CO", revenue_range: "$10M-$50M", employee_count: 120, icp_score: 86, deal_health_score: 90, memory_summary: "Closed won last week; onboarding under way.", activity_count: 22, meeting_count: 3 },
  { id: "c19", name: "Fairmont Dental Group", domain: "fairmontdental.example", industry: "Healthcare", location: "Tampa, FL", revenue_range: "$10M-$50M", employee_count: 300, icp_score: 74, deal_health_score: 70, memory_summary: "Closed won this week; handoff to Customer Success pending.", activity_count: 16, meeting_count: 2 },
  { id: "c20", name: "Harbor Logistics", domain: "harborlogistics.example", industry: "Logistics", location: "Savannah, GA", revenue_range: "$50M-$100M", employee_count: 450, icp_score: 63, deal_health_score: null, memory_summary: "Cancelled in August after a budget freeze.", activity_count: 12, meeting_count: 0 },
];

// ── Contacts ─────────────────────────────────────────────────────────────────
// Owners tell the manager story: Jordan carries c1/c4/c5/c6/c10, Imogen carries
// c2/c3/c7/c9/c11, Atlas + Dana are COLLISIONS (two reps in the conversation),
// Orbital + Pinecrest are ORPHANS (no owner on the account).
const C = (id, first, last, title, seniority, companyId, stage, ownerId, extra = {}) => {
  const co = COMPANIES.find(x => x.id === companyId);
  return {
    id, workspace_id: WS, first_name: first, last_name: last,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${co.domain}`,
    job_title: title, seniority, department: null,
    company: co.name, company_id: companyId, domain: co.domain,
    linkedin_url: `https://linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`,
    pipeline_stage: stage, source: "linkedin", status: "active", lead_source: null,
    phone: null, city: null, country: "US", photo_url: null,
    created_at: iso(90), first_seen_at: iso(90), updated_at: iso(1),
    deal_stage: null, deal_value: null, deal_health_score: co.deal_health_score,
    memory_summary: null, notes: null, enrichment_status: "enriched",
    interaction_count: 12, is_internal: false, is_personal: false,
    owner_user_id: ownerId, owner_name: ownerId ? owner(ownerId).name : null,
    owner_members: ownerId ? [owner(ownerId)] : [],
    // Tier thresholds MUST match the real ones (85/70/50 — core scorecard.ts
    // DEFAULT_TIER_THRESHOLDS and frontend tierFromScore), or the People list's
    // served tier contradicts the tier other surfaces derive from the score.
    icp_score: co.icp_score, icp_tier: co.icp_score >= 85 ? "tier_1" : co.icp_score >= 70 ? "tier_2" : co.icp_score >= 50 ? "tier_3" : "not_icp",
    intent_score: 0, intent_band: "Dormant", reply_signal: null, reply_at: null,
    last_activity_at: null,
    ...extra,
  };
};

export const CONTACTS = [
  C("p1", "Dana", "Whitfield", "VP Revenue Operations", "vp", "c1", "evaluating", "u2", { intent_score: 62, intent_band: "Warm", reply_signal: "positive", reply_at: iso(17), last_activity_at: iso(17), deal_value: 42000, owner_members: [owner("u2"), owner("u3")] }),
  C("p3", "Meera", "Raman", "Chief Financial Officer", "c_suite", "c1", "evaluating", "u2", { intent_score: 30, intent_band: "Aware", last_activity_at: iso(41) }),
  C("p4", "Nate", "Holloway", "Head of Sales", "head", "c1", "aware", "u2", { intent_score: 20, intent_band: "Aware", last_activity_at: iso(33) }),
  C("p5", "Alex", "Kim", "RevOps Analyst", null, "c1", "aware", "u2", { intent_score: 45, intent_band: "Warm", last_activity_at: iso(9) }),
  C("p6", "Sara", "Lindqvist", "VP Operations", "vp", "c2", "interested", "u3", { intent_score: 55, intent_band: "Warm", last_activity_at: iso(8) }),
  C("p7", "Ben", "Ortiz", "Sales Manager", "manager", "c2", "aware", "u3", { intent_score: 25, intent_band: "Aware", last_activity_at: iso(12) }),
  C("p2", "Marcus", "Bell", "Chief Revenue Officer", "c_suite", "c3", "evaluating", "u3", { intent_score: 74, intent_band: "Hot", reply_signal: "positive", reply_at: iso(3), last_activity_at: iso(3), deal_value: 38000 }),
  C("p8", "Lena", "Fischer", "RevOps Lead", "head", "c3", "interested", "u3", { intent_score: 58, intent_band: "Warm", last_activity_at: iso(5) }),
  C("p9", "Diego", "Ramos", "Account Executive", null, "c3", "aware", "u3", { intent_score: 15, intent_band: "Dormant", last_activity_at: iso(20) }),
  C("p10", "Grace", "Okafor", "Chief Operating Officer", "c_suite", "c4", "client", "u2", { intent_score: 40, intent_band: "Warm", last_activity_at: iso(5), deal_value: 55000, owner_members: [owner("u2"), owner("u3")] }),
  C("p11", "Ethan", "Park", "Head of RevOps", "head", "c4", "client", "u2", { intent_score: 35, intent_band: "Aware", last_activity_at: iso(6) }),
  C("p12", "Yuki", "Tanaka", "Founder & CEO", "c_suite", "c5", "interested", "u2", { intent_score: 52, intent_band: "Warm", last_activity_at: iso(21), deal_value: 18000 }),
  C("p13", "Robert", "Hayes", "VP Finance", "vp", "c6", "aware", "u2", { intent_score: 18, intent_band: "Dormant", last_activity_at: iso(38) }),
  C("p14", "Ana", "Souza", "Head of Sales Operations", "head", "c7", "evaluating", "u3", { intent_score: 66, intent_band: "Hot", reply_signal: "positive", reply_at: iso(6), last_activity_at: iso(6), deal_value: 24000 }),
  C("p15", "Chris", "Doyle", "IT Director", "director", "c7", "interested", "u3", { intent_score: 22, intent_band: "Aware", last_activity_at: iso(15) }),
  C("p16", "Maya", "Patel", "Founder", "c_suite", "c8", "connected", null, { intent_score: 10, intent_band: "Dormant", last_activity_at: iso(44) }),
  C("p17", "Jack", "Morrison", "VP Sales", "vp", "c9", "interested", "u3", { intent_score: 48, intent_band: "Warm", last_activity_at: iso(12), deal_value: 30000 }),
  C("p18", "Olivia", "Grant", "Sales Ops Manager", "manager", "c9", "interested", "u3", { intent_score: 35, intent_band: "Aware", last_activity_at: iso(14) }),
  C("p19", "Frank", "Delgado", "VP Sales", "vp", "c10", "evaluating", "u2", { intent_score: 28, intent_band: "Aware", last_activity_at: iso(26), deal_value: 45000 }),
  C("p20", "Susan", "Cho", "Compliance Lead", "head", "c10", "interested", "u2", { intent_score: 12, intent_band: "Dormant", last_activity_at: iso(30) }),
  C("p21", "Nina", "Rossi", "Managing Partner", "c_suite", "c11", "aware", "u3", { intent_score: 71, intent_band: "Hot", reply_signal: "positive", reply_at: iso(4), last_activity_at: iso(4) }),
  C("p22", "Harold", "Webb", "Operations Director", "director", "c12", "identified", null, { intent_score: 5, intent_band: "Dormant" }),
];

// ── Ownership (the CRM's, not Nous's relationship owners) ────────────────────
// The AE on each account as HubSpot has it, which is what scope=mine reads. The
// preview viewer owns Meridian and Cobalt (the meetings and follow-ups on Home are
// his) and Ridgeline, which he closed last week and handed to Maya Chen in CS;
// Jordan and Imogen carry the rest; c8/c12 are orphans. On the Customers page he is
// the CS owner (CS_BAGS) of Parkside, Elmstreet and Valley, whose AEs are others.
export const PREVIEW_VIEWER = "Avery Castellan";
const ACCOUNT_OWNER = {
  c1: "Avery Castellan", c3: "Avery Castellan", c18: "Avery Castellan",
  c4: "Jordan Reyes", c5: "Jordan Reyes", c6: "Jordan Reyes", c10: "Jordan Reyes", c14: "Jordan Reyes", c17: "Jordan Reyes", c20: "Jordan Reyes",
  c2: "Imogen Farrow", c7: "Imogen Farrow", c9: "Imogen Farrow", c11: "Imogen Farrow", c13: "Imogen Farrow", c15: "Imogen Farrow", c16: "Imogen Farrow", c19: "Imogen Farrow",
};
const COUNTRY = { c16: "CA" };
/** `?scope=` as the API reads it: mine | team, anything else = not asked. */
export const readScope = (raw) => (raw === "mine" || raw === "team" ? raw : null);
const scopeFields = (scope) => (scope ? { scope, scope_unmapped: false } : {});
const day = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
// entity_list_rows.close_date is a timestamptz; PostgREST prints it like this.
const closeTs = (days) => `${day(days)}T00:00:00+00:00`;

// ── Pipelines + stages (/api/crm-pipelines, /api/workspaces/:id/stages) ──────
const SALES = { id: "default", name: "Sales pipeline" };
const EXPANSION = { id: "70000001", name: "Expansion pipeline" };
const STAGE = (pipeline_ref, sort_order, key, label, canonical, kind, external_ref) =>
  ({ key, label, canonical, sort_order, kind, is_signup_default: false, source: "crm", external_ref, pipeline_ref });
const STAGES = {
  default: [
    STAGE("default", 0, "discovery", "Discovery", "discovery", "active", "appointmentscheduled"),
    STAGE("default", 1, "demo_booked", "Demo booked", "meeting_booked", "active", "qualifiedtobuy"),
    STAGE("default", 2, "demo_completed", "Demo completed", "demo", "active", "presentationscheduled"),
    STAGE("default", 3, "proposal_sent", "Proposal sent", "negotiation", "active", "decisionmakerboughtin"),
    STAGE("default", 4, "committed", "Committed", "negotiation", "active", "contractsent"),
    STAGE("default", 5, "closed_won", "Closed won", "closed_won", "won", "closedwon"),
    STAGE("default", 6, "closed_lost", "Closed lost", "closed_lost", "lost", "closedlost"),
  ],
  [EXPANSION.id]: [
    STAGE(EXPANSION.id, 0, "opportunity_found", "Opportunity found", "discovery", "active", "70000101"),
    STAGE(EXPANSION.id, 1, "scoping", "Scoping", "demo", "active", "70000102"),
    STAGE(EXPANSION.id, 2, "proposal_sent", "Proposal sent", "negotiation", "active", "70000103"),
    STAGE(EXPANSION.id, 3, "closed_won", "Closed won", "closed_won", "won", "70000104"),
    STAGE(EXPANSION.id, 4, "closed_lost", "Closed lost", "closed_lost", "lost", "70000105"),
  ],
};
/** GET /api/workspaces/:id/stages?pipelineId= — one pipeline's ladder; none asked = the workspace's own. */
export function stagesFor(pipelineId) {
  const ref = pipelineId || null;
  const ladder = STAGES[ref ?? "default"] ?? STAGES.default;
  return { stages: ladder.map((s) => ({ ...s, pipeline_ref: ref ? s.pipeline_ref : null })), pipeline_ref: ref };
}

// ── Deals (/api/companies/deals, Home's numbers) ────────────────────────────
// listDealRows' MAPPED shape (`id`, `value`), plus the verdict and the health the
// route adds. `wk` is this week's history for Home: which line, from, to.
const DEAL = (id, companyId, name, pipeline, stage, status, value, closeDays, lastDaysAgo, health, reason, wk = null) => {
  const co = COMPANIES.find((x) => x.id === companyId);
  const people = CONTACTS.filter((c) => c.company_id === companyId).slice(0, 4)
    .map((c) => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, email: c.email, photo_url: null }));
  const row = {
    id, name, company_id: companyId, company_name: co.name, company_domain: co.domain,
    stage, status, value, close_date: closeTs(closeDays), owner_name: ACCOUNT_OWNER[companyId] ?? null,
    last_activity_at: lastDaysAgo == null ? null : iso(lastDaysAgo),
    pipeline_id: pipeline.id, pipeline: pipeline.name,
    roster_ids: people.map((p) => p.id), roster_people: people, roster_count: people.length, roster_known: false,
    health_score: status === "open" ? health : null, health_reason: status === "open" ? reason : null,
  };
  return { ...row, verdict: dealVerdict(row), wk };
};
export const DEALS = [
  // Sales pipeline, open: 19 deals over five stages.
  DEAL("dl-01", "c1", "Meridian Analytics · Platform", SALES, "Proposal sent", "open", 42000, -9, 17, 38, "Security review gates the pilot; 17 days since Dana replied"),
  DEAL("dl-02", "c1", "Meridian Analytics · RevOps seats", SALES, "Discovery", "open", 9000, 40, 4, 62, "Alex Kim is keen; no budget owner named yet"),
  DEAL("dl-03", "c3", "Cobalt Systems · Pilot", SALES, "Committed", "open", 38000, 12, 3, 81, "CRO sponsoring; pilot kickoff booked for this week"),
  DEAL("dl-04", "c3", "Cobalt Systems · Data team add-on", SALES, "Demo booked", "open", 12000, 45, 5, 66, "Lena Fischer asked for it after the ROI review", { bucket: "new" }),
  DEAL("dl-18", "c3", "Cobalt Systems · Support seats", SALES, "Proposal sent", "open", 9500, 20, 3, 72, "Pricing accepted in principle; waiting on seat count", { bucket: "moved_up", from: "Demo completed", to: "Proposal sent" }),
  DEAL("dl-05", "c2", "Northwind Logistics · Ops rollout", SALES, "Demo completed", "open", 36000, 30, 8, 76, "Ops-led evaluation with the CS org already bought in", { bucket: "moved_up", from: "Demo booked", to: "Demo completed" }),
  DEAL("dl-13", "c2", "Northwind Logistics · Driver app", SALES, "Discovery", "open", 11000, 55, 6, 63, "Raised by Ben Ortiz; second buyer, early"),
  DEAL("dl-06", "c7", "Halcyon Retail · Enterprise", SALES, "Proposal sent", "open", 24000, 14, 6, 68, "Integration objection resolved; revised pricing out", { bucket: "moved_up", from: "Demo completed", to: "Proposal sent" }),
  DEAL("dl-19", "c7", "Halcyon Retail · Store analytics", SALES, "Committed", "open", 26000, 7, 2, 84, "Verbal yes from Ana Souza; paper with procurement", { bucket: "moved_up", from: "Proposal sent", to: "Committed" }),
  DEAL("dl-07", "c9", "Summit Manufacturing · Forecasting", SALES, "Demo completed", "open", 30000, 28, 12, 47, "Clari owns the forecast call; security assessment pending"),
  DEAL("dl-14", "c9", "Summit Manufacturing · Plant 2", SALES, "Demo booked", "open", 16000, 35, 3, 49, "Single-threaded through Olivia Grant"),
  DEAL("dl-08", "c10", "Redwood Insurance · Compliance tier", SALES, "Proposal sent", "open", 45000, 40, 26, 33, "300-question security review; procurement frozen this quarter", { bucket: "slipped", from: day(10), to: day(40) }),
  DEAL("dl-16", "c10", "Redwood Insurance · Claims team", SALES, "Demo completed", "open", 19000, 33, 5, 44, "Compliance lead is a detractor"),
  DEAL("dl-09", "c5", "Juniper Labs · Starter", SALES, "Discovery", "open", 18000, 75, 21, 55, "Budget opens in the January planning cycle", { bucket: "slipped", from: day(20), to: day(75) }),
  DEAL("dl-17", "c5", "Juniper Labs · Lab ops", SALES, "Demo booked", "open", 6500, 48, 7, 57, "Yuki wants a second demo for the lab managers"),
  DEAL("dl-10", "c6", "Beacon Financial · Pilot", SALES, "Proposal sent", "open", 22000, -26, 38, 41, "Went quiet after pricing; budget is next fiscal year"),
  DEAL("dl-15", "c6", "Beacon Financial · Wealth desk", SALES, "Discovery", "open", 7000, 90, null, null, null),
  DEAL("dl-11", "c11", "Vantage Legal · Pilot", SALES, "Discovery", "open", 14000, 50, 4, 58, "Managing partner asked for pricing and the AI-policy one-pager", { bucket: "new" }),
  DEAL("dl-12", "c11", "Vantage Legal · Partner seats", SALES, "Demo booked", "open", 8000, 60, 4, 61, "Partners split on AI policy"),
  // Expansion pipeline, open.
  DEAL("dl-20", "c4", "Atlas Health · Q4 expansion", EXPANSION, "Scoping", "open", 55000, 60, 5, 88, "Grace Okafor scoping two more regions", { bucket: "new" }),
  DEAL("dl-21", "c16", "Northshore Freight · Service desk", EXPANSION, "Proposal sent", "open", 14400, 21, 2, 79, "They asked for it for the second warehouse"),
  // Won, any age.
  DEAL("dl-31", "c19", "Fairmont Dental Group · Growth", SALES, "Closed won", "won", 13200, -2, 2, null, null, { bucket: "won", from: "Committed", to: "Closed won" }),
  DEAL("dl-32", "c18", "Ridgeline Software · Team", SALES, "Closed won", "won", 19200, -8, 6, null, null),
  DEAL("dl-30", "c4", "Atlas Health · Platform", SALES, "Closed won", "won", 96000, -140, 5, null, null),
  DEAL("dl-33", "c13", "Kingsway Distribution · Fleet", SALES, "Closed won", "won", 25200, -400, 4, null, null),
  DEAL("dl-34", "c14", "Parkside Clinics · Growth", SALES, "Closed won", "won", 21600, -300, 15, null, null),
  DEAL("dl-35", "c15", "Elmstreet Media · Starter", SALES, "Closed won", "won", 14400, -200, 31, null, null),
  DEAL("dl-36", "c16", "Northshore Freight · Platform", SALES, "Closed won", "won", 31200, -500, 2, null, null),
  DEAL("dl-37", "c17", "Valley Credit Union · Starter", SALES, "Closed won", "won", 10800, -180, 9, null, null),
  DEAL("dl-38", "c20", "Harbor Logistics · Platform", SALES, "Closed won", "won", 18000, -700, 60, null, null),
  // Lost, last 12 months.
  DEAL("dl-40", "c7", "Halcyon Retail · Loss-prevention add-on", SALES, "Closed lost", "lost", 9000, -3, 6, null, null, { bucket: "lost", from: "Demo completed", to: "Closed lost" }),
  DEAL("dl-41", "c9", "Summit Manufacturing · Spring pilot", SALES, "Closed lost", "lost", 20000, -150, 12, null, null),
];

const inBook = (scope) => (d) => scope !== "mine" || d.owner_name === PREVIEW_VIEWER;
const withoutWk = ({ wk, ...d }) => d;

/** GET /api/companies/deals?status=&scope= */
export function dealsPayload(scope, status) {
  const rows = DEALS.filter(inBook(scope)).filter((d) => !status || status === "all" || d.status === status).map(withoutWk);
  return {
    deals: rows, stale: stalePipeline(rows),
    counts: { customers: new Set(DEALS.filter((d) => d.status === "won").map((d) => d.company_id)).size },
    primary_pipeline_ref: SALES.id, country: null, focus_country: null, ...scopeFields(scope),
  };
}

/** GET /api/crm-pipelines — the pipelines the viewer's deals sit in, primary first. */
export function crmPipelines() {
  const pipelines = [SALES, EXPANSION].map((p) => {
    const mine = DEALS.filter((d) => d.pipeline_id === p.id);
    return { id: p.id, name: p.name, deals: mine.length, open_deals: mine.filter((d) => d.status === "open").length, is_primary: p.id === SALES.id };
  });
  return { pipelines, primary_pipeline_ref: SALES.id, names_ready: true };
}

// ── Customer Success (/api/customer-success/accounts) ───────────────────────
// The CRM's own health bag per customer (entity_list_rows.cs, keys without the
// `cs.` prefix). The CS owner is a different person from the AE (ACCOUNT_OWNER).
const CS_OWNER_EMAIL = { "Maya Chen": "maya@opennous.example", "Avery Castellan": "avery@opennous.example" };
const BAG = (status, tier, mrr, health, users, seats, csOwner, extra = {}) =>
  ({ status, tier, mrr, health_score: health, active_users_30d: users, total_users: seats, owner_name: csOwner, owner_email: CS_OWNER_EMAIL[csOwner] ?? null, ...extra });
export const CS_BAGS = {
  c4: BAG("client", "Enterprise", 8200, 91, 64, 80, "Maya Chen", { products: ["Platform", "Forecasting"], upgrade_stage: "Under Discussion", upgrade_value: 2400, upgrade_products: ["Forecasting add-on"] }),
  c13: BAG("client", "Growth", 2100, 38, 4, 18, "Maya Chen", { products: ["Platform"], risk_tier: "high", risk_status: "open", risk_signals: ["logins_down", "tickets_up"] }),
  c14: BAG("client", "Growth", 1800, 55, 11, 15, "Avery Castellan", { products: ["Platform"], units_90d: 130, units_prev_90d: 220 }),
  c15: BAG("client", "Starter", 1200, 44, 0, 12, "Avery Castellan", { products: ["Platform"], last_used_at: iso(41) }),
  c16: BAG("client", "Enterprise", 2600, 81, 19, 22, "Maya Chen", { products: ["Platform"], upgrade_stage: "Never Raised", upgrade_value: 1200, upgrade_products: ["Service desk"] }),
  c17: BAG("client", "Starter", 900, 77, 8, 9, "Avery Castellan", { products: ["Platform"], upgrade_stage: "Never Raised", upgrade_value: 600, upgrade_products: ["Member insights"], upgrade_target: "Growth" }),
  c18: BAG("client", "Growth", 1600, 90, 15, 16, "Maya Chen", { products: ["Platform"] }),
  c19: BAG("client", "Growth", 1100, 68, 10, 14, "Maya Chen", { products: ["Platform"] }),
  c20: BAG("cancelled", "Growth", 1500, null, 0, 20, "Maya Chen", { cancelled_at: iso(48), cancel_reason: "Budget freeze" }),
};
const SAID = (kind, tier, text, quote, daysAgo, via, extra = {}) =>
  ({ tier, kind, text, detail: quote, evidence: "said", quote, at: iso(daysAgo), via, ...extra });
const CRM = (kind, tier, text, detail) => ({ tier, kind, text, detail, evidence: "crm" });
const REASONS = {
  c4: { risk: [], expansion: [SAID("they_asked", 1, "Asked about Forecasting add-on", "Could we get forecasting for the Boston and Providence teams before Q1?", 6, "in a meeting", { product: "Forecasting add-on", conflict: null })] },
  c13: { risk: [
    CRM("churn_flag", 1, "Churn prediction open", "logins down, tickets up"),
    SAID("they_said", 2, "Questioning whether dispatch still needs it", "We're evaluating whether dispatch still needs this after the reorg.", 5, "they emailed"),
  ], expansion: [] },
  // What we owe them is its own list now ("We promised", PROMISED below), never a risk reason.
  c14: { risk: [
    CRM("usage_drop", 2, "Usage down 41% this quarter", "220 → 130 units"),
  ], expansion: [] },
  c15: { risk: [
    CRM("no_usage", 1, "Paying $1,200/mo, nobody logged in", "0 active users in 30 days of 12 seats"),
    CRM("dark", 2, "No product activity in 41 days", null),
    { tier: 4, kind: "quiet", text: "No contact in 31 days", detail: null, evidence: "said" },
  ], expansion: [] },
  c16: { risk: [], expansion: [SAID("they_asked", 1, "Asked about Service desk", "We'd want the service desk for the second warehouse before peak season.", 3, "they emailed", { product: "Service desk", conflict: 'CRM says "Never Raised"' })] },
  c17: { risk: [], expansion: [
    SAID("they_asked", 1, "Asked about Member insights", "Is there a way to add member insights for the lending team?", 9, "on a call", { product: "Member insights", conflict: 'CRM says "Never Raised"' }),
    CRM("upgrade_untouched", 1, "$600/mo upgrade, never discussed", "Growth · Member insights"),
  ] },
  c18: { risk: [], expansion: [] },
  c19: { risk: [], expansion: [] },
  c20: { risk: [], expansion: [] },
};
// Renewal dates: the end of a committed subscription term in HubSpot (Phase 5). Valley (c17) is
// billed month to month, so it has no renewal date and term_months 1, which the page shows as "Monthly".
const RENEWAL = { c4: 210, c13: 45, c14: 29, c15: 18, c16: 160, c18: 300, c19: 365 };
const TERM_MONTHS = { c4: 12, c13: 12, c14: 12, c15: 12, c16: 12, c17: 1, c18: 12, c19: 12 };
// Active users now minus ~30 days ago, from the daily snapshots. Null until a month of history.
const USERS_TREND = { c4: 6, c13: -9, c14: -4, c15: -3, c16: 2, c17: 0, c18: 1 };
// "We promised": open commitments we owe, overdue or from a call. Never a risk reason.
const PROMISE = (text, overdueDays, daysAgo, quote = null) => ({
  tier: overdueDays ? 2 : 3, kind: "promised", text,
  detail: overdueDays ? `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue` : "promised on a call",
  evidence: "said", quote, at: iso(daysAgo), via: "on a call",
  due_at: overdueDays ? day(-overdueDays) : null, overdue_days: overdueDays || null,
});
const PROMISED = {
  c14: [PROMISE("Weekend-shift report promised for the end of September, not sent", 2, 24, "We'll have the weekend-shift report to you by the end of the month.")],
  c13: [PROMISE("Send dispatch the reorg-ready routing guide", 0, 5), PROMISE("Book a training for the new dispatch leads", 6, 19)],
  c19: [PROMISE("Spanish-language templates live in week one", 0, 2, "We'll have the Spanish templates ready for your first week.")],
};
// The account strip reads the bag (GET /api/companies/:id/detail), so the same fields ride on it.
for (const [id, bag] of Object.entries(CS_BAGS)) {
  if (RENEWAL[id] != null) bag.renewal_date = day(RENEWAL[id]);
  if (TERM_MONTHS[id] != null) bag.term_months = TERM_MONTHS[id];
  if (USERS_TREND[id] != null) bag.active_users_trend = USERS_TREND[id];
}
const csRow = (id) => {
  const co = COMPANIES.find((x) => x.id === id);
  const h = CS_BAGS[id];
  const r = REASONS[id];
  const last = Math.max(...DEALS.filter((d) => d.company_id === id && d.last_activity_at).map((d) => Date.parse(d.last_activity_at)), 0) || null;
  const csOwner = h.owner_name ?? null;
  return {
    companyId: id, name: co.name, domain: co.domain, industry: co.industry,
    peopleCount: CONTACTS.filter((c) => c.company_id === id).length,
    openDeals: DEALS.filter((d) => d.company_id === id && d.status === "open").length,
    wonValue: DEALS.filter((d) => d.company_id === id && d.status === "won").reduce((s, d) => s + d.value, 0) || null,
    lastActivityAt: last ? new Date(last).toISOString() : null,
    daysQuiet: last ? Math.round((Date.now() - last) / DAY) : null,
    status: h.status, mrr: h.mrr, tier: h.tier, csOwner,
    activeUsers: h.active_users_30d, totalUsers: h.total_users, lastUsedAt: h.last_used_at ?? null,
    products: h.products ?? [], upgradeValue: h.upgrade_value ?? null, upgradeStage: h.upgrade_stage ?? null,
    riskReasons: r.risk, expansionReasons: r.expansion,
    saidCount: [...r.risk, ...r.expansion].filter((x) => x.evidence === "said").length,
    crm_health_score: h.health_score ?? null, active_users_30d: h.active_users_30d ?? null,
    renewal_date: RENEWAL[id] != null ? day(RENEWAL[id]) : null,
    term_months: TERM_MONTHS[id] ?? null,
    active_users_trend: USERS_TREND[id] ?? null,
    promisedReasons: [...(PROMISED[id] ?? [])].sort((x, y) => (y.overdue_days ?? 0) - (x.overdue_days ?? 0)),
    promised_count: (PROMISED[id] ?? []).length,
    cs_owner_name: csOwner, owner_name: ACCOUNT_OWNER[id] ?? null,
  };
};

/** GET /api/customer-success/accounts?scope= — mine is by CS OWNER, never the AE. */
/** GET /api/companies/:id/account-health (GET-692): the account's row off the Customers fixture. */
export function accountHealthFor(companyId) {
  const p = csPayload(null);
  const churned = p.churned.find((r) => r.companyId === companyId);
  if (churned) return { state: "churned", ...churned };
  const r = p.accounts.find((x) => x.companyId === companyId);
  if (!r) return { state: null };
  const state = p.atRiskIds.includes(companyId) ? "at_risk" : p.expansionIds.includes(companyId) ? "expansion" : "healthy";
  return { state, ...r };
}

export function csPayload(scope) {
  const mine = (r) => scope !== "mine" || r.cs_owner_name === PREVIEW_VIEWER;
  const all = Object.keys(CS_BAGS).map(csRow).filter(mine);
  const rank = (r) => r.riskReasons[0]?.tier ?? 9;
  const active = all.filter((r) => r.status === "client").sort((x, y) => rank(x) - rank(y) || (y.mrr ?? 0) - (x.mrr ?? 0));
  const churned = all.filter((r) => r.status === "cancelled");
  // The live rule: one tier-1 reason, or two tier-2 ones. At risk wins over expansion.
  const atRisk = active.filter((r) => r.riskReasons.some((x) => x.tier === 1) || r.riskReasons.filter((x) => x.tier === 2).length >= 2);
  const riskIds = new Set(atRisk.map((r) => r.companyId));
  const expansion = active.filter((r) => r.expansionReasons.length && !riskIds.has(r.companyId));
  const sum = (rows, pick) => Math.round(rows.reduce((t, r) => t + (Number(pick(r)) || 0), 0));
  return {
    accounts: active, expansionIds: expansion.map((r) => r.companyId), atRiskIds: atRisk.map((r) => r.companyId), churned,
    counts: { active: active.length, expansion: expansion.length, atRisk: atRisk.length, churned: churned.length },
    totals: { mrr: sum(active, (r) => r.mrr), expansionValue: sum(expansion, (r) => r.upgradeValue), atRiskMrr: sum(atRisk, (r) => r.mrr), churnedMrr: sum(churned, (r) => r.mrr) },
    healthReady: true, healthColumn: true, cs_owner_recorded: true, minedReady: true,
    fromConversation: {
      expansion: expansion.filter((r) => r.expansionReasons[0]?.evidence === "said").length,
      atRisk: atRisk.filter((r) => r.riskReasons.some((x) => x.kind === "they_said")).length,
      suppressed: 1,
    },
    ...scopeFields(scope),
  };
}

// ── Handoffs (/api/lifecycle/handoffs) ──────────────────────────────────────
export const HANDOFFS = [
  { id: "5b1e7c2a-3f4d-4e8b-9a61-0c2d4e6f8a10", company_id: "c19", from_stage: "sales_pipeline", to_stage: "handoff", from_dept: "sales", to_dept: "customer_success", reason: "closed_won", note: "Promised Spanish-language templates and a Saturday team training in week one.", created_at: iso(2), acknowledged_at: null },
  { id: "9c3a1d4e-6b7f-4a2c-8d15-2e4f6a8b0c12", company_id: "c18", from_stage: "sales_pipeline", to_stage: "handoff", from_dept: "sales", to_dept: "customer_success", reason: "closed_won", note: null, created_at: iso(8), acknowledged_at: null },
  // A change of CS owner in HubSpot (the daily csSnapshots job): both people named, the stage unmoved.
  { id: "2d7e9a41-8c3b-4f5e-a1d6-7b9c0e2f4a63", company_id: "c13", from_stage: "active_customer", to_stage: "active_customer", from_dept: "customer_success", to_dept: "customer_success", reason: "cs_owner_change", note: "CS owner changed in the CRM from Avery Castellan to Maya Chen", from_owner: "Avery Castellan", to_owner: "Maya Chen", created_at: iso(1), acknowledged_at: null },
].map((h) => { const co = COMPANIES.find((x) => x.id === h.company_id); return { ...h, company_name: co.name, company_domain: co.domain }; });

// ── Accounts list (/api/companies/list) ─────────────────────────────────────
/** The list rows: the world's companies plus the redesign's owner, market and customer fields. */
export function companiesList(scope) {
  const companies = COMPANIES.map((c) => ({
    ...c, owner_name: ACCOUNT_OWNER[c.id] ?? null, country: COUNTRY[c.id] ?? "US",
    customer_status: CS_BAGS[c.id]?.status ?? null, mrr: CS_BAGS[c.id]?.mrr ?? null,
  })).filter((c) => scope !== "mine" || c.owner_name === PREVIEW_VIEWER);
  const markets = new Map();
  for (const c of COMPANIES) { const k = COUNTRY[c.id] ?? "US"; markets.set(k, (markets.get(k) ?? 0) + 1); }
  return {
    companies, total: companies.length, limit: 200, offset: 0, q: null, country: null, focus_country: null,
    countries: [...markets].sort((a, b) => b[1] - a[1]).map(([country, accounts]) => ({ country, accounts })),
    ...scopeFields(scope),
  };
}

// ── Flags (company-level; My Day + board badges) ─────────────────────────────
const FLAG = (id, companyId, type, reason, priority, fit, momentum) => {
  const co = COMPANIES.find(x => x.id === companyId);
  return {
    id, workspace_id: WS, entity_id: companyId, flag_type: type, reason,
    evidence: { source: "sweep", detail: reason }, fit_score: fit, momentum_score: momentum,
    priority, status: "open", owner_user_id: null, owner_name: null, source: "sweep",
    created_at: iso(3), last_fired_at: iso(1), snoozed_until: null, resolved_at: null,
    account_name: co.name, account_domain: co.domain,
  };
};
export const FLAGS = [
  FLAG("f1", "c10", "went_dark", "26 days quiet after an active security review — high-fit account going cold", 90, 78, 22),
  FLAG("f2", "c1", "fit_cold", "ICP 84 but engagement cooling: 1 of 4 contacts active in the last 45 days", 84, 84, 35),
  FLAG("f3", "c11", "buying_signal", "Managing partner asked for the AI-policy one-pager and pricing in the same week", 80, 66, 71),
  FLAG("f4", "c6", "went_dark", "38 days quiet since the pricing conversation stalled", 62, 61, 15),
  FLAG("f5", "c5", "fit_cold", "Highest-ICP open account (88) with three weeks of silence", 75, 88, 30),
  FLAG("f6", "c7", "objection_resolved", "HubSpot integration objection resolved — re-engage while it's fresh", 70, 70, 60),
];

// ── Tasks: meetings + commitments (transcript-extracted promises) ────────────
const A = (id) => { const u = USERS.find(x => x.id === id); return { id: u.id, name: u.name, avatar: null }; };
// Faithful to the real extraction path: the worker records the words someone
// SAID about timing ("by end of week") and when they said it — never a
// timestamp. due_at stays null, exactly as it does in production, so the
// frontend's phrase resolver is what's actually being exercised here.
const CMT = (n, entityId, title, ownerUserId, saidDaysAgo, duePhrase, kind) => {
  const c = CONTACTS.find(x => x.id === entityId);
  const co = COMPANIES.find(x => x.id === entityId);
  const u = USERS.find(x => x.id === ownerUserId);
  return {
    id: `${entityId}:action_item.t${n}`, entity_id: entityId, title,
    owner_kind: "user", owner_name: u.name, status: "open",
    due_at: null, due_phrase: duePhrase,
    source_type: "meeting", recorded_at: iso(saidDaysAgo), completed_at: null, completed_reason: null, completed_by: null,
    account: c ? `${c.first_name} ${c.last_name}` : co?.name ?? "—",
    company: c ? c.company : null, internal: false, kind,
    actions: [{ label: `Catch me up on ${c ? c.first_name : co?.name}`, prompt: `Catch me up on ${c ? `${c.first_name} ${c.last_name}` : co?.name}` }],
    assignee: A(ownerUserId), owner_is_member: true,
  };
};
export const TASKS = {
  meetings: [
    { when: isoIn(1), title: "Meridian — security review prep", status: "scheduled", with: "Dana Whitfield", company: "Meridian Analytics", job_title: "VP Revenue Operations", entity_id: "p1", assignee: A("u2"), actions: [
      { label: "Brief me on this meeting", prompt: "Brief me on my meeting with Dana Whitfield" },
      { label: "What should I ask?", prompt: "What should I ask Dana Whitfield in our security review prep?" },
      { label: "What changed since we last spoke?", prompt: "What changed at Meridian Analytics since we last spoke?" },
    ]},
    { when: isoIn(3), title: "Cobalt pilot kickoff", status: "scheduled", with: "Marcus Bell", company: "Cobalt Systems", job_title: "Chief Revenue Officer", entity_id: "p2", assignee: A("u3"), actions: [
      { label: "Brief me on this meeting", prompt: "Brief me on my meeting with Marcus Bell" },
      { label: "What should I ask?", prompt: "What should I ask Marcus Bell at the Cobalt pilot kickoff?" },
      { label: "What changed since we last spoke?", prompt: "What changed at Cobalt Systems since we last spoke?" },
    ]},
  ],
  commitments: [
    // (said N days ago, in the speaker's own words) — the mix a real week produces.
    CMT(1, "p1", "Send the security questionnaire pack to Dana", "u2", 6, "by end of week", "delivery"),
    CMT(2, "p1", "Loop in a solutions engineer for the infosec call", "u2", 1, "Monday", "scheduling"),
    CMT(3, "p2", "Share the ROI model with Marcus before kickoff", "u3", 2, "tomorrow", "delivery"),
    CMT(4, "p14", "Send revised pricing to Halcyon", "u3", 4, "in 2 days", "email"),
    CMT(5, "p12", "Intro Yuki to the Atlas reference customer", "u2", 1, "in a couple of weeks", "email"),
    CMT(6, "p17", "Follow up on the Clari comparison doc", "u3", 3, "next Tuesday", "delivery"),
    CMT(7, "c6", "Re-engage Beacon after the budget cycle opens", "u2", 5, "when you get a chance", "general"),
    CMT(8, "p21", "Send the AI-policy one-pager to Nina", "u3", 0, "end of month", "delivery"),
  ],
  completed: [
    { id: "p14:action_item.d1", entity_id: "p14", title: "Confirm HubSpot integration scope with Halcyon IT", owner_kind: "user", owner_name: "Imogen Farrow", status: "done", due_at: iso(2), due_phrase: null, source_type: "meeting", recorded_at: iso(6), completed_at: iso(1), completed_reason: "confirmed on the call", completed_by: "user", account: "Ana Souza", company: "Halcyon Retail Group", internal: false, assignee: A("u3"), owner_is_member: true },
    { id: "p2:action_item.d2", entity_id: "p2", title: "Send pilot success criteria to Cobalt", owner_kind: "user", owner_name: "Imogen Farrow", status: "done", due_at: iso(3), due_phrase: null, source_type: "meeting", recorded_at: iso(7), completed_at: iso(2), completed_reason: "sent", completed_by: "user", account: "Marcus Bell", company: "Cobalt Systems", internal: false, assignee: A("u3"), owner_is_member: true },
    { id: "p10:action_item.d3", entity_id: "p10", title: "Schedule Atlas Q4 expansion review", owner_kind: "user", owner_name: "Jordan Reyes", status: "done", due_at: iso(1), due_phrase: null, source_type: "email", recorded_at: iso(5), completed_at: iso(1), completed_reason: "booked", completed_by: "user", account: "Grace Okafor", company: "Atlas Health", internal: false, assignee: A("u2"), owner_is_member: true },
  ],
  auto_closed: [],
  counts: { meetings: 2, commitments: 8, completed: 3 },
};

// ── Portfolio (/v2/pipeline/portfolio) ───────────────────────────────────────
export const PORTFOLIO = {
  total: 12,
  stage_counts: { identified: 1, aware: 2, connected: 1, interested: 3, evaluating: 4, client: 1 },
  metric_defs: {
    health: "contextual deal-health 0-100 (won>=90, healthy 70-89, needs_attention 40-69, at_risk<40)",
    icp: "ICP fit 0-100, learned from won deals",
    stage: "furthest pipeline stage across the account contacts",
    days_quiet: "days since last activity (high = going cold)",
    flags: "open re-engagement flags: fit_cold, buying_signal, went_dark, objection_resolved",
    open_objections: "count of unresolved objections",
    competitors: "live/incumbent competitors in play (fired past vendors excluded)",
    engagement_trend: "interaction volume, recent 30d vs prior 30d",
    multi_threading: "contacts engaged in the last 45d out of all contacts on the account",
  },
  accounts: [
    { id: "c10", name: "Redwood Insurance", domain: "redwoodins.example", health: 33, band: "at_risk", icp: 78, stage: "evaluating", days_quiet: 26, flags: ["went_dark"], open_objections: 2, competitors: ["Clari"], engagement_trend: "cold", engaged_contacts: 1, total_contacts: 2, single_threaded: true },
    { id: "c1", name: "Meridian Analytics", domain: "meridiananalytics.example", health: 38, band: "at_risk", icp: 84, stage: "evaluating", days_quiet: 17, flags: ["fit_cold"], open_objections: 2, competitors: ["Gong", "Clari"], engagement_trend: "cooling", engaged_contacts: 1, total_contacts: 4, single_threaded: true },
    { id: "c6", name: "Beacon Financial", domain: "beaconfin.example", health: 41, band: "needs_attention", icp: 61, stage: "aware", days_quiet: 38, flags: ["went_dark"], open_objections: 1, competitors: [], engagement_trend: "cold", engaged_contacts: 0, total_contacts: 1, single_threaded: true },
    { id: "c9", name: "Summit Manufacturing", domain: "summitmfg.example", health: 47, band: "needs_attention", icp: 72, stage: "interested", days_quiet: 12, flags: [], open_objections: 1, competitors: ["Clari"], engagement_trend: "steady", engaged_contacts: 2, total_contacts: 2, single_threaded: false },
    { id: "c5", name: "Juniper Labs", domain: "juniperlabs.example", health: 55, band: "needs_attention", icp: 88, stage: "interested", days_quiet: 21, flags: ["fit_cold"], open_objections: 1, competitors: [], engagement_trend: "cooling", engaged_contacts: 1, total_contacts: 1, single_threaded: true },
    { id: "c11", name: "Vantage Legal", domain: "vantagelegal.example", health: 58, band: "needs_attention", icp: 66, stage: "aware", days_quiet: 4, flags: ["buying_signal"], open_objections: 1, competitors: [], engagement_trend: "rising", engaged_contacts: 1, total_contacts: 1, single_threaded: true },
    { id: "c7", name: "Halcyon Retail Group", domain: "halcyonretail.example", health: 68, band: "needs_attention", icp: 70, stage: "evaluating", days_quiet: 6, flags: ["objection_resolved"], open_objections: 0, competitors: ["Gong"], engagement_trend: "steady", engaged_contacts: 2, total_contacts: 2, single_threaded: false },
    { id: "c3", name: "Cobalt Systems", domain: "cobaltsystems.example", health: 74, band: "healthy", icp: 81, stage: "evaluating", days_quiet: 3, flags: [], open_objections: 0, competitors: [], engagement_trend: "rising", engaged_contacts: 3, total_contacts: 3, single_threaded: false },
    { id: "c2", name: "Northwind Logistics", domain: "northwindlog.example", health: 76, band: "healthy", icp: 75, stage: "interested", days_quiet: 8, flags: [], open_objections: 0, competitors: ["Gong"], engagement_trend: "steady", engaged_contacts: 2, total_contacts: 2, single_threaded: false },
    { id: "c8", name: "Orbital Media", domain: "orbitalmedia.example", health: null, band: "unknown", icp: 54, stage: "connected", days_quiet: 44, flags: [], open_objections: 1, competitors: [], engagement_trend: "cold", engaged_contacts: 0, total_contacts: 1, single_threaded: true },
    { id: "c12", name: "Pinecrest Foods", domain: "pinecrestfoods.example", health: null, band: "unknown", icp: 49, stage: "identified", days_quiet: null, flags: [], open_objections: 0, competitors: [], engagement_trend: "cold", engaged_contacts: 0, total_contacts: 1, single_threaded: true },
    { id: "c4", name: "Atlas Health", domain: "atlashealth.example", health: 92, band: "won", icp: 90, stage: "client", days_quiet: 5, flags: [], open_objections: 0, competitors: [], engagement_trend: "steady", engaged_contacts: 2, total_contacts: 2, single_threaded: false },
  ],
};

// ── Graph (/api/graph) — the radar's clusters ────────────────────────────────
export const GRAPH = {
  edges: [],
  meta: { people: 2, companies: 12, clusters: 7, ts: Date.now() },
  nodes: [
    { i: "p1", t: 0, l: "Dana Whitfield", co: "c1", pat: [
      { label: "Security review required before pilot", cat: "objection", evidence: "Our infosec team has to clear any tool that touches customer email before we can pilot it." },
    ]},
    { i: "p2", t: 0, l: "Marcus Bell", co: "c3", pat: [
      { label: "Manual CRM updates eating rep time", cat: "pain", evidence: "My reps spend their Friday afternoons updating Salesforce instead of selling." },
    ]},
    { i: "c1", t: 1, l: "Meridian Analytics", pat: [
      { label: "Gong already in evaluation", cat: "competitor", evidence: "We're four weeks into a Gong pilot on the enterprise team." },
    ]},
    { i: "c2", t: 1, l: "Northwind Logistics", pat: [
      { label: "Gong already in evaluation", cat: "competitor", evidence: "Gong came in through the CS org — we'd have to displace it." },
      { label: "Manual CRM updates eating rep time", cat: "pain", evidence: "Our pipeline reviews start with 20 minutes of arguing about which fields are stale." },
    ]},
    { i: "c3", t: 1, l: "Cobalt Systems", pat: [] },
    { i: "c4", t: 1, l: "Atlas Health", pat: [] },
    { i: "c5", t: 1, l: "Juniper Labs", pat: [
      { label: "Pricing above current budget cycle", cat: "objection", evidence: "There's no line item for this until the January planning cycle." },
    ]},
    { i: "c6", t: 1, l: "Beacon Financial", pat: [
      { label: "Pricing above current budget cycle", cat: "objection", evidence: "The number works for next year's budget, not this one." },
      { label: "Running GTM on spreadsheets", cat: "status_quo", evidence: "Pipeline lives in a spreadsheet the CRO updates by hand on Sundays." },
    ]},
    { i: "c7", t: 1, l: "Halcyon Retail Group", pat: [
      { label: "Gong already in evaluation", cat: "competitor", evidence: null },
    ]},
    { i: "c8", t: 1, l: "Orbital Media", pat: [
      { label: "No internal AI policy yet", cat: "objection", evidence: "Legal hasn't signed off on any AI vendor — we're writing the policy now." },
    ]},
    { i: "c9", t: 1, l: "Summit Manufacturing", pat: [
      { label: "Security review required before pilot", cat: "objection", evidence: "Anything reading our mailboxes goes through a vendor security assessment first." },
      { label: "Clari incumbent for forecasting", cat: "competitor", evidence: "Clari owns the forecast call today — the question is what it misses." },
      { label: "Manual CRM updates eating rep time", cat: "pain", evidence: "CRM hygiene is a standing agenda item in every ops meeting. It never gets better." },
    ]},
    { i: "c10", t: 1, l: "Redwood Insurance", pat: [
      { label: "Security review required before pilot", cat: "objection", evidence: "We're regulated — the security questionnaire is 300 questions and takes six weeks." },
      { label: "Pricing above current budget cycle", cat: "objection", evidence: "Procurement won't open a new SaaS line this quarter." },
      { label: "Clari incumbent for forecasting", cat: "competitor", evidence: null },
    ]},
    { i: "c11", t: 1, l: "Vantage Legal", pat: [
      { label: "No internal AI policy yet", cat: "objection", evidence: "Partners are split on AI touching client correspondence." },
      { label: "Manual CRM updates eating rep time", cat: "pain", evidence: "Associates log calls in a spreadsheet nobody reads." },
    ]},
    { i: "c12", t: 1, l: "Pinecrest Foods", pat: [
      { label: "Running GTM on spreadsheets", cat: "status_quo", evidence: null },
    ]},
    { i: "cl0", t: 3, l: "Security review required before pilot", sz: 3, cat: "objection" },
    { i: "cl1", t: 3, l: "Manual CRM updates eating rep time", sz: 4, cat: "pain" },
    { i: "cl2", t: 3, l: "Gong already in evaluation", sz: 3, cat: "competitor" },
    { i: "cl3", t: 3, l: "Pricing above current budget cycle", sz: 3, cat: "objection" },
    { i: "cl4", t: 3, l: "Clari incumbent for forecasting", sz: 2, cat: "competitor" },
    { i: "cl5", t: 3, l: "No internal AI policy yet", sz: 2, cat: "objection" },
    { i: "cl6", t: 3, l: "Running GTM on spreadsheets", sz: 2, cat: "status_quo" },
  ],
  patterns: {
    single: ["c8", "c12"],
    budget: ["c6"],
    clusters: [
      { label: "Security review required before pilot", cat: "objection", ids: ["p1", "c9", "c10"], node: "cl0" },
      { label: "Manual CRM updates eating rep time", cat: "pain", ids: ["p2", "c2", "c9", "c11"], node: "cl1" },
      { label: "Gong already in evaluation", cat: "competitor", ids: ["c1", "c2", "c7"], node: "cl2" },
      { label: "Pricing above current budget cycle", cat: "objection", ids: ["c5", "c6", "c10"], node: "cl3" },
      { label: "Clari incumbent for forecasting", cat: "competitor", ids: ["c9", "c10"], node: "cl4" },
      { label: "No internal AI policy yet", cat: "objection", ids: ["c8", "c11"], node: "cl5" },
      { label: "Running GTM on spreadsheets", cat: "status_quo", ids: ["c6", "c12"], node: "cl6" },
    ],
  },
};

// ── Campaigns (/v2/campaigns/performance) ────────────────────────────────────
export const CAMPAIGNS = {
  campaigns: [
    {
      campaign_id: "camp1", provider: "instantly", campaign_name: "Q3 RevOps outbound",
      provider_totals: { leads: 480, sent: 1240, contacted: 452, replies: 61, opportunities: 14, bounced: 18, unsubscribed: 6, status: "active", fetched_at: iso(0) },
      provider_rates: { reply_rate: 0.135, opportunity_rate: 0.031 },
      captured: { replies: 48, positive: 19, neutral: 21, negative: 8, positive_rate: 0.4 },
      avg_icp_of_positive: 78, tier_of_positive: { tier_1: 9, tier_2: 7, tier_3: 3, not_icp: 0 },
      conversions: 2, in_progress: 4, median_days_to_client: 34,
      top_objections: ["Security review required before pilot", "Pricing above current budget cycle", "Already running Gong"],
      steps: [
        { step: 1, replies: 26, positive: 12, neutral: 10, negative: 4, positive_rate: 0.46, subject: "Your reps' Friday afternoons", body_preview: "Most RevOps teams we talk to lose a full day a week to CRM updates. We pull every call, email and thread into one account record automatically — so the pipeline review starts with facts, not archaeology…" },
        { step: 2, replies: 14, positive: 5, neutral: 7, negative: 2, positive_rate: 0.36, subject: "Re: Your reps' Friday afternoons", body_preview: "Quick nudge — the teams that moved fastest started with one workflow: the pre-call brief. Two minutes before every call, everything the account ever said…" },
        { step: 3, replies: 8, positive: 2, neutral: 4, negative: 2, positive_rate: 0.25, subject: "Closing the loop", body_preview: "Last note from me. If CRM hygiene isn't a problem worth solving this quarter, no hard feelings — but if the forecast call still runs on anecdotes…" },
      ],
    },
    {
      campaign_id: "camp2", provider: "heyreach", campaign_name: "LinkedIn — founder-led",
      provider_totals: null, provider_rates: null,
      captured: { replies: 22, positive: 11, neutral: 8, negative: 3, positive_rate: 0.5 },
      avg_icp_of_positive: 82, tier_of_positive: { tier_1: 7, tier_2: 3, tier_3: 1, not_icp: 0 },
      conversions: 1, in_progress: 3, median_days_to_client: 41,
      top_objections: ["No internal AI policy yet", "Timing — revisit next quarter"],
      steps: [
        { step: 1, replies: 22, positive: 11, neutral: 8, negative: 3, positive_rate: 0.5, subject: null, body_preview: "Saw your post on forecast accuracy — we built the context layer that keeps the number honest. Worth a look at how Atlas Health runs it?" },
      ],
    },
  ],
  totals: { replies: 70, positive: 30, neutral: 29, negative: 11, conversions: 3, in_progress: 7, sent: 1240, provider_replies: 61, opportunities: 14, positive_rate: 0.43 },
};

// ── Per-company detail + per-person record builders ──────────────────────────
const NOTE = (id, category, content, daysAgo, meta = {}) => ({
  id, source: "signal_extraction", category, label: null, content,
  created_at: iso(daysAgo), confidence: 0.85, metadata: meta,
});

// Meridian gets the full record; other companies get intel derived from their
// radar cluster membership so the radar quotes and the account record agree.
// Each fact carries what the extractor stamps (worker signals/index.mjs): the verbatim quote it
// rests on, who said it, which channel, and the source it came out of.
const CALL1 = "source://fireflies/mtg-meridian-security", CALL2 = "source://fireflies/mtg-meridian-discovery", MAIL1 = "source://gmail/thr-meridian-pricing";
const said = (quote, speaker, signal_type, source_ref) => ({ quote, speaker, signal_type, source_ref });
const MERIDIAN_LABELS = {"n_obj1": "Infosec clearance first", "n_obj1b": "Two-week security review", "n_obj2": "Price versus Gong", "n_obj3": "HubSpot fit", "n_comp1": "Gong pilot", "n_comp2": "Clari incumbent", "n_comp3": "Chorus dropped", "n_tl1": "Decision before the board", "n_buy1": "Annual pricing requested", "n_goal1": "Rep admin time", "n_goal2": "A forecast the CFO trusts", "n_budget1": "Efficiency budget", "n_pain1": "Stale CRM"};
const MERIDIAN_NOTES_RAW = [
  NOTE("n_obj1", "objection", "Infosec has to clear any tool that touches customer email before a pilot", 17, { status: "open", hardness: "hard", voiced_by_contact_id: "p1", ...said("Our infosec team has to clear any tool that touches customer email before we can pilot it", "Dana Whitfield", "meeting_held", CALL1) }),
  NOTE("n_obj1b", "objection", "Security questionnaire usually takes their team two weeks", 3, { status: "open", hardness: "hard", voiced_by_contact_id: "p1", ...said("These reviews normally take us about two weeks", "Dana Whitfield", "email_received", MAIL1) }),
  NOTE("n_obj2", "objection", "The per-seat price is hard to justify while paying for Gong too", 21, { status: "open", hardness: "soft", voiced_by_contact_id: "p4", ...said("The per-seat price is hard to justify while we're paying for Gong too", "Nate Holloway", "meeting_held", CALL2) }),
  NOTE("n_obj3", "objection", "Wasn't sure it would work with their HubSpot setup", 35, { status: "resolved", hardness: "soft", voiced_by_contact_id: "p5", ...said(null, "Alex Kim", "meeting_held", CALL2) }),
  NOTE("n_comp1", "competitor", "Four weeks into a Gong pilot on the enterprise team", 21, { stance: "evaluating", entity: "Gong", voiced_by_contact_id: "p1", ...said("We're four weeks into a Gong pilot on the enterprise team", "Dana Whitfield", "meeting_held", CALL2) }),
  NOTE("n_comp2", "competitor", "Clari owns the forecast call today", 29, { stance: "incumbent", entity: "Clari", voiced_by_contact_id: "p4", ...said("Clari owns the forecast call today", "Nate Holloway", "meeting_held", CALL2) }),
  NOTE("n_comp3", "competitor", "Ran Chorus for a year and dropped it; nobody opened it", 48, { stance: "past_failure", entity: "Chorus", voiced_by_contact_id: "p1" }),
  NOTE("n_tl1", "timeline", "Wants a decision before the September board meeting", 24, { voiced_by_contact_id: "p1", ...said("We want a decision before the September board meeting", "Dana Whitfield", "meeting_held", CALL2) }),
  NOTE("n_buy1", "buying_signal", "Asked for annual pricing with onboarding as its own line", 2, { voiced_by_contact_id: "p3", ...said("Can you send annual pricing with onboarding broken out?", "Meera Raman", "email_received", MAIL1) }),
  NOTE("n_goal1", "goal", "Cut rep admin time so AEs get a full day a week back for selling", 24, { voiced_by_contact_id: "p1", ...said(null, "Dana Whitfield", "meeting_held", CALL2) }),
  NOTE("n_goal2", "goal", "One forecast number the CFO actually trusts", 29, { voiced_by_contact_id: "p3", ...said("I want one forecast number I actually trust", "Meera Raman", "meeting_held", CALL2) }),
  NOTE("n_budget1", "budget", "An efficiency budget this half that this could come out of", 24, { voiced_by_contact_id: "p3", ...said("There's an efficiency budget this half that this could come out of", "Meera Raman", "meeting_held", CALL2) }),
  NOTE("n_pain1", "pain", "Deal reviews run on anecdotes because the CRM is three weeks stale", 29, { voiced_by_contact_id: "p1", ...said(null, "Dana Whitfield", "meeting_held", CALL2) }),
  // A non-extraction document so the account's Notes tab has something to render.
  { id: "n_doc1", source: "fireflies", category: "general", label: null,
    content: "Security review call — Dana walked the infosec process; pilot is blocked on the questionnaire. Next step: SE joins the follow-up.",
    created_at: iso(21), confidence: null, metadata: { doc_type: "meeting", title: "Meridian security review call", date: iso(21) } },
];
// The 2-4 word label the extractor emits with every fact (ClaimTag shows it).
const MERIDIAN_NOTES = MERIDIAN_NOTES_RAW.map((n) => ({ ...n, label: MERIDIAN_LABELS[n.id] ?? n.label }));

const ROLE_MAP = { p1: ["champion", "supporter"], p3: ["economic_buyer", "neutral"], p4: ["decision_maker", "detractor"], p5: ["contact", "supporter"], p2: ["champion", "supporter"], p10: ["economic_buyer", "supporter"], p14: ["champion", "supporter"], p21: ["decision_maker", "supporter"], p17: ["decision_maker", "neutral"], p19: ["decision_maker", "neutral"] };

function companyNotes(companyId) {
  if (companyId === "c1") return MERIDIAN_NOTES;
  // Derive from the graph: each pat entry on this company (or its people) → one claim.
  const notes = [];
  let n = 0;
  for (const node of GRAPH.nodes) {
    if (node.t === 3) continue;
    const belongs = node.i === companyId || (node.t === 0 && node.co === companyId);
    if (!belongs) continue;
    for (const p of node.pat || []) {
      if (!p.evidence) continue;
      notes.push(NOTE(`${companyId}_n${n++}`, p.cat === "status_quo" ? "status_quo" : p.cat, p.evidence, 14 + n * 3, {
        ...(p.cat === "objection" ? { status: "open", hardness: "soft" } : {}),
        ...(p.cat === "competitor" ? { stance: "incumbent", entity: p.label.includes("Gong") ? "Gong" : "Clari" } : {}),
        ...(node.t === 0 ? { voiced_by_contact_id: node.i } : {}),
      }));
    }
  }
  return notes;
}

const ACT = (id, type, daysAgo, contactName) => ({
  id, activity_type: type, source: type.includes("linkedin") ? "linkedin" : type.includes("meeting") ? "calendar" : "gmail",
  created_at: iso(daysAgo), occurred_at: iso(daysAgo), contactName, subtitle: null, raw_data: null,
});

function companyActivity(companyId) {
  const people = CONTACTS.filter(c => c.company_id === companyId);
  if (!people.length) return [];
  const p0 = people[0];
  const name = `${p0.first_name} ${p0.last_name}`;
  const base = { c1: 3, c3: 1, c4: 2, c7: 2 }[companyId] ?? 6;
  const rows = [
    ACT(`${companyId}_a1`, "linkedin_message_sent", base, name),
    ACT(`${companyId}_a2`, "email_sent", base + 6, name),
    ACT(`${companyId}_a3`, "email_received", base + 14, name),
    ACT(`${companyId}_a4`, "meeting_held", base + 18, name),
    ACT(`${companyId}_a5`, "email_sent", base + 21, name),
  ];
  // The booked meetings in TASKS.meetings exist as future calendar activity too,
  // so the account's "Next calendar interaction" highlight agrees with My Studio.
  if (companyId === "c1") rows.unshift(ACT(`${companyId}_a0`, "meeting_scheduled", -1, name));
  if (companyId === "c3") rows.unshift(ACT(`${companyId}_a0`, "meeting_scheduled", -3, name));
  return rows;
}

export function companyDetail(companyId) {
  const co = COMPANIES.find(x => x.id === companyId);
  if (!co) return null;
  const people = CONTACTS.filter(c => c.company_id === companyId);
  const stakeholders = people.map(c => ({
    id: c.id, name: `${c.first_name} ${c.last_name}`, title: c.job_title, seniority: c.seniority,
    pipeline_stage: c.pipeline_stage, deal_health_score: co.deal_health_score, icp_score: c.icp_score,
    deal_value: c.deal_value, photo_url: null, last_activity_at: c.last_activity_at,
    signal_count: c.intent_score > 40 ? 5 : 1,
    sentiment: ROLE_MAP[c.id]?.[1] ?? null, role: ROLE_MAP[c.id]?.[0] ?? "contact",
  }));
  const stageRank = ["identified", "aware", "connected", "interested", "evaluating", "proposal", "negotiation", "onboarding", "client"];
  const stage = CS_BAGS[companyId]?.status === "client" ? "client"
    : people.reduce((s, c) => (stageRank.indexOf(c.pipeline_stage) > stageRank.indexOf(s) ? c.pipeline_stage : s), "identified");
  const ownerName = people.map(c => c.owner_name).find(Boolean) ?? ACCOUNT_OWNER[companyId] ?? null;
  const detail = {
    company: {
      id: co.id, name: co.name, domain: co.domain, pipeline_stage: stage,
      icp_score: co.icp_score, deal_value: null, owner_name: ownerName,
      memory_summary: co.memory_summary, summary_generated_at: iso(2),
      deal_health_score: co.deal_health_score, deal_health_computed_at: iso(1),
      industry: co.industry, employee_count: co.employee_count, location: co.location,
      revenue_range: co.revenue_range, tech_stack: null, enrichment_status: "enriched",
      last_activity_at: people.map(c => c.last_activity_at).filter(Boolean).sort().pop() ?? null,
    },
    icp: { score: co.icp_score, reason: "Fit derived from won-deal signals" },
    stakeholders,
    edges: companyId === "c1" ? [
      { subject_id: "p5", subject_label: "Alex Kim", relationship: "REPORTS_TO", object_id: "p1", object_label: "Dana Whitfield", confidence: 1, source: "manual", source_memory_id: null, metadata: { confidence_level: "confirmed" } },
      { subject_id: "p1", subject_label: "Dana Whitfield", relationship: "REPORTS_TO", object_id: "p3", object_label: "Meera Raman", confidence: 0.7, source: "extraction", source_memory_id: null, metadata: { confidence_level: "likely", fact: "Dana mentioned running the tooling decision past finance" } },
    ] : [],
    activity: companyActivity(companyId),
    notes: companyNotes(companyId),
    // Topics as packages/core intelTopics stores them: groups of claim ids per subject.
    intel_topics: companyId === "c1" ? [
      { label: "Security review timing", kind: "objection", summary: "Infosec must clear the tool before a pilot, and their reviews take about two weeks.", facts: [["n_obj1"], ["n_obj1b"]] },
      { label: "Price versus Gong", kind: "objection", summary: null, facts: [["n_obj2"]] },
    ] : [],
    signals: [],
    // The CRM's own customer-health bag (null for a prospect) and the record in HubSpot. The live
    // API sends hubspot_url null until the portal id is stored; here it shows what the link does.
    cs: CS_BAGS[companyId] ?? null,
    hubspot_url: `https://app.hubspot.com/contacts/10000001/record/0-2/${18200400000 + Number(companyId.slice(1))}`,
  };
  if (companyId === "c1") {
    detail.deal_health = {
      score: 38, band: "At risk",
      smart: [
        { key: "competitive_risk", label: "Competitive Risk", level: "High", tone: "bad", reason: "2 live competitors: Gong, Clari", evidence: ["n_comp1", "n_comp2"] },
        { key: "blocker_severity", label: "Blocker Severity", level: "Critical", tone: "bad", reason: "2 open objections (incl. a hard gate), 1 resolved", evidence: ["n_obj1", "n_obj2"] },
        { key: "buyer_urgency", label: "Buyer Urgency", level: "Moderate", tone: "warn", reason: "Stated a timeline but has gone quiet", evidence: ["n_tl1"] },
        { key: "decision_maker", label: "Decision-Maker Buy-In", level: "Moderate", tone: "warn", reason: "2 senior stakeholders, but quiet", evidence: [] },
      ],
      numeric: [
        { key: "last_response", label: "Last Response", value: "17d ago", tone: "bad" },
        { key: "engagement_trend", label: "Engagement", value: "Cooling", tone: "warn" },
        { key: "multi_threading", label: "Multi-threading", value: "1/4 engaged", tone: "bad" },
        { key: "response_time", label: "Buyer response", value: "6d median", tone: "warn" },
        { key: "meetings", label: "Meetings", value: "3 meetings", tone: "good" },
        { key: "buyer_emails", label: "Buyer Emails", value: "11 received", tone: "good" },
        { key: "outbound", label: "Outbound", value: "24 sent", tone: "good" },
      ],
    };
  }
  return detail;
}

// People a meeting note-taker created who have no CRM record linked (GET-788): the "Not in CRM" tag.
export const NOT_IN_CRM = new Set(["p2", "p5", "p9"]);

export function personRecord(contactId) {
  const c = CONTACTS.find(x => x.id === contactId);
  if (!c) return null;
  const co = COMPANIES.find(x => x.id === c.company_id);
  const detail = companyDetail(c.company_id);
  const memories = (detail?.notes ?? []).filter(n => n.metadata?.voiced_by_contact_id === contactId);
  if (contactId === "p1") {
    memories.push({ id: "doc_p1_m1", source: "fireflies", category: "general", label: null, content: "Security review call — Dana walked through the infosec process; pilot blocked on questionnaire.", created_at: iso(21), confidence: null, metadata: { doc_type: "meeting", title: "Meridian security review call", date: iso(21) } });
  }
  return {
    contact: { ...c, name: `${c.first_name} ${c.last_name}`, in_crm: !NOT_IN_CRM.has(c.id) },
    crm_connected: true,
    prediction: { score: c.icp_score, tier: c.icp_tier },
    company: co ? { name: co.name, domain: co.domain, industry: co.industry } : null,
    activities: detail?.activity ?? [],
    memories,
    signals: [],
  };
}

// ── Threads (Home) ───────────────────────────────────────────────────────────
// The same hash the app uses to turn a source's ref into the [cxxxx] token an answer cites.
const citeKey = (ref) => {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (Math.imul(h, 31) + ref.charCodeAt(i)) | 0;
  return `c${(Math.abs(h) % 1679616).toString(36).padStart(4, "0")}`;
};
const TH1_SOURCES = [
  { system: "Fireflies", detail: "Security review call with Dana Whitfield", when: iso(17), ref: "nous://evidence/fireflies/meridian-security-call", quote: "Our infosec team has to clear any tool that touches customer email before we can pilot it." },
  { system: "Gmail", detail: "Re: Infosec questionnaire", when: iso(19), ref: "nous://evidence/gmail/meridian-questionnaire" },
  { system: "Fireflies", detail: "Discovery call with Meridian", when: iso(21), ref: "nous://evidence/fireflies/meridian-discovery" },
  { system: "HubSpot", detail: "Meridian Analytics · Platform", when: iso(9), ref: "nous://evidence/hubspot/dl-01" },
];
const TH1_TOKENS = TH1_SOURCES.map(s => citeKey(s.ref));
// What the agent left for a person in th1: a draft to approve, and one change it made.
export const TH1_PENDING_ACTIONS = [
  { id: "pa1", kind: "email", recipient: "Dana Whitfield", recipient_email: "dana.whitfield@meridiananalytics.example", linkedin_url: null,
    subject: "Security questionnaire, and a pilot plan",
    body: "Hi Dana,\n\nThanks for the time last week. The security questionnaire pack is attached, with our data residency and retention answers filled in.\n\nIf it helps your infosec team, I can join a 30-minute call with them this week and walk through how we handle customer email.\n\nOnce they're comfortable, I'd suggest a two-week pilot with your enterprise team.\n\nAvery",
    rationale: "Dana said infosec has to clear the tool before a pilot, and the questionnaire is overdue.",
    status: "pending", message_id: "m2", created_at: iso(0.19) },
];
// Drafts waiting on the viewer's approval (GET-681), as GET /api/actions?status=pending&include=origin
// answers: each with the automation that wrote it (origin) and the account it is for. The Sales
// follow-up automation's drafts are the follow-up cards (FOLLOW_UPS), not rows here.
const draftAcct = (cid, person) => { const c = COMPANIES.find((x) => x.id === cid); return { id: c.id, name: c.name, domain: c.domain, person }; };
export const PENDING_DRAFTS = [
  { id: "pd1", kind: "email", entity_id: "p19", rec_id: null, thread_id: null, recipient: "Frank Delgado", recipient_email: "frank.delgado@redwoodins.example", linkedin_url: null,
    subject: "Picking the compliance review back up",
    body: "Hi Frank,\n\nIt has been a few weeks since we sent the compliance pack, and I know Susan's review was the open item.\n\nWould it help if I joined a 20-minute call with her this week to go through the data retention answers? If the timing has moved, just tell me and I'll check back after your quarter closes.\n\nAvery",
    rationale: "Health turned at risk overnight: no reply from Frank in 26 days, and the compliance review he was waiting on has stalled.",
    status: "pending", created_at: iso(0.08),
    origin: { source: "routine", name: "Deal risk detection", why: null, at: iso(0.08), run_id: "run-dr-1", routine_id: "rt-dr" },
    account: draftAcct("c10", "Frank Delgado") },
  { id: "pd2", kind: "email", entity_id: "p13", rec_id: "r3", thread_id: null, recipient: "Robert Hayes", recipient_email: "robert.hayes@beaconfin.example", linkedin_url: null,
    subject: "Pricing for the pilot, revised",
    body: "Hi Robert,\n\nWhen we last spoke you asked for pricing that fits a pilot rather than the full desk. I've put that together: 20 seats for one quarter, with the wealth desk as an option once budget opens.\n\nShall I send it over, or is it easier to walk through it on a short call?\n\nAvery",
    rationale: "Robert asked for pilot pricing on the last call and never got it; the deal has sat in Proposal sent since.",
    status: "pending", created_at: iso(0.2),
    origin: { source: "rec", name: "Stale deal detection", why: "Deal sat in Proposal sent for 38 days with no conversation.", at: iso(0.2), builtin: "stale_deal" },
    account: draftAcct("c6", "Robert Hayes") },
  { id: "pd3", kind: "email", entity_id: "p10", rec_id: null, thread_id: null, recipient: "Grace Okafor", recipient_email: "grace.okafor@atlashealth.example", linkedin_url: null,
    subject: "Seats for your CS team",
    body: "Hi Grace,\n\nOn Tuesday you mentioned the CS team keeps asking for access to the account notes. Happy to set up a short call with Ethan and whoever leads CS to see whether a second team makes sense, and what it would cost.\n\nAvery",
    rationale: "Grace asked on Tuesday's call whether the customer success team could get seats too.",
    status: "pending", created_at: iso(1.1),
    origin: { source: "routine", name: "Expansion signals", why: null, at: iso(1.1), run_id: "run-ex-1", routine_id: "rt-ex" },
    account: draftAcct("c4", "Grace Okafor") },
  { id: "pd4", kind: "linkedin_message", entity_id: "p12", rec_id: null, thread_id: null, recipient: "Yuki Tanaka", recipient_email: null, linkedin_url: "https://www.linkedin.com/in/yuki-tanaka-example",
    subject: null,
    body: "Hi Yuki, I know budget opens in January. Would a two-line summary of what the pilot would cover be useful to have ready for that conversation?",
    rationale: "Three weeks of silence on your highest-fit open deal; the blocker was budget timing, not fit.",
    status: "pending", created_at: iso(2.3),
    origin: { source: "play", name: "Deal rescue", why: null, at: iso(2.3), run_id: "wr-1" },
    account: draftAcct("c5", "Yuki Tanaka") },
];
export const TH1_AGENT_ACTIONS = [
  { id: "aa1", tool: "schedule_automation", summary: "Scheduled a weekly check on the security review", reason: "infosec reviews at Meridian take about two weeks",
    before_state: { from: null }, after_state: { to: "Mondays 09:00" }, undone_at: null, created_at: iso(0.19) },
];
export const THREADS = [
  { id: "th1", title: "Meridian security review prep", updated_at: iso(0), created_at: iso(1), routine: null, unseen: false },
  { id: "th2", title: "Who should I re-engage this week?", updated_at: iso(1), created_at: iso(2), routine: null, unseen: false },
];
export const THREAD_MESSAGES = {
  // The chat board (GET-613): a question naming an account, a traced answer with citations, an
  // email draft waiting on approval and one change the agent made, with its undo.
  th1: [
    { id: "m1", role: "user", content: "What's standing between us and signing Meridian Analytics this quarter? Then draft the follow-up for Dana.", created_at: iso(0.2), tool_calls: null },
    { id: "m2", role: "assistant", created_at: iso(0.19), duration_ms: 6100,
      // What to ask next (GET-649): the API lifts these out of the stored trace.
      suggestions: ["Create a task for the questionnaire", "Brief me for the infosec call", "Who else should be on this deal?"],
      trace: [
        { kind: "thinking", text: "Reading the account first, then what Dana said about the security review." },
        { kind: "tool", name: "get_account", input: { identifier: "meridiananalytics.example" }, status: "ok", duration_ms: 812, rows: 24, sources: TH1_SOURCES,
          subject: { kind: "company", name: "Meridian Analytics", domain: "meridiananalytics.example" } },
        { kind: "tool", name: "search", input: { query: "security review" }, status: "ok", duration_ms: 640, rows: 4, sources: [] },
        { kind: "tool", name: "propose_email", input: {}, status: "ok", duration_ms: 1200 },
        { kind: "tool", name: "schedule_automation", input: {}, status: "ok", duration_ms: 300 },
      ],
      content: `Two things stand in the way, and both are solvable this week.\n\n**Security sign-off.** Dana won't start the pilot until their infosec team clears any tool that touches customer email [${TH1_TOKENS[0]}], and the questionnaire pack is two days overdue on our side [${TH1_TOKENS[1]}]. That puts the pilot past the close date in the CRM.\n\n**Competition.** Gong is four weeks into a pilot with their enterprise team, but they dropped Chorus last year, so there is room to displace it [${TH1_TOKENS[2]}].\n\nI drafted the follow-up below and set a weekly check on the security review so it doesn't slip.`,
      tool_calls: [
        { name: "get_account", status: "ok", duration_ms: 812, rows: 24, input: { identifier: "meridiananalytics.example" }, sources: TH1_SOURCES },
        { name: "search", status: "ok", duration_ms: 640, rows: 4, input: { query: "security review" }, sources: [] },
        { name: "propose_email", status: "ok", duration_ms: 1200, input: {} },
        { name: "schedule_automation", status: "ok", duration_ms: 300, input: {} },
      ] },
  ],
  th2: [
    { id: "m3", role: "user", content: "Who should I re-engage this week?", created_at: iso(1), tool_calls: null },
    { id: "m4", role: "assistant", created_at: iso(1), content: "Ranked by fit × urgency:\n\n1. **Redwood Insurance** — ICP 78, 26 days quiet mid-security-review. Went dark, not lost.\n2. **Juniper Labs** — your highest-fit open account (88), three weeks of silence. Budget opens in January; keep warm.\n3. **Vantage Legal** — Nina asked for the AI-policy one-pager *and* pricing in the same week. That's a buying signal — send both today.\n4. **Beacon Financial** — 38 days quiet, but the objection was budget timing, not fit. A light check-in beats silence.", tool_calls: [
      { name: "pipeline", status: "ok", duration_ms: 640, rows: 12, sources: [{ system: "Nous", detail: "portfolio scan", when: iso(1), derived: true }] },
    ]},
  ],
};

export const SKILLS = { skills: [
  { name: "meeting-brief", description: "Everything you need before a call, in one read", est_cost_usd: 0.04 },
  { name: "re-engage", description: "Rank cooling accounts and draft the outreach", est_cost_usd: 0.06 },
  { name: "account-deep-dive", description: "The full story of one account", est_cost_usd: 0.05 },
]};

// ── Misc surfaces ────────────────────────────────────────────────────────────
export const NOTIFICATIONS = {
  notifications: [
    { id: "nt1", workspace_id: WS, user_id: "u1", type: "follow_up_reminder", document_id: null, document_name: null, share_token: null, from_contact_id: "p1", from_contact_name: "Dana Whitfield", from_contact_email: "dana.whitfield@meridiananalytics.example", status: "pending", is_read: false, is_archived: false, created_at: iso(0.5), read_at: null, archived_at: null, metadata: { prospect_name: "Dana Whitfield", pre_filled_prompt: "Draft a follow-up to Dana Whitfield about the security questionnaire" } },
    { id: "nt2", workspace_id: WS, user_id: "u1", type: "weekly_report", document_id: null, document_name: "Weekly revenue intelligence", share_token: null, from_contact_id: null, from_contact_name: null, from_contact_email: null, status: "sent", is_read: true, is_archived: false, created_at: iso(2), read_at: iso(1), archived_at: null, metadata: { report_id: "r1" } },
  ],
  unreadCount: 1,
};

export const ACTIVITY_STATS = { conversations: 86, replies: 41, reply_rate: 0.48, meetings_held: 9, meetings_booked: 4, people_touched: 63 };

export const SYSTEM_LOG = {
  events: [
    { id: "e1", occurred_at: iso(0.1), source: "mcp", event_type: "v2.context", metadata: {}, summary: "get_context — focus=dana.whitfield@meridiananalytics.example intent=meeting_prep" },
    { id: "e2", occurred_at: iso(0.3), source: "web", event_type: "v2.query", metadata: {}, summary: "query — re-engagement candidates" },
    { id: "e3", occurred_at: iso(0.6), source: "mcp", event_type: "v2.account.get", metadata: {}, summary: "get_account — Redwood Insurance" },
    { id: "e4", occurred_at: iso(1.1), source: "api", event_type: "v2.pipeline", metadata: {}, summary: "pipeline portfolio read" },
    { id: "e5", occurred_at: iso(1.4), source: "sdk", event_type: "v2.observations.write", metadata: {}, summary: "record — meeting summary on Cobalt" },
    { id: "e6", occurred_at: iso(2.2), source: "mcp", event_type: "v2.attention", metadata: {}, summary: "attention — workspace sweep" },
  ],
  total: 6,
};
export const SYSTEM_LOG_STATS = { allTime: 5214, inRange: 612, failed: 4, system: 380, agent: 232 };

export const ADOPTION = {
  days: 90, total: 428,
  use_cases: [
    { key: "meeting_prep", label: "Meeting prep", count: 124, pct: 29 },
    { key: "account_research", label: "Account research", count: 108, pct: 25.2 },
    { key: "follow_up", label: "Follow-up & attention", count: 84, pct: 19.6 },
    { key: "outreach", label: "Outreach drafting", count: 62, pct: 14.5 },
    { key: "pattern_analysis", label: "Pattern & pipeline analysis", count: 50, pct: 11.7 },
  ],
  trend: [0, 1, 2, 3, 4, 5].map(w => ({ week: new Date(Date.now() - (5 - w) * 7 * DAY).toISOString().slice(0, 10), total: 50 + w * 12, meeting_prep: 16 + w * 4, account_research: 14 + w * 3, follow_up: 10 + w * 2, outreach: 6 + w * 2, pattern_analysis: 4 + w })),
  surfaces: [
    { key: "mcp", label: "Claude Code", count: 236 },
    { key: "web", label: "Threads", count: 148 },
    { key: "sdk", label: "Your agents", count: 44 },
  ],
  members: [
    { user_id: "u2", name: "Jordan Reyes", avatar: null, ops: 182, last_activity: iso(0.2), mix: { meeting_prep: 61, account_research: 48, follow_up: 39, outreach: 22, pattern_analysis: 12 }, surfaces: { mcp: 120, web: 62 } },
    { user_id: "u3", name: "Imogen Farrow", avatar: null, ops: 165, last_activity: iso(0.4), mix: { meeting_prep: 48, account_research: 41, follow_up: 30, outreach: 31, pattern_analysis: 15 }, surfaces: { mcp: 84, web: 70, sdk: 11 } },
    { user_id: "u1", name: "Avery Castellan", avatar: null, ops: 81, last_activity: iso(1), mix: { pattern_analysis: 23, account_research: 19, meeting_prep: 15, follow_up: 15, outreach: 9 }, surfaces: { mcp: 32, web: 16, sdk: 33 } },
  ],
  dormant: [], unattributed: 12, excluded: 3400,
};

export const INSIGHT_THEMES = {
  themes: [
    { id: "t1", title: "Security review is the enterprise gate", takeaway: "Build a standing security pack — every enterprise deal stalls on the questionnaire.", category: "market", categoryLabel: "Market", count: 6, status: "new", rank: 0, firstSeen: iso(48), lastSeen: iso(3), items: [
      { id: "i1", statement: "Infosec must clear tools touching customer email", quote: "Our infosec team has to clear any tool that touches customer email before we can pilot it.", speaker: "Dana Whitfield", speakerId: "p1", date: iso(17), occurred_at: iso(17) },
      { id: "i2", statement: "Vendor security assessment required before pilots", quote: "Anything reading our mailboxes goes through a vendor security assessment first.", speaker: "Jack Morrison", speakerId: "p17", date: iso(12), occurred_at: iso(12) },
    ]},
    { id: "t2", title: "Buyers frame us against Gong, not CRMs", takeaway: "Lead with the context-layer difference — recording is the commodity, the substrate isn't.", category: "positioning", categoryLabel: "Positioning", count: 4, status: "new", rank: 1, firstSeen: iso(40), lastSeen: iso(6), items: [
      { id: "i3", statement: "Gong pilots keep appearing mid-deal", quote: "We're four weeks into a Gong pilot on the enterprise team.", speaker: "Dana Whitfield", speakerId: "p1", date: iso(21), occurred_at: iso(21) },
    ]},
    { id: "t3", title: "Budget cycles push decisions to January", takeaway: "Q4 outreach should sell the January line item, not the December signature.", category: "market", categoryLabel: "Market", count: 3, status: "new", rank: 2, firstSeen: iso(30), lastSeen: iso(8), items: [
      { id: "i4", statement: "No budget line until January planning", quote: "There's no line item for this until the January planning cycle.", speaker: "Yuki Tanaka", speakerId: "p12", date: iso(21), occurred_at: iso(21) },
    ]},
  ],
  total: 3,
};

// ── Mind / Intelligence page ─────────────────────────────────────────────────
const PRED = (id, entityId, score, disposition, predDays, resDays) => {
  const c = CONTACTS.find(x => x.id === entityId);
  return {
    id, entity_id: entityId, name: c ? `${c.first_name} ${c.last_name}` : null, company: c?.company ?? null,
    email: c?.email ?? null, score, fit: score >= 70 ? "strong" : score >= 40 ? "possible" : "weak",
    predicted_at: iso(predDays), resolved_at: resDays == null ? null : iso(resDays),
    outcome_score: disposition === "won" ? 1 : disposition == null ? null : 0,
    disposition, replied: score > 50, fired: [],
  };
};
export const SUBSTRATE = {
  observations: { total: 4820, last_7d: 312, by_source: [{ source: "gmail", count: 2100 }, { source: "linkedin", count: 1240 }, { source: "fireflies", count: 680 }, { source: "instantly", count: 520 }, { source: "calendar", count: 280 }] },
  claims: { total: 1289, freshness: { fresh: 704, aging: 356, suspect: 148, expired: 81 }, epistemic: { observed: 812, inferred: 302, predicted: 98, asserted: 77 } },
  recompute: { pending: 3 },
  predictions: { total: 164, open: 118, resolved: 46, won: 18, lost: 21, fit: 164, by_kind: { icp_fit: 164 } },
  calibration: { resolved: 46, gap: 0.31, high: { count: 21, avg_outcome: 0.62 }, low: { count: 25, avg_outcome: 0.21 }, trend: [4, 3, 2, 1, 0].map(w => ({ week: new Date(Date.now() - w * 7 * DAY).toISOString().slice(0, 10), n: 8 + w, gap: 0.22 + w * 0.03 })) },
  top_signals: [
    { key: "revops_team", label: "Has a RevOps function", weight: 3, fires: 41, hits: 15, hit_rate: 0.37, lift: 2.4, sample: 41 },
    { key: "tool_consolidation", label: "Actively consolidating GTM tools", weight: 3, fires: 28, hits: 11, hit_rate: 0.39, lift: 2.6, sample: 28 },
    { key: "midmarket_size", label: "50-500 employees", weight: 2, fires: 66, hits: 17, hit_rate: 0.26, lift: 1.7, sample: 66 },
    { key: "forecast_pain", label: "Forecast accuracy pain voiced", weight: 2, fires: 22, hits: 8, hit_rate: 0.36, lift: 2.3, sample: 22 },
    { key: "spreadsheet_stack", label: "Runs GTM on spreadsheets", weight: 1, fires: 18, hits: 4, hit_rate: 0.22, lift: 1.4, sample: 18 },
  ],
  recent_predictions: [
    PRED("pr1", "p10", 88, "won", 80, 34), PRED("pr2", "p2", 81, null, 12, null),
    PRED("pr3", "p14", 72, null, 18, null), PRED("pr4", "p13", 86, "lost", 70, 25),
    PRED("pr5", "p16", 51, "no_opportunity", 60, 30), PRED("pr6", "p12", 88, null, 25, null),
    PRED("pr7", "p19", 78, null, 30, null), PRED("pr8", "p1", 84, null, 40, null),
    PRED("pr9", "p21", 66, null, 10, null), PRED("pr10", "p6", 75, "won", 90, 48),
    PRED("pr11", "p22", 24, "won", 55, 20), PRED("pr12", "p9", 39, "no_opportunity", 50, 22),
  ],
  // Misses mirror the production endpoint: a subset of recent_predictions
  // (same ids) that satisfy (score >= 70 && outcome < 0.3) || (score < 30 && outcome > 0.7).
  misses: [PRED("pr4", "p13", 86, "lost", 70, 25), PRED("pr11", "p22", 24, "won", 55, 20)],
  attention: [],
};
export const SCORECARD = { signals: [
  { id: "s1", key: "revops_team", label: "Has a RevOps function", weight: 3, coverage: 0.7, active: true },
  { id: "s2", key: "tool_consolidation", label: "Actively consolidating GTM tools", weight: 3, coverage: 0.5, active: true },
  { id: "s3", key: "midmarket_size", label: "50-500 employees", weight: 2, coverage: 0.9, active: true },
  { id: "s4", key: "forecast_pain", label: "Forecast accuracy pain voiced", weight: 2, coverage: 0.4, active: true },
  { id: "s5", key: "spreadsheet_stack", label: "Runs GTM on spreadsheets", weight: 1, coverage: 0.3, active: true },
  { id: "s6", key: "no_ai_policy", label: "No internal AI policy", weight: -2, coverage: 0.3, active: true },
  { id: "s7", key: "regulated_industry", label: "Heavily regulated industry", weight: -1, coverage: 0.4, active: true },
  { id: "s8", key: "solo_founder", label: "Sub-20 headcount", weight: -2, coverage: 0.2, active: true },
]};
export const SCORECARD_RUNS = { runs: [
  { id: "r1", target: "icp_fit", steps: 4, gap_before: 0.38, gap_after: 0.31, signal_count: 8, note: "raised tool_consolidation to +3 after two wins carried it", created_at: iso(6) },
  { id: "r2", target: "icp_fit", steps: 3, gap_before: 0.41, gap_after: 0.38, signal_count: 8, note: "kept weights — sample too small to move", created_at: iso(13) },
  { id: "r3", target: "icp_fit", steps: 5, gap_before: 0.5, gap_after: 0.41, signal_count: 7, note: "added no_ai_policy as a negative after three stalls", created_at: iso(27) },
]};
export const CONTEXT_CHANGES = { changes: [
  { category: "ICP", from: "Mid-market B2B SaaS, 50-500 employees", to: "Mid-market B2B with a RevOps function, 50-500 employees", at: iso(6), source: "agent" },
  { category: "Positioning", from: "AI meeting intelligence", to: "The context graph for GTM agents", at: iso(20), source: "playbook" },
  { category: "Competitors", from: "Gong, Chorus", to: "Gong, Clari (forecasting wedge)", at: iso(27), source: "agent" },
]};
export const WORKSPACE_MEMORIES = { memories: [
  { id: "wm1", category: "ICP", content: "Mid-market B2B with a RevOps function, 50-500 employees, active tool consolidation", created_at: iso(6), confidence: 0.95, subject: "icp", reaffirmed_at: iso(2), source: "playbook", metadata: {} },
  { id: "wm2", category: "Market", content: "Buyers benchmark us against Gong; the wedge is the substrate, not recording", created_at: iso(20), confidence: 0.9, subject: "market", reaffirmed_at: null, source: "agent", metadata: {} },
  { id: "wm3", category: "Pricing", content: "Per-seat pricing meets resistance when Gong is already paid for — lead with consolidation math", created_at: iso(21), confidence: 0.85, subject: "pricing", reaffirmed_at: null, source: "agent", metadata: {} },
  { id: "wm4", category: "Competitors", content: "Clari owns the forecast call in manufacturing/insurance; displace via what it misses", created_at: iso(27), confidence: 0.85, subject: "competitors", reaffirmed_at: null, source: "agent", metadata: {} },
  { id: "wm5", category: "Positioning", content: "The context graph for GTM agents — one account record any agent reads in a single call", created_at: iso(30), confidence: 0.95, subject: "positioning", reaffirmed_at: iso(5), source: "playbook", metadata: {} },
  { id: "wm6", category: "GTM Motion", content: "Founder-led outbound + Claude Code agents; meetings booked via warm LinkedIn", created_at: iso(35), confidence: 0.9, subject: "gtm", reaffirmed_at: null, source: "onboarding", metadata: {} },
]};

// ── Account-level ICP record (mind/account/:id) ──────────────────────────────
export function icpRecord(entityId) {
  const c = CONTACTS.find(x => x.id === entityId) ?? CONTACTS.find(x => x.company_id === entityId);
  if (!c) return null;
  return {
    account: { entity_id: entityId, name: `${c.first_name} ${c.last_name}`, email: c.email, company: c.company },
    icp: { current: { id: "cur", score: c.icp_score, fit: c.icp_score >= 70 ? "strong" : "possible", reason: "RevOps function present; consolidation signals fired", scored_at: iso(2), rescored: false, resolved_at: null, disposition: null, outcome_score: null, learned: null }, history: [] },
    company: { what_they_do: COMPANIES.find(x => x.id === c.company_id)?.memory_summary ?? null, industry: COMPANIES.find(x => x.id === c.company_id)?.industry ?? null, company_type: "b2b", size_band: "51-200", funding_stage: null, country: "US", target_market: "mid-market", pricing_model: null, recently_funded: false, product: [], tech: [], hiring: [], compliance: [] },
    pipeline: { n_touches: 24, n_meetings: 3, n_emails: 14, n_linkedin: 7, n_replies: 6, first_touch_at: iso(80), last_touch_at: c.last_activity_at, lead_source: "linkedin", first_touch_type: "linkedin_message", stage: c.pipeline_stage },
  };
}

// ── Workspace-level singletons ───────────────────────────────────────────────
export const ME = {
  user: { id: "u1", email: "avery@opennous.example", name: "Avery Castellan", profile_picture_url: null, is_admin: false },
  team: { id: "team-preview", name: "Nous" },
  workspace: { id: WS, name: "Nous", icon: null, business_type: "software", country: "US" },
  onboarding_completed: true, is_founder: true, workspace_role: "admin",
  trial: { is_active: false, ends_at: null }, billing_enabled: true, plan_enforcement: false,
  self_hosted: false, app_commit: null,
};
export const USAGE = {
  plan: "headless", planName: "Headless", selfHosted: false,
  subscription: { status: "active", current_period_start: iso(20), current_period_end: isoIn(10), cancel_at_period_end: false, stripe_subscription_id: "sub_preview" },
  activeAccounts: { used: 12, included: null, remaining: null, percentUsed: 0, state: "ok", graceUntil: null },
  ops: { used: 612, included: null, remaining: null, periodStart: iso(20), allTime: 5214, metered: false },
  enrichments: { used: 0, included: 0, remaining: 0 },
  workspaces: { current: 1, limit: 3 }, currentWorkspaceId: WS,
};
export const BILLING_STATE = {
  billing_disabled: false, self_hosted: false, plan: "headless", planName: "Headless",
  subscription: { status: "active", current_period_start: iso(20), current_period_end: isoIn(10), trial_ends_at: null, cancel_at_period_end: false, stripe_subscription_id: "sub_preview", is_comp: true },
  activeAccounts: { used: 12, included: null, remaining: null, percentUsed: 0, state: "ok", graceUntil: null },
  accounts: { used: 12, included: null, remaining: null, percentUsed: 0, state: "ok", graceUntil: null },
  enrichments: null,
  allPlans: [
    { id: "api", name: "API", monthlyPriceUsd: 99, activeAccountsLimit: 250, enrichmentsPerMonth: 0, workspaceLimit: 1, features: { inAppAgent: false, insights: false } },
    { id: "headless", name: "Headless", monthlyPriceUsd: null, activeAccountsLimit: null, enrichmentsPerMonth: 0, workspaceLimit: 3, features: { inAppAgent: true, insights: true } },
  ],
};
export const ONBOARDING_STATUS = { onboarded: true, hasIcp: true, connected: true, hasSource: true, sourceCount: 3, accountCount: 12, icpTrained: true, tourCompleted: true, website: "opennous.example" };
export const OPS_BREAKDOWN = { periodStart: iso(20), total: 612, billed: 240, free: 372, retrieval: [
  { eventType: "v2.context", label: "get_context", count: 124, billed: true },
  { eventType: "v2.account.get", label: "get_account", count: 61, billed: true },
  { eventType: "v2.query", label: "query", count: 38, billed: true },
  { eventType: "v2.attention", label: "attention", count: 17, billed: true },
]};

// ── Insights board (/api/insights/board) ─────────────────────────────────────
// Placed insights in the compact array shape the real endpoint ships, plus the nightly row
// summaries. Deterministic so a screenshot today matches one tomorrow.
export const INSIGHT_BOARD = (() => {
  const lanes = [
    { key: "product", label: "Product" }, { key: "sales", label: "Sales" },
    { key: "success", label: "Customer success" }, { key: "market", label: "Market" },
  ];
  const subtypes = [
    ["bug", "product", "Bug"], ["friction", "product", "Friction"], ["feature", "product", "Feature request"],
    ["objection", "sales", "Objection"], ["pricing", "sales", "Pricing"], ["pitch", "sales", "Pitch & messaging"],
    ["setup", "success", "Setup"], ["training", "success", "Training & adoption"],
    ["partners", "market", "Competitors & partners"], ["buyers", "market", "Who buys"],
  ].map(([key, lane, label]) => ({ key, lane, label }));
  const companies = ["Ashcombe Freight", "Tellmark Clinics", "Brightwater Legal", "Quillon Retail", "Sablewood Insurance",
    "Corrin Analytics", "Northfold Media", "Pellow Manufacturing", "Ostrey Software", "Fenwick Dental Partners", "Galloway Foods", "Marrow Lane Credit Union"];
  const money = [[1, 14000, 0], [1, 12000, 5000], [1, 10000, 0], [1, 18000, 0], [0, 0, 18000], [0, 0, 12000],
    [1, 12000, 0], [0, 0, 12000], [0, 0, 12000], [1, 9000, 0], [1, 6000, 12000], [0, 0, 0]];
  const speakers = ["Dana Whitfield", "Marco Ruiz", "Imogen Farrow", "Tom Becker", "Lena Hofmann", "Sam Okafor", "Chris Lang"];
  // [tagId, tagName, subtype, count, headline | null, problems[[title, detail]], statements, quotes]
  const topics = [
    ["t1", "Browser extension", "bug", 6, "The browser extension fails to install on managed laptops and has no Firefox build",
      [["No Firefox build", "The extension only ships for Chrome, so teams on Firefox cannot use it."], ["Install loops", "It asks users to reinstall the extension when it is already installed."], ["Contact export incomplete", "Phone numbers and job titles never reach the CRM after export."]],
      ["The extension doesn't work on Firefox", "The extension keeps asking to be reinstalled", "Job titles are missing in the CRM after export"],
      ["Half my team is on Firefox. For them it just isn't there.", "It keeps telling me to install it. It's installed."]],
    ["t2", "Alert emails", "bug", 7, "Alert emails arrive late or not at all, so hot accounts go unworked",
      [["Emails arrive late or not at all", "Alert and reply emails are intermittent, so teams ask for an SMS backup."]],
      ["Alert emails stopped arriving", "We only saw the reply in the app the next day"],
      ["We saw the reply a day later. By then they'd signed with someone else."], 30],
    ["t3", "CRM integration", "bug", 5, "The CRM shows as connected, but contacts and full records never sync",
      [["Connected but empty", "The integration reports connected while contacts never appear in the CRM."], ["Records arrive partial", "Contact records land without the company they belong to."]],
      ["Contacts aren't reaching our CRM even though it says connected", "Contacts come through missing their company"],
      ["It's green, it says connected, and there's nothing in there."]],
    ["t4", "ERP order sync", "bug", 4, "Order history from the ERP never reaches the CRM",
      [["Orders missing", "New orders in the ERP do not show up for the account team."]],
      ["ERP orders aren't syncing to the CRM"],
      ["Our ERP orders just aren't there."]],
    ["t4b", "Lead deduplication", "bug", 3, "Form fills create duplicate leads and contacts instead of merging them",
      [["Duplicates from repeat submissions", "A demo request followed by a trial signup creates two leads."]],
      ["Every prospect shows up twice after they start a trial"],
      ["Now I've got two of every prospect."]],
    ["t4c", "SSO login", "bug", 2, null, [], ["SSO login times out on mobile"], []],
    ["t5", "Bulk actions", "friction", 14, "Updating many accounts means clicking into each one",
      [["No multi-select on lists", "Owners and stages can only be changed one account at a time."], ["Exports need a filter first", "There is no export of the current view."]],
      ["Reassigning twenty accounts took an afternoon", "No way to change stage on several deals at once"],
      ["I just want to select them all and move them to Jordan."]],
    ["t6", "Call summaries", "friction", 9, "Call summaries are too long to read before the next meeting",
      [["Summaries bury the next step", "The agreed next step sits at the bottom of a long summary."]],
      ["The summary is longer than my notes", "Next steps are hard to find in the summary"],
      ["I read the first paragraph and then I'm on the next call."]],
    ["t7", "Event badge scanning", "feature", 16, "Field teams want to capture booth visitors by scanning their badge",
      [["Booth visits are not captured", "Conference conversations never reach the record unless a rep types them in."], ["A scan should start the follow-up", "The scan should trigger the follow-up sequence automatically."]],
      ["They want to scan badges at the booth", "Booth visits should create an activity automatically"],
      ["If we could scan badges at the booth we'd finally know who stopped by.", "Badge scanning would save my SDR team an hour a day."]],
    ["t8", "Slack alerts", "feature", 8, "Managers want a Slack ping when a big deal goes quiet",
      [["No alert on stalled deals", "Nobody hears that a large deal has gone quiet until the weekly review."]],
      ["Send a Slack message when a top deal has no activity for a week"],
      ["Tell me in Slack, I don't open another dashboard."]],
    ["t9", "Price vs incumbent", "objection", 13, "Buyers say they already pay for a tool that does most of this",
      [["Overlap with the CRM's own AI", "They believe the CRM's built-in assistant covers it."], ["Switching cost", "They worry about the time to move reps over."]],
      ["They think Salesforce Einstein already does this", "Worried about retraining the reps"],
      ["We already pay for Einstein, why would we pay twice?"]],
    ["t10", "Per-seat pricing", "pricing", 10, "Per-seat pricing feels expensive for part-time users",
      [["Managers pay for a full seat", "Managers who only read reports pay the same as reps."]],
      ["Managers should have a cheaper read-only seat", "Seat price is high for occasional users"],
      ["My VP logs in once a week, I'm not paying a full seat for that."]],
    ["t11", "Integrations to switch on", "setup", 12, "Connecting the phone system takes a call with support",
      [["Phone system needs an admin", "The telephony connector needs an admin key the buyer does not have."], ["Unclear which inbox to connect", "Teams are unsure whether to connect personal or shared inboxes."]],
      ["Couldn't connect the phone system without our IT admin", "Not sure which mailbox to connect first"],
      ["I sat on hold with our phone vendor for an hour to get a key."]],
    ["t12", "Rep adoption", "training", 7, "Reps stop opening the app after the first two weeks",
      [["No habit after onboarding", "Usage drops once the onboarding calls end."]],
      ["The reps stopped logging in after week two"],
      ["They loved it the first week and then went back to spreadsheets."]],
    ["t13", "Gong", "partners", 9, "Gong comes up in most evaluations as the incumbent",
      [["Already recording calls", "They already record every call in Gong and ask what we add."]],
      ["They already use Gong for call recording"],
      ["Gong has all our calls already."]],
    ["t14", "Multi-site buyers", "buyers", 8, "Parent companies buy centrally but each site decides on use",
      [["Group buys, site adopts", "The parent company signs, each site lead decides if it is used."]],
      ["The parent company signs but each site lead decides"],
      ["Head office bought it, but it's my site."]],
  ];
  const tags = topics.map(([id, name]) => ({ id, name, definition: null }));
  const items = [], rows = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const [tagId, , sub, count, headline, problems, statements, quotes, recentDays] of topics) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = `${tagId}-${i}`;
      const day = new Date(Date.now() - Math.floor(rnd() * (recentDays ?? 150)) * DAY).toISOString().slice(0, 10);
      const co = Math.floor(rnd() * companies.length);
      items.push([id, statements[i % statements.length], quotes.length && i % 2 === 0 ? quotes[(i / 2) % quotes.length] : null,
        speakers[Math.floor(rnd() * speakers.length)], day, sub, tagId, co, `call-${co}-${day}`]);
      ids.push(id);
    }
    if (headline) rows.push({
      subtype: sub, tagId, headline,
      problems: problems.map(([title, detail], p) => ({ title, detail, item_ids: ids.filter((_, i) => i % problems.length === p) })),
      receiptIds: ids.slice(0, 3),
    });
  }
  return { ready: true, lanes, subtypes, tags, companies, domains: companies.map(() => null), money, items, rows, waiting: 4 };
})();

// ── Follow-up cards (/api/follow-ups, and Home's "Follow-ups ready") ───────────
// GET /api/follow-ups rows, field for field (routes/api/followUps.mjs shapeCard). Three cards, one
// per state the design has to show: a MERGED card (two meetings, a task already on Tasks, and one
// the later call dropped, with why), a "which deal?" question across two open deals, and a
// "Deal change required" flag. The server keeps a mutable copy so approve, skip and the deal
// answer stick for the session.
const FU_DEAL_URL = (dealId) => `https://app.hubspot.com/contacts/10000001/record/0-3/${18300500000 + Number(String(dealId).replace(/\D/g, ""))}`;
/** What HubSpot says about a deal, as the route reads it from the deal list. */
export function followUpCrm(dealId) {
  const d = DEALS.find((x) => x.id === dealId);
  return d ? { deal: d.name, stage: d.stage, amount: d.value, close_date: String(d.close_date).slice(0, 10), url: FU_DEAL_URL(d.id) } : null;
}
// Write-back (Phase 4) is on in the preview so the "Sync to HubSpot" button shows; PREVIEW_WRITEBACK=off
// brings back the plain Approve.
export const FU_WRITEBACK = process.env.PREVIEW_WRITEBACK !== "off";
const FU_ROW = ({ id, companyId, dealId = null, reviewer, meetings, summary, tasks, updates, email, attribution = null, dealChange = null, createdHoursAgo }) => {
  const co = COMPANIES.find((x) => x.id === companyId);
  const created = new Date(Date.now() - createdHoursAgo * 3600_000).toISOString();
  return {
    id, status: "ready", account: { id: co.id, name: co.name, domain: co.domain },
    deal_id: dealId, reviewer_name: reviewer, meetings,
    summary, tasks, updates, email, attribution,
    deal_change: dealChange ? { ...dealChange, url: FU_DEAL_URL(dealChange.deal_id ?? dealId) } : null,
    insights: [],
    crm: dealId ? followUpCrm(dealId) : null,
    created_at: created, updated_at: created, decided_at: null, verdict: null,
    hubspot_url: dealId ? FU_DEAL_URL(dealId) : null,
    writeback: FU_WRITEBACK,
  };
};
const FU_AT = (days, h, m = 0) => { const d = new Date(Date.now() + days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };

export const FOLLOW_UPS = [
  // MERGED: a demo, then a scoping call three days later, folded into one card. The later call
  // made one of the demo's tasks moot, and the call scorer already filed another.
  FU_ROW({
    id: "fu-cobalt", companyId: "c3", dealId: "dl-03", reviewer: "Avery Castellan", createdHoursAgo: 20,
    meetings: [
      { key: "fathom:cob-demo", source: "fathom", kind: "Demo", title: "Cobalt data team demo", at: FU_AT(-4, 14), observation_id: null },
      { key: "fathom:cob-scope", source: "fathom", kind: "Call", title: "Cobalt pilot scoping call", at: FU_AT(-1, 11), observation_id: null },
    ],
    summary: "Demo for the data team, then a scoping call with Marcus. The pilot starts with RevOps only, and the data team add-on waits until week three.",
    tasks: [
      { id: "t1", text: "Write up the three pilot metrics Marcus agreed to", due: day(1), due_phrase: "tomorrow", on: true, quote: "If we hit those three numbers, we roll it out to the whole team.", stated_by: "them", owed_by: null },
      { id: "t2", text: "Send Lena the RevOps sandbox login before kickoff", due: day(2), due_phrase: "before kickoff", on: true, quote: "Lena needs to be in the sandbox before we kick off.", stated_by: "them", owed_by: null },
      { id: "t3", text: "Book the week-two check-in with Marcus and Lena", due: day(12), due_phrase: "week two", on: true, quote: null, stated_by: "us", owed_by: null },
      { id: "t4", text: "Share the ROI model with Marcus before kickoff", due: null, on: true, existing: true },
      { id: "t5", text: "Send the data team add-on pricing to Lena", due: null, on: false, quote: "Can you send pricing for the data team piece?", stated_by: "them",
        dropped: "The scoping call moved the data team add-on to week three of the pilot, so its pricing can wait." },
    ],
    updates: [
      { id: "u1", label: "Next step", value: "Pilot kickoff this week, with the three success metrics agreed in writing first", on: true, quote: "Let's lock the metrics before we kick off.", speaker: "Marcus Bell" },
      { id: "u2", label: "Note", value: "Data team add-on deferred to week three of the pilot", on: true, quote: "The data team can join in week three.", speaker: "Marcus Bell" },
      { id: "u3", label: "Decision maker", value: "Marcus Bell, CRO, signs the pilot", on: false, quote: null, speaker: null },
    ],
    email: {
      to: ["marcus.bell@cobaltsystems.example", "lena.fischer@cobaltsystems.example"],
      subject: "Pilot metrics and next steps",
      body: "Hi Marcus, hi Lena,\n\nThanks for the time on the demo and again yesterday. Here is where we landed:\n\n1. The pilot starts with RevOps only. The data team joins in week three.\n2. We measure three things: forecast accuracy, time to update the pipeline, and rep adoption. I'll send the written definitions tomorrow.\n3. Lena gets sandbox access before kickoff so the team can try it on real deals.\n\nI'll send an invite for the week-two check-in shortly.\n\nBest,\nAvery",
    },
  }),
  // WHICH DEAL: one call covered both of Summit's open deals.
  FU_ROW({
    id: "fu-summit", companyId: "c9", dealId: null, reviewer: "Imogen Farrow", createdHoursAgo: 26,
    meetings: [{ key: "gong:summit-1", source: "gong", kind: "Call", title: "Summit forecasting follow-up", at: FU_AT(-1, 15), observation_id: null }],
    summary: "Olivia walked through the forecasting rollout and the Plant 2 pilot on one call. The security assessment is still the gate for both.",
    tasks: [
      { id: "t1", text: "Send the security assessment pack to Olivia", due: day(3), due_phrase: "by Thursday", on: true, quote: "We can't move until security has the pack.", stated_by: "them", owed_by: null },
      { id: "t2", text: "Ask Jack who owns the Plant 2 budget", due: null, on: true, quote: null, stated_by: "us", owed_by: null },
    ],
    updates: [
      { id: "u1", label: "Next step", value: "Security assessment pack to Olivia this week", on: true, quote: "Send it to me and I'll walk it over to security.", speaker: "Olivia Grant" },
    ],
    email: {
      to: ["olivia.grant@summitmfg.example"],
      subject: "Security pack and Plant 2",
      body: "Hi Olivia,\n\nThanks for walking me through both projects. I'll have the security assessment pack to you by Thursday so it can go to your team.\n\nFor Plant 2, could you point me to whoever holds the budget? Happy to set up a short call with them.\n\nBest,\nImogen",
    },
    attribution: {
      question: "This call covered two open deals. Which one should it be filed on?",
      options: [
        { id: "dl-07", name: "Forecasting", value: 30000, stage: "Demo completed" },
        { id: "dl-14", name: "Plant 2", value: 16000, stage: "Demo booked" },
      ],
      chosen: null,
    },
  }),
  // DEAL CHANGE: the buyer said the paper is signed; HubSpot still says Committed. A flag, never an action.
  FU_ROW({
    id: "fu-halcyon", companyId: "c7", dealId: "dl-19", reviewer: "Imogen Farrow", createdHoursAgo: 3,
    meetings: [{ key: "fathom:halcyon-ck", source: "fathom", kind: "Check-in", title: "Halcyon store analytics check-in", at: FU_AT(0, 9, 30), observation_id: null }],
    summary: "Ana confirmed procurement countersigned the order form. The rollout starts with ten stores next month.",
    tasks: [
      { id: "t1", text: "Send Ana the ten-store rollout plan", due: day(5), due_phrase: "next week", on: true, quote: "Send me the rollout plan for the first ten stores.", stated_by: "them", owed_by: null },
      { id: "t2", text: "Send revised pricing to Halcyon", due: null, on: true, existing: true },
    ],
    updates: [
      { id: "u1", label: "Next step", value: "Rollout plan for the first ten stores", on: true, quote: null, speaker: null },
    ],
    email: {
      to: ["ana.souza@halcyonretail.example"],
      subject: "Rollout plan for the first ten stores",
      body: "Hi Ana,\n\nGreat news on the order form, thank you for pushing it through. I'll send the rollout plan for the first ten stores next week.\n\nBest,\nImogen",
    },
    dealChange: {
      reason: "Ana said procurement countersigned the order form this week, but HubSpot still shows the deal at Committed. Move it to Closed won in HubSpot once the signed form is filed.",
      deal_id: "dl-19",
    },
  }),
];

/** A card as Home's recommendation (followUps.mjs toRecommendation). */
export function followUpRec(row) {
  const last = row.meetings[row.meetings.length - 1] ?? null;
  return {
    id: `fu:${row.id}`, kind: "follow_up_call", title: `Send the follow-up to ${row.account.name}`,
    why: row.summary, when: last?.at ?? null, entity_id: row.account.id, account: row.account,
    person: null, person_photo: null, person_email: null, due: "today", assignee: null, created_at: row.created_at, document_id: null,
    followup: {
      follow_up_id: row.id, status: row.status, tasks: row.tasks, updates: row.updates, email: row.email, attribution: row.attribution,
      meeting: last ? { kind: last.kind, at: last.at, title: last.title } : null, meetings: row.meetings, summary: row.summary,
      deal_change: row.deal_change ? { reason: row.deal_change.reason, url: row.deal_change.url } : null, crm: row.crm,
      writeback: row.writeback === true,
    },
  };
}
/** Whose cards: `mine` is the preview viewer's, as the reviewer the CRM names. */
export const followUpInScope = (scope) => (row) => scope !== "mine" || row.reviewer_name === PREVIEW_VIEWER;

// ── Home (/api/home) ──────────────────────────────────────────────────────────
// Meetings and recommendations are fixed; every deal number is derived from DEALS
// by the live route's rules, so Home, Pipeline and the account pages agree, and
// scope=mine narrows them to the preview viewer's book exactly as the API does.
const HOME_BASE = (() => {
  const at = (days, h, m = 0) => { const d = new Date(Date.now() + days * DAY); d.setHours(h, m, 0, 0); return d.toISOString(); };
  // Accounts and people from the same world the Tasks page reads, so a card's tasks line up.
  const acct = (id) => { const c = COMPANIES.find((x) => x.id === id); return { id: c.id, name: c.name, domain: c.domain }; };
  return {
    // `purpose` is null on the live API until Phase 3 fills it; two carry one here so both states show.
    meetings: [
      { when: at(0, 15), title: "Meridian security review prep", entity_id: "p1", name: "Dana Whitfield", company: "Meridian Analytics", purpose: "Walk Dana through the security questionnaire and agree a pilot start date.", attendees: [] },
      { when: at(0, 17, 30), title: "Cobalt pilot kickoff", entity_id: "p2", name: "Marcus Bell", company: "Cobalt Systems", purpose: "Kick off the pilot: success criteria, owners and the week-two check-in.", attendees: [] },
      { when: at(1, 10), title: "Northwind discovery follow-up", entity_id: "c2", name: null, company: "Northwind Logistics", purpose: null, attendees: [] },
      { when: at(2, 14), title: "Atlas Health QBR", entity_id: "c4", name: null, company: "Atlas Health", purpose: null, attendees: [] },
    ],
    recommendations: [
      { id: "r1", kind: "follow_up_call", title: "Send the follow-up to Meridian Analytics", why: "Your security review call with Dana Whitfield ended yesterday.", when: null, entity_id: "p1", account: acct("c1"), person: "Dana Whitfield", assignee: null, created_at: at(-1, 16),
        // What the HubSpot write-back will propose once it ships. Preview only: the live API sends none yet.
        hubspot: [
          { object: "Company", field: "Top learnings", value: "Security review is the gate for the pilot. Infosec wants SOC 2 Type II before any data leaves their VPC.", quote: "Nothing moves until infosec signs off on SOC 2", speaker: "Dana Whitfield", at: "14:02" },
          { object: "Deal", field: "Next step", value: "Send the security questionnaire pack by Friday", quote: "If you can get us the questionnaire by Friday we can start", speaker: "Dana Whitfield", at: "31:40" },
          { object: "Company", field: "Decision maker", value: "Meera Raman, CFO", quote: "Meera signs anything over fifty", speaker: "Dana Whitfield", at: "22:15" },
        ] },
      { id: "r5", kind: "follow_up_call", title: "Send the follow-up to Northwind Logistics", why: "Discovery follow-up with the ops team ended this morning.", when: null, entity_id: "c2", account: acct("c2"), assignee: null, created_at: at(0, 11) },
      { id: "r2", kind: "meeting_brief", title: "Prepare for your meeting with Cobalt Systems", why: "Pilot kickoff today at 5:30 PM with Marcus Bell.", when: at(0, 17, 30), due: at(0, 17, 30), entity_id: "p2", account: acct("c3"), person: "Marcus Bell", assignee: null, created_at: at(0, 8) },
      { id: "r3", kind: "follow_up_quiet", title: "Follow up with Beacon Financial", why: "No conversation in 38 days since the pricing call.", when: null, entity_id: "c6", account: acct("c6"), assignee: null, created_at: at(-2, 9) },
      { id: "r4", kind: "reach_out", title: "Reach out to Vantage Legal", why: "Nina Rossi visited pricing twice this week and opened the case study.", when: null, entity_id: "p21", account: acct("c11"), person: "Nina Rossi", assignee: null, created_at: at(-1, 11) },
      // Handoffs (GET-495): one per won deal whose brief the automation wrote. On a real book these
      // are most of the list, which is why Priorities groups them and shows three (GET-678).
      ...["c19", "c18", "c20", "c17", "c14"].map((c, i) => ({
        id: `rh${i + 1}`, kind: "handoff", title: `Take over ${acct(c).name}`, why: "Closed won — the handoff brief is ready.", when: null,
        entity_id: c, account: acct(c), assignee: null, created_at: at(-1 - i, 10), due: "today", document_id: `doc-handoff-${c}`,
      })),
    ],
  };
})();

const WEEK_LINES = ["new", "moved_up", "won", "lost", "slipped"];

/** GET /api/home?scope= — the live route's shape, every deal number from DEALS. `followUps` is
 *  the server's live copy of FOLLOW_UPS, so a card decided this session leaves Home on reload. */
export function homeFor(scope, followUps = FOLLOW_UPS) {
  const book = DEALS.filter(inBook(scope));
  const open = book.filter((d) => d.status === "open");
  const won = book.filter((d) => d.status === "won");
  const sum = (rows) => rows.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const daysAgo = (t) => Math.floor((Date.now() - Date.parse(t)) / DAY);
  // Pipeline this week: the counts are the lists' lengths, biggest deal first.
  const week = { has_history: true, value: {}, deals: {} };
  for (const line of WEEK_LINES) {
    const rows = book.filter((d) => d.wk?.bucket === line)
      .map((d) => ({ id: d.id, company_id: d.company_id, name: d.name, account: d.company_name, value: d.value, from: d.wk.from ?? null, to: d.wk.to ?? null }))
      .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    week[line] = rows.length;
    week.value[line] = sum(rows);
    week.deals[line] = rows;
  }
  // The Pipeline page's At risk rule: known activity 9+ days old, or Nous health under 50.
  const atRisk = open.filter((d) => (d.last_activity_at && daysAgo(d.last_activity_at) >= 9) || (d.health_score != null && d.health_score < 50));
  // Deal change required: close date passed in the last 30 days, one per account, newest first.
  const seen = new Set();
  const changes = open
    .filter((d) => { const n = daysAgo(d.close_date); return n > 0 && n <= 30; })
    .sort((a, b) => String(b.close_date).localeCompare(String(a.close_date)))
    .filter((d) => (seen.has(d.company_id) ? false : seen.add(d.company_id)));
  // The engine's waiting cards lead, the older after-the-call recommendations follow (as the API).
  const recommendations = [
    ...followUps.filter((f) => f.status === "ready").filter(followUpInScope(scope)).map(followUpRec),
    ...HOME_BASE.recommendations,
  ];
  return {
    meetings: HOME_BASE.meetings,
    metrics: {
      deals_won_this_week: week.won,
      deals_won_last_week: won.filter((d) => { const n = daysAgo(d.close_date); return n >= 7 && n < 14; }).length,
      open_deals: open.length,
      open_deals_with_amount: open.filter((d) => Number(d.value) > 0).length,
      meetings_today: 2,
      accounts_need_attention: 4,
      follow_ups_ready: recommendations.filter((r) => r.kind === "follow_up_call").length,
      deals_at_risk: { count: atRisk.length, value: sum(atRisk) },
    },
    pipeline: { open_value: sum(open), open_count: open.length, won_value: week.value.won, week },
    deal_changes: changes.map((d) => ({
      deal_id: d.id, deal: d.name, account_id: d.company_id, account: d.company_name, domain: d.company_domain,
      stage: d.stage, close_date: d.close_date, reason: "close_date_passed", value: d.value ?? null,
    })),
    recommendations,
    ...scopeFields(scope),
  };
}
export const HOME = homeFor(null);

// ── Reports (/api/reports/overview) ──────────────────────────────────────────
// The business read, by the live route's rules (routes/api/reportsOverview.mjs) over this world:
// the primary pipeline's open deals in its ladder's order; per CRM owner, open deals and value in
// every pipeline, at risk by Home's rule, the follow-up cards still waiting on them and their
// overdue promises; retention off the Customers payload. `followUps` and `tasks` are the server's
// live copies, so approving a card here moves the numbers on reload.
//
// The fixture's commitments carry only what was said (due_at null), so a due day is read off the
// phrase, roughly the way the extractor resolves one, counted from when it was said.
const PHRASE_DAYS = { tomorrow: 1, "in 2 days": 2, "by end of week": 5, Monday: 7, "next Tuesday": 7, "in a couple of weeks": 14, "end of month": 30 };
const dueDayOf = (t) => {
  if (t.due_at) return Date.parse(t.due_at);
  const n = PHRASE_DAYS[t.due_phrase ?? ""];
  return n == null ? null : Date.parse(t.recorded_at) + n * DAY;
};
export function reportsOverview(sections, followUps = FOLLOW_UPS, tasks = TASKS) {
  const want = new Set(String(sections ?? "").split(",").map((s) => s.trim()).filter((s) => ["pipeline", "reps", "retention"].includes(s)));
  const all = !want.size;
  const open = DEALS.filter((d) => d.status === "open");
  const amount = (rows) => rows.reduce((s, d) => s + (Number(d.value) || 0), 0);
  const daysAgo = (t) => Math.floor((Date.now() - Date.parse(t)) / DAY);
  const atRisk = (d) => (d.last_activity_at && daysAgo(d.last_activity_at) >= 9) || (d.health_score != null && d.health_score < 50);
  const out = {};
  if (all || want.has("pipeline")) {
    const primary = open.filter((d) => d.pipeline_id === SALES.id);
    const stages = STAGES.default.filter((s) => s.kind === "active").map((s) => {
      const here = primary.filter((d) => d.stage === s.label);
      return { stage: s.label, count: here.length, value: amount(here) };
    });
    out.pipeline = { pipeline_ref: SALES.id, name: SALES.name, stages, total_count: primary.length, total_value: amount(primary) };
  }
  if (all || want.has("reps")) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const owners = [...new Set([...open.map((d) => d.owner_name), ...followUps.filter((f) => f.status === "ready").map((f) => f.reviewer_name)])];
    out.reps = owners.map((name) => {
      const mine = open.filter((d) => d.owner_name === name);
      const risky = mine.filter(atRisk);
      return {
        owner_name: name ?? null, open_count: mine.length, open_value: amount(mine), at_risk: risky.length, at_risk_value: amount(risky),
        follow_ups_waiting: followUps.filter((f) => f.status === "ready" && f.reviewer_name === name).length,
        overdue_tasks: (tasks.commitments ?? []).filter((t) => t.owner_kind !== "prospect" && t.assignee?.name === name && (dueDayOf(t) ?? Infinity) < today.getTime()).length,
      };
    }).sort((a, b) => Number(a.owner_name == null) - Number(b.owner_name == null) || b.open_value - a.open_value);
    out.reps_scope = "team";
  }
  if (all || want.has("retention")) {
    const cs = csPayload(null);
    const horizon = Date.now() + 60 * DAY;
    const dated = cs.accounts.filter((a) => a.renewal_date);
    out.retention = {
      arr: cs.totals.mrr * 12, customers: cs.counts.active, at_risk: cs.counts.atRisk, at_risk_arr: cs.totals.atRiskMrr * 12,
      renewing_60d: dated.length ? dated.filter((a) => Date.parse(a.renewal_date) <= horizon).length : null,
      expansion_asks: cs.counts.expansion, health_ready: true,
    };
  }
  return out;
}
