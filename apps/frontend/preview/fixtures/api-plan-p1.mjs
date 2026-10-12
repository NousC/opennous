// Preview fixtures for the API-plan page work (GET-622 Get started, GET-628 Home). Only served
// with PREVIEW_PLAN=api (see the hook in preview/server.mjs), so the visual baselines never see
// them. Same paths and shapes as the real routes.
const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

// GET /api/activity-stats/conversations rows (routes/api/activityStats.mjs).
const convo = (id, h, source, kind, label, extra) => ({
  id, kind, label, source, when: hoursAgo(h), minutes: null, estimated: false, credits: 1, summary: null,
  status: "read", reason: null, messages: null, read_at: hoursAgo(h - 0.5), ...extra,
});
const CONVERSATIONS = [
  convo("cv1", 2, "fireflies", "meeting", "Meridian pricing call", { minutes: 41, credits: 5, summary: "Pricing objection, EU residency question, next step set" }),
  convo("cv2", 4, "gmail", "email", "Re: annual pricing", { messages: 4, summary: "Asked for the security pack before procurement" }),
  convo("cv3", 6, "gmail", "email", "Northwind intro", { messages: 2, summary: "Warm intro, meeting proposed" }),
  convo("cv4", 7, "fireflies", "meeting", "Halcyon weekly sync", { minutes: 28, credits: 3, status: "waiting", read_at: null }),
  convo("cv5", 20, "linkedin", "email", "Tomás Ortega", { messages: 3, summary: "Asked about SSO and SOC 2" }),
  convo("cv6", 26, "fireflies", "meeting", "Ardent discovery", { minutes: 35, credits: 4, summary: "Two stakeholders named, budget in Q1" }),
  convo("cv7", 28, "gmail", "email", "Team offsite", { messages: 6, credits: 0, status: "skipped", reason: "Internal only", read_at: null }),
  convo("cv8", 31, "fireflies", "meeting", "Fernhill partner call", { minutes: null, estimated: true, credits: 3, status: "nothing_new" }),
];

export const routes = [
  // routes/api/backfillPreview.mjs — a finished backfill.
  ["GET", /^\/api\/backfill\/preview$/, () => ({
    state: "done", plan_live: true, window_days: 90, finished_at: ago(3),
    progress: { pct: 100, read: 2140, phase: "done", to_read: 2140, reading_done: 2140 },
  })],
  ["GET", /^\/api\/activity-stats\/conversations$/, () => ({ items: CONVERSATIONS })],
  ["GET", /^\/api\/activity-stats\/read$/, () => ({
    days: 1,
    tools: [
      { name: "gmail", label: "Gmail", logo_url: "https://www.google.com/s2/favicons?domain=mail.google.com&sz=64" },
      { name: "hubspot", label: "HubSpot", logo_url: "https://www.google.com/s2/favicons?domain=hubspot.com&sz=64" },
      { name: "fireflies", label: "Fireflies", logo_url: "https://www.google.com/s2/favicons?domain=fireflies.ai&sz=64" },
      { name: "linkedin", label: "LinkedIn", logo_url: "https://www.google.com/s2/favicons?domain=linkedin.com&sz=64" },
    ],
    read: { accounts_analysed: 20, meetings_transcribed: 4, email_threads_read: 9, calls_recorded: 0 },
  })],
  // /api/usage/by-key lives in api-plan-p4.mjs (one fixture for Home and Usage).
];
