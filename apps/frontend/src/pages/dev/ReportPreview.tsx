// A dev-only page that renders the revenue report from FIXTURE data through the real renderer
// (GET-416): the executive summary, then the ten sections in the shape every section has —
// status tiles · In brief · the visual · the list with its "N more" · Takeaways. It exists so
// the shape and the blocks can be judged in a browser before a single real run, and so a change
// to ReportBlocks can be seen without a backfill. Opened at /preview.html on a dev server; it
// never ships. Every number here is invented.

import { SectionBody, ReportSectionFrame, type ReportSection, type ReportBlock } from "@/components/ReportBlocks";

const brief = (lines: string[]): ReportBlock => ({ type: "bullets", heading: "In brief", lines });
const takeaways = (lines: string[]): ReportBlock => ({ type: "bullets", heading: "Takeaways", lines });

const SECTIONS: ReportSection[] = [
  {
    kicker: "Executive summary",
    label: "Your conversations know things your CRM does not, and most of them are about money you are already losing",
    blocks: [
      { type: "metrics", items: [
        { label: "Leakage identified", value: 1_200_000, unit: "usd", note: "open pipeline with a known failure mode", tone: "bad" },
        { label: "Not in the CRM", value: 40, unit: "pct", note: "of the last 30 days' conversations", tone: "risk" },
        { label: "Customers at risk", value: 100, unit: "count", note: "40 on a tier-1 reason", tone: "bad" },
        { label: "Asking for more", value: 200, unit: "count", note: "$100k/mo priced, never discussed", tone: "good" },
      ] },
      brief([
        "Six months reconstructed: **$4.0M created, $1.2M won**, a 30% created→won rate. Most of what did not close stopped between discovery and evaluation.",
        "**40% of recent conversations never reached the CRM.** 20 commitments your team made on calls are open in nobody's task list; 10 buyer questions went unanswered.",
        "**Of 120 lost deals, 30% took the same path** — no economic buyer → close date slips → pricing objection → competitor → silence. It starts before the first objection.",
        "**40 customers said they may leave, in their own words.** The CRM learned about Quarry Lane Clinics four weeks after they said they would not renew.",
        "**200 customers are asking for more** or carry a priced upgrade marked *Never Raised*: $100k/mo the CS team has never been shown.",
        "**In the last 30 days alone OpenNous would have updated 200 accounts** — 20 tasks, 80 claims, 60 CRM fields — from conversations that are already in your systems.",
      ]),
      takeaways([
        "Three operating changes cover most of the leakage: a calendared next step before discovery ends, an economic buyer before any proposal, and a CS call within two days of a tier-1 risk.",
        "Turn the CRM agent on so what is said on calls reaches the deal it belongs to — today 1 in 50 conversations is filed.",
        "Read section 05 with the team: the lost path is the coaching plan.",
      ]),
    ],
  },
  {
    kicker: "What happened",
    label: "$1.2M of created pipeline stalled, and 40% of it had no next step within 48 hours",
    blocks: [
      { type: "metrics", items: [
        { label: "Pipeline created", value: 4_000_000, unit: "usd", note: "240 opportunities · Jan–Aug" },
        { label: "Closed won", value: 1_200_000, unit: "usd", note: "40 deals" },
        { label: "Created → won", value: 30, unit: "pct" },
        { label: "Leakage identified", value: 1_200_000, unit: "usd", note: "overlapping exposure" },
      ] },
      brief([
        "Deals that closed averaged 1 day from discovery to the next scheduled interaction; the ones that stalled averaged 6 [1].",
        "80% of wins had three or more stakeholders on a call; 40% of losses did.",
        "The stage where the most value stops is Discovery → Evaluation: $500K sat there past 30 days.",
      ]),
      { type: "table", headers: ["Priority", "Why it matters", "30-day action"], rows: [
        ["Multi-thread before proposal", "80% of wins had 3+ stakeholders; 40% of losses did", "No proposal leaves without the economic buyer on a call"],
        ["Book the next step in the room", "Stalled deals averaged 6 days to the next touch; wins 1", "Discovery does not end without a calendared next step"],
        ["Answer the 10 open questions", "A buyer asked, nobody wrote back", "Owner named per question by Friday"],
      ], emphasis: 2 },
      takeaways([
        "The funnel is not the problem; the hand-off after discovery is. Fix the next-step habit and the evaluation stage fills itself.",
        "Measure hours-to-next-touch weekly; it is the one number in this report that moves inside a month.",
      ]),
    ],
  },
  {
    kicker: "How much we could see",
    label: "240 deals, 3,200 threads and 320 calls were read; nothing before April has a transcript",
    blocks: [
      { type: "metrics", items: [
        { label: "Opportunities", value: 240, unit: "count" }, { label: "Email threads", value: 3200, unit: "count" },
        { label: "Calls with transcript", value: 320, unit: "count", note: "Fathom, from April 1" }, { label: "Linked to an account", value: 85, unit: "pct" },
      ] },
      { type: "split", left: [
        { type: "table", headers: ["Source", "Backfilled", "Coverage", "Used for"], rows: [
          ["HubSpot", "240 opportunities · 60k engagements", "Jan 15 – Aug 31", "Stage history, values, outcomes, logged calls"],
          ["Gmail", "3,200 threads", "Jan 15 – Aug 31", "Follow-up timing, silence, stakeholder reach"],
          ["Fathom", "320 transcripts", "Apr 1 – Aug 31", "What was said, verbatim"],
        ] },
      ], right: [
        brief([
          "An **observed fact** is in a source record. A **derived metric** is computed from observed facts. An **inferred pattern** is an association across cohorts, not proof of cause.",
          "No notetaker before April: the first eleven weeks carry no verbatim quotes. A gap, not a finding of silence.",
          "CRM tasks are not synced, so \"unfiled\" in section 03 means the graph holds a commitment the CRM was never told about.",
        ]),
      ] },
      takeaways([
        "Connect the notetaker to every seat that runs customer calls; 140 of 520 active accounts have a transcript today.",
      ]),
    ],
  },
  {
    kicker: "What the CRM did not know",
    label: "40% of the last 30 days' conversations never reached the CRM, and the ones that mattered most are among them",
    blocks: [
      { type: "metrics", items: [
        { label: "Not in the CRM", value: 40, unit: "pct", note: "of 1,000 conversations", tone: "risk" },
        { label: "Commitments unfiled", value: 20, unit: "count", note: "ours, still open", tone: "bad" },
        { label: "Questions unanswered", value: 10, unit: "count", tone: "bad" },
        { label: "Risks said on calls", value: 20, unit: "count", note: "no CRM field holds these", tone: "risk" },
      ] },
      brief([
        "400 of 1,000 conversations in the window came from Gmail, Fathom or LinkedIn and exist nowhere in HubSpot.",
        "20 promises your team made on calls (\"I'll send the onboarding checklist by Friday\") are open in OpenNous and in nobody's task list.",
        "20 risks were said out loud — a competitor, a cancellation, an invoice dispute — and no CRM field can hold a sentence.",
        "15 accounts with an open deal have had no inbound for 30+ days; 10 deals had their close date pushed twice.",
      ]),
      { type: "split", left: [
        { type: "chart", variant: "bar", title: "The gaps, by count", unit: "count", data: [
          { label: "Conversations not in CRM", value: 400 }, { label: "Commitments unfiled", value: 20 }, { label: "Risks said on calls", value: 20 },
          { label: "Going dark, deal open", value: 15 }, { label: "Questions unanswered", value: 10 }, { label: "Close date slipped twice+", value: 10 }, { label: "Expansion asked, no deal", value: 5 },
        ] },
      ], right: [
        { type: "evidence", title: "What the CRM did not hold", more: 15, more_label: "the Needs Attention list", rows: [
          { account: "Quarry Lane Clinics", quote: "We were billed twice for the reminders module this quarter, who can sort that out?", became: "risk signal → cancelled 4 days later", at: "2026-06-10" },
          { account: "Tidewell Animal Hospital", quote: "Roughly what would the intake forms module add per month?", became: "expansion ask · HubSpot says Never Raised", at: "2026-09-01" },
          { account: "Orchard Hill Vets", quote: "I'll get the signed onboarding checklist over to you next week", became: "task for Theo, open 20 days", at: "2026-09-02" },
        ] },
      ] },
      takeaways([
        "Turn the CRM agent on: it files each conversation to the deal it belongs to and asks the rep only when it cannot tell.",
        "Route the 20 open commitments to their owners this week; a task filed late is not a task.",
        "Answer the 10 questions before the next pipeline review — each is a buyer waiting.",
      ]),
    ],
  },
  {
    kicker: "Where it leaks",
    label: "$1.2M of open pipeline shows a failure mode this team has already lost deals to",
    blocks: [
      { type: "metrics", items: [
        { label: "Open pipeline exposed", value: 1_200_000, unit: "usd", note: "overlapping — never a sum", tone: "bad" },
        { label: "Quiet 14+ days", value: 400_000, unit: "usd", tone: "risk" },
        { label: "Single-threaded", value: 350_000, unit: "usd", tone: "risk" },
        { label: "Savable this month", value: 15, unit: "count", note: "open deals with 2+ patterns", tone: "good" },
      ] },
      brief([
        "One deal can be quiet, single-threaded and missing a buyer at once, so the bars overlap on purpose and do not add up to a total.",
        "Deals quiet past 14 days closed at a third of the base rate in this team's own history.",
        "15 open deals carry two or more failure modes at once; three of them need a manager, not a rep.",
      ]),
      { type: "chart", variant: "bar", title: "Pipeline affected, by pattern", unit: "usd", data: [
        { label: "No touch either way for 14+ days", value: 400_000 }, { label: "Single-threaded", value: 350_000 }, { label: "No economic buyer", value: 300_000 },
        { label: "Objection open", value: 250_000 }, { label: "Close date slipped twice+", value: 200_000 },
      ] },
      { type: "table", headers: ["Account", "Value", "Days quiet", "Patterns present", "Intervention"], units: ["", "usd", "days", "", ""], more: 10, more_label: "the Accounts list, sorted by health", rows: [
        ["Saltmarsh Veterinary Group", 8000, 20, "quiet · single-threaded · no buyer", "Manager call to the practice owner this week"],
        ["Kestrel Ridge Pet Care", 15000, 30, "quiet · objection open (pricing)", "Answer the pricing objection in writing, then re-qualify"],
        ["Bellhaven Animal Clinic", 10000, 12, "slipped twice · single-threaded", "Bring the practice manager into the next call"],
      ], emphasis: 4 },
      takeaways([
        "Work the 15 recovery deals first: they are the only pipeline where something can still be done this month.",
        "Re-qualify out any deal quiet past 30 days with no buyer; nursing it costs the rep a week.",
      ]),
    ],
  },
  {
    kicker: "Why deals are lost",
    label: "Of 120 lost deals, 30% took the same path, and it starts before the first objection",
    blocks: [
      { type: "metrics", items: [
        { label: "Lost deals", value: 120, unit: "count", note: "Mar–Sep", tone: "bad" },
        { label: "Took the common path", value: 30, unit: "pct", note: "36 deals", tone: "bad" },
        { label: "Controllable causes", value: 70, unit: "pct", note: "of explained losses", tone: "risk" },
        { label: "Unexplained", value: 20, unit: "count", note: "nothing on record", tone: "neutral" },
      ] },
      brief([
        "The path: no economic buyer → close date slips → pricing objection never resolved → competitor named → silence. 10% of won deals took the first three steps; none took all five.",
        "An objection left open is the single most common controllable cause: 50 of 120.",
        "Reps logged *Budget* on 30 losses; the conversations say *competitor, unanswered* on 20 of those.",
        "20 losses have nothing on record that explains them. That residual is honest, not a gap in the taxonomy.",
      ]),
      { type: "path", tone: "bad", title: "The commonest lost path", cohort: "of 120 lost deals", compare: "10% of 40 won deals took the first three steps", steps: [
        { label: "No economic buyer", pct: 70, n: 84 }, { label: "Close date slipped", pct: 60, n: 72 }, { label: "Pricing objection, never resolved", pct: 40, n: 48 },
        { label: "Competitor named", pct: 35, n: 42 }, { label: "Went quiet", pct: 30, n: 36 },
      ] },
      { type: "split", left: [
        { type: "table", headers: ["Cause", "Lost deals", "Share", "Controllable"], units: ["", "count", "pct", ""], rows: [
          ["No decision maker ever on the deal", 84, 70, "Yes"], ["An objection raised and never resolved", 50, 42, "Yes"], ["A competitor was named", 42, 35, "Partly"],
          ["Went quiet before the close", 36, 30, "Yes"], ["Budget constraint stated", 18, 15, "No"], ["Unclassified — nothing on record", 20, 17, ""],
        ], emphasis: 3 },
      ], right: [
        { type: "evidence", title: "Saltmarsh Veterinary Group, lost Aug 12 — rep logged: Budget", rows: [
          { account: "Jun 18", quote: "close date pushed from Jun 30 to Aug 15", became: "CRM history" },
          { account: "Jul 2", quote: "Tallyroo quoted us less and it does the basics", became: "pricing objection, open" },
          { account: "Jul 21", quote: "(no reply to two follow-ups)", became: "went quiet, 20 days" },
        ] },
      ] },
      takeaways([
        "Coach the first step, not the last: a deal with no economic buyer by week two is already on the path. Make it a stage gate.",
        "Every open pricing objection gets a written answer within 48 hours; 50 deals died with one unanswered.",
        "Stop trusting the closed-lost dropdown for the post-mortem; read the deal's own record on its page.",
      ]),
    ],
  },
  {
    kicker: "The customer book",
    label: "Expansion and churn are both visible before they happen: 40 customers said they may leave, 150 asked for more",
    blocks: [
      { type: "metrics", items: [
        { label: "Active customers", value: 400, unit: "count" }, { label: "MRR", value: 200_000, unit: "usd" },
        { label: "At risk", value: 100, unit: "count", note: "40 on a tier-1 reason", tone: "bad" }, { label: "Asking for more", value: 200, unit: "count", note: "$100k/mo priced", tone: "good" },
      ] },
      brief([
        "60% of the at-risk rows rest on something a customer said, not a CRM field. The CRM's own churn model flags 5; the conversations flag 40.",
        "150 customers asked for a product they do not own, in their own words; 300 carry a priced upgrade marked *Never Raised*.",
        "An invoice complaint alone does not make the at-risk list; a stated cancellation does. A declined product is not pitched back for a year.",
      ]),
      { type: "columns", more: 100, more_label: "the Customer Success page", columns: [
        { title: "At risk", tone: "bad", cards: [
          { account: "Pinecrest Vet Partners", text: "Said they will wind down every module at renewal", quote: "we'll be moving all of our locations off at renewal", value: 1200, unit: "usd" },
          { account: "Marlow Street Clinic", text: "Looking for an all-in-one practice system", quote: "we need one system that does everything now", value: 900, unit: "usd" },
          { account: "Quarry Lane Clinics", text: "Cancelled after a double-billing complaint", quote: "consider this our written notice to end the contract", value: 800, unit: "usd" },
          { account: "Dunraven Pet Hospital", text: "Paying, nobody logged in for 30 days", value: 1500, unit: "usd" },
        ] },
        { title: "Asking for more", tone: "good", cards: [
          { account: "Tidewell Animal Hospital", text: "Asked the cost of the Fernpoint intake forms module — never discussed in HubSpot", quote: "Roughly what would the intake forms module add per month?", value: 500, unit: "usd" },
          { account: "Cobble Hill Vet Group", text: "Wants the reminders module at every location", quote: "Could all four of our sites get the reminders module?", value: 1200, unit: "usd" },
          { account: "Wrenfield Pet Clinic", text: "Asked to add their new second location", quote: "we're opening a second location, can it go on our plan", value: 600, unit: "usd" },
          { account: "Ambleside Animal Care", text: "Priced upgrade, marked Never Raised", value: 800, unit: "usd" },
        ] },
      ] },
      takeaways([
        "CS calls the 40 tier-1 accounts this week, strongest reason first; the list is on the Customer Success page with the quote on each row.",
        "Sales works the 150 asks before the 300 priced upgrades: a customer who asked converts; a field somebody scoped does not.",
        "Give the CS owner a Monday routine: open the two lists, take the top five of each.",
      ]),
    ],
  },
  {
    kicker: "What the market says",
    label: "Your buyers keep saying four things, and the loudest is about missed bookings, not the product",
    blocks: [
      { type: "metrics", items: [
        { label: "Themes", value: 4, unit: "count", note: "product · positioning · market · buyer" },
        { label: "Accounts raising the top one", value: 30, unit: "count", note: "after-hours bookings", tone: "risk" },
        { label: "Feature that exists, unused", value: 25, unit: "count", note: "online check-in", tone: "risk" },
        { label: "Mistaken for a booking widget", value: 15, unit: "count", tone: "neutral" },
      ] },
      brief([
        "The product theme is an adoption problem wearing a product costume: online check-in exists and 25 accounts have never turned it on.",
        "15 accounts think of the product as \"just a booking widget\" — a positioning miss that shows up as churn risk two quarters later.",
        "New record-keeping rules for regional regulators are the one market signal with a date attached: January.",
      ]),
      { type: "split", left: [
        { type: "chart", variant: "bar", title: "Themes, by accounts that raised them", unit: "count", data: [
          { label: "Buyer: bookings missed after hours", value: 30 }, { label: "Product: online check-in is not used", value: 25 },
          { label: "Positioning: 'just a booking widget'", value: 15 }, { label: "Market: new record-keeping rules", value: 10 },
        ] },
      ], right: [
        { type: "evidence", more: 80, more_label: "the Insights page", rows: [
          { account: "Harrowgate Vet Centre", quote: "once the front desk goes home, nobody picks up the booking requests", became: "buyer theme · 30 accounts" },
          { account: "Larkspur Animal Clinic", quote: "nobody told us check-in could be done online", became: "product theme · 25 accounts" },
          { account: "Kestrel Ridge Pet Care", quote: "we thought you were just the booking button on our site", became: "positioning theme · 15 accounts" },
          { account: "Bellhaven Animal Clinic", quote: "the new rules mean every visit note has to be kept for seven years", became: "market theme · 10 accounts" },
        ] },
      ] },
      takeaways([
        "A training motion, not a roadmap item: a 20-minute check-in session for the 25 accounts is the cheapest expansion in this report.",
        "Lead the pitch with after-hours bookings; it is what 30 buyers said the pain is.",
        "Build the record-keeping story for the January deadline now; 10 accounts already asked.",
      ]),
    ],
  },
  {
    kicker: "What winning looks like",
    label: "Won deals had an economic buyer by week two; the ones that did not close mostly never did",
    blocks: [
      { type: "metrics", items: [
        { label: "Stakeholders, won", value: 4, unit: "count", note: "median · n=40", tone: "good" },
        { label: "Stakeholders, not won", value: 2, unit: "count", note: "median · n=120", tone: "bad" },
        { label: "Hours to follow up, won", value: 10, unit: "count", tone: "good" },
        { label: "Hours to follow up, not won", value: 30, unit: "count", tone: "bad" },
      ] },
      brief([
        "Observed, not proven: multi-threaded deals tend to be the same deals with an engaged economic buyer.",
        "The follow-up gap is 3× and it is a habit, not a market condition.",
        "The ICP cut holds at this sample: groups with 3+ locations closed at twice the rate of single clinics.",
      ]),
      { type: "split", left: [
        { type: "chart", variant: "grouped", title: "Won against not won (medians)", data: [
          { label: "Stakeholders engaged", won: 4, lost: 2 }, { label: "Hours to follow up", won: 10, lost: 30 },
          { label: "Days idle (longest)", won: 5, lost: 20 }, { label: "Weeks to economic buyer", won: 2, lost: 7 },
        ], series: [{ key: "won", label: "Won (n=40)", color: "good" }, { key: "lost", label: "Did not close (n=120)", color: "bad" }] },
      ], right: [
        { type: "table", headers: ["Signal", "Won", "Did not close", "Gap"], rows: [
          ["Stakeholders engaged", "4", "2", "2×"], ["Hours to follow up", "10", "30", "3× slower"], ["Economic buyer on a call", "80%", "40%", "2×"], ["Locations (median)", "3", "1", "3×"],
        ], emphasis: 3 },
      ] },
      takeaways([
        "Put the economic buyer on the second call, not the fifth: it is the earliest separator in this team's history.",
        "Qualify on locations: the ICP now weights multi-site groups, and the scoring model has been rebuilt on these 160 deals.",
      ]),
    ],
  },
  {
    kicker: "What OpenNous would have done",
    label: "In the last 30 days it would have updated 200 accounts, filed 20 tasks and raised 80 claims, and none of it reached the CRM",
    blocks: [
      { type: "metrics", items: [
        { label: "Accounts it would update", value: 200, unit: "count", note: "of 1,000 conversations read", tone: "good" },
        { label: "Claims raised", value: 80, unit: "count", note: "objection 30 · risk 20 · expansion 20 · other 10", tone: "risk" },
        { label: "Tasks it would create", value: 20, unit: "count", note: "12 from Fathom · 8 from Gmail", tone: "good" },
        { label: "CRM fields it would write", value: 60, unit: "count", note: "20 stage · 40 at-risk flags", tone: "risk" },
      ] },
      { type: "bullets", heading: "What it would do", lines: [
        "**File every conversation to the deal it belongs to** — most conversations on a typical deal are with the people on it, not on the deal itself; the CRM agent proposes the deal and asks the rep only when two are open.",
        "**Create the 20 tasks** your team promised on calls and in email, each with the call it came from, who owes it, and the due phrase they used.",
        "**Write 80 claims** onto accounts and people — what was said, with the quote — where a CRM field cannot hold a sentence.",
        "**Flag 40 customers at risk** with the reason and the quote, and **propose 20 expansion deals** the customer asked for.",
        "**Suggest 20 stage moves** where the conversations say a deal has progressed further than the CRM does.",
      ] },
      { type: "table", headers: ["Account", "What would change", "Evidence", "From"], more: 200, more_label: "each account's Intel and Tasks tabs", rows: [
        ["Orchard Hill Vets", "Task: send the onboarding checklist (Theo, by Friday)", "\"I'll get the signed onboarding checklist over to you next week\"", "Fathom call, Aug 12"],
        ["Saltmarsh Veterinary Group", "Stage → Negotiation · claim: objection (pricing, open) · competitor: Tallyroo", "\"Tallyroo quoted us less\"", "Fathom call, Aug 26"],
        ["Pinecrest Vet Partners", "At-risk flag, tier 1 · CS call proposed", "\"we'll be moving all of our locations off at renewal\"", "Gmail, Sep 14"],
        ["Tidewell Animal Hospital", "Expansion deal proposed: the Fernpoint intake forms module", "\"Roughly what would the intake forms module add per month?\"", "HubSpot email, Sep 1"],
      ] },
      { type: "bullets", heading: "Takeaways", lines: [
        "This is the daily value: the filing, the tasks and the flags happen on every call from now on, whether or not anyone opens the app.",
        "Decide on write-back: with HubSpot write scopes, the 20 tasks and 60 field updates land in the CRM on the rep's confirmation, never silently.",
      ] },
    ],
  },
  {
    kicker: "The next 30 days",
    label: "Four operating changes, one routine, and one account that shows the whole story",
    blocks: [
      { type: "table", headers: ["Operating change", "Trigger", "Owner", "Success measure"], rows: [
        ["Follow up within 24 hours", "Any customer meeting ends", "AE", "Median hours to next touch under 12 by day 30"],
        ["Economic buyer before proposal", "Deal enters Proposal", "AE + manager", "Share of proposals with a buyer on a call above 70%"],
        ["Answer every open question", "A question is raised on a call", "Owner named", "Zero unanswered past 5 days"],
        ["CS call on tier-1 risk", "risk signal, stated churn", "CS owner", "Called within 2 business days"],
      ], emphasis: 3 },
      brief([
        "Each morning: **focus** for the worklist. Before a call: **brief**. Each Monday: the at-risk and asking-for-more lists.",
        "Watched continuously: deal momentum, the stakeholder map, commitments on both sides, risk language, and whether activity supports the stage and close date.",
      ]),
      { type: "timeline", title: "One account, reconstructed — Quarry Lane Clinics", events: [
        { at: "2022-09-12", source: "HubSpot", event: "Closed won: Starter plan", meaning: "Customer since 2022", tone: "good" },
        { at: "2026-03-02", source: "HubSpot", event: "Main contact marked as left the company", meaning: "The only regular user is gone", tone: "risk" },
        { at: "2026-03-30", source: "Fathom", event: "\"Honestly nobody here owns this since Dana left, we barely open it.\"", meaning: "Risk on a call — no follow-up on record", tone: "risk" },
        { at: "2026-04-21", source: "Gmail", event: "\"We have decided not to renew when the term ends in May.\"", meaning: "Stated churn, three weeks after the call", tone: "bad" },
        { at: "2026-05-19", source: "HubSpot", event: "account_status → Cancelled", meaning: "The CRM learns it four weeks later", tone: "bad" },
      ] },
      { type: "table", headers: ["Generated", "Window", "Sources", "Method", "Limits"], rows: [
        ["Sep 3, 2026", "Jan 15 – Aug 31", "HubSpot, Gmail, Fathom", "Medians, never means; leakage as overlapping exposure; causes from recorded evidence", "No notetaker before April; CRM tasks not synced; a dozen lost deals unexplained"],
      ] },
      takeaways([
        "Three weeks between the warning on the call and the notice, and it was in the database the whole time. The routine above is what turns that into a call on day one.",
      ]),
    ],
  },
];

export default function ReportPreview() {
  return (
    // The canvas: a faint grid, the way a document sits on a desk. The page: plain, narrow,
    // set in one type stack with real headings, and nothing that reads as a widget.
    <div
      className="min-h-screen text-foreground"
      style={{
        backgroundColor: "hsl(var(--background))",
        backgroundImage: "linear-gradient(to right, rgba(15,23,42,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.045) 1px, transparent 1px)",
        backgroundSize: "28px 28px",
      }}
    >
      <div className="mx-auto max-w-[820px] px-6 py-10">
        <article className="rounded-sm border border-border/60 bg-background px-16 py-16 shadow-[0_1px_3px_rgba(15,23,42,0.06),0_12px_40px_-24px_rgba(15,23,42,0.25)]">
          <header className="mb-4 border-b border-border/70 pb-8">
            <p className="text-[14px] text-muted-foreground">Revenue report</p>
            <h1 className="mt-1 text-[38px] font-semibold leading-[1.15] tracking-[-0.025em]">Fernpoint</h1>
            <p className="mt-3 text-[15px] leading-[1.6] text-muted-foreground">
              January 15 to August 31, 2026. Generated from HubSpot, Gmail and Fathom: 240 deals, 3,200 email threads and 320 recorded calls.
              Every number in this preview is invented to exercise the layout.
            </p>
          </header>
          {SECTIONS.map((sec, i) => (
            <ReportSectionFrame key={i} sec={sec} index={i}>
              <SectionBody sec={sec} />
            </ReportSectionFrame>
          ))}
        </article>
      </div>
    </div>
  );
}
