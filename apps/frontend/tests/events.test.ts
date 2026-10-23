// The Events page (GET-939): the request it makes and the line each event row says.
//
// Run: node --test apps/frontend/tests/events.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_FILTERS, EVENT_FILTER_GROUPS, rangeSince, sentenceCase, eventDay, eventTone, eventFamilyLabel, eventLabel, eventSummary, eventsUrl, filterLabel, mergeNewer, needsSubscription, type NousEvent } from "../src/lib/events.ts";

const ev = (type: string, extra: Partial<NousEvent> = {}): NousEvent => ({ id: "e1", type, occurred_at: "2026-10-16T10:00:00Z", ...extra });

// eventsUrl
test("names the workspace and only the filters that are set", () => {
  assert.equal(eventsUrl("", "ws1"), "/v2/events?workspaceId=ws1");
  assert.equal(eventsUrl("https://api.x", "ws1", { type: "signal.*", account: "a1", after: "e9", limit: 25 }),
    "https://api.x/v2/events?workspaceId=ws1&type=signal.*&account=a1&starting_after=e9&limit=25");
});

// eventSummary
test("a signal says its title, else its text", () => {
  assert.equal(eventSummary(ev("signal.stakeholder_left", { data: { title: "Champion left: Sarah Chen" } })), "Champion left: Sarah Chen");
  assert.equal(eventSummary(ev("signal.churn_risk", { data: { text: "They are evaluating Ramp" } })), "They are evaluating Ramp");
});
test("calls, replies, deals, ICP and people each say what happened", () => {
  assert.equal(eventSummary(ev("conversation.call_ended", { data: { title: "Acme weekly" } })), "Acme weekly");
  assert.equal(eventSummary(ev("conversation.reply_received", { data: { subject: "Re: pricing" } })), "Re: pricing");
  assert.equal(eventSummary(ev("deal.won", { deal: { name: "Acme renewal" } })), "Acme renewal");
  assert.equal(eventSummary(ev("deal.lost")), "Deal lost");
  assert.equal(eventSummary(ev("deal.stage_changed", { data: { stage: "negotiation" } })), "Stage is now negotiation");
  assert.equal(eventSummary(ev("icp.score_changed", { data: { from: { score: 40 }, to: { score: 82 } } })), "40 → 82");
  assert.equal(eventSummary(ev("icp.score_changed", { data: { from: null, to: { score: 82 } } })), "Scored 82");
  assert.equal(eventSummary(ev("people.added", { data: { count: 1 } })), "1 person added");
  assert.equal(eventSummary(ev("interaction.meeting_held")), "");
});

// filters and the curl line
test("every filter but All is a family the API accepts", () => {
  for (const f of EVENT_FILTERS.slice(1)) assert.match(f.type ?? "", /^[a-z]+\.\*$/);
  assert.equal(eventFamilyLabel("signal.next_step"), "Signals");
});
test("labels: a known type by name, an unknown one from its own words", () => {
  assert.equal(eventLabel("signal.stakeholder_left"), "Stakeholder left");
  assert.equal(eventLabel("signal.new_kind"), "New kind");
  assert.equal(filterLabel(null), "All events");
  assert.equal(filterLabel("signal.*"), "All signals");
  assert.equal(filterLabel("deal.won"), "Deal won");
});

test("the filter offers every signal, and knows which families need a webhook", () => {
  // Feature requested (claims about us, a customer asking for what we do not have) is the 23rd.
  assert.equal(EVENT_FILTER_GROUPS[0].types.length, 23);
  assert.ok(EVENT_FILTER_GROUPS[0].types.includes("signal.feature_requested"));
  // A next step agreed stays in the raw feed; missed and slipped join it (GET-954), and the four
  // product-usage signals from PostHog (GET-751).
  for (const t of ["signal.next_step", "signal.next_step_missed", "signal.next_step_slipped",
    "signal.usage_dropped", "signal.account_inactive", "signal.feature_adopted", "signal.seat_dropped",
    "signal.product_qualified", "signal.seats_growing", "signal.account_activated"]) assert.ok(EVENT_FILTER_GROUPS[0].types.includes(t), t);
  assert.equal(eventTone("signal.account_inactive"), "risk");
  assert.equal(eventTone("signal.feature_adopted"), "positive");
  assert.equal(eventTone("signal.next_step_missed"), "risk");
  assert.equal(eventLabel("signal.next_step_slipped"), "Next step slipped");
  assert.equal(needsSubscription("deal.won"), true);
  assert.equal(needsSubscription("deal.*"), true);
  assert.equal(needsSubscription("signal.churn_risk"), false);
  assert.equal(needsSubscription(null), false);
});

test("a poll adds only what is new, on top, and keeps what was paged in", () => {
  const a = ev("deal.won", { id: "a" }), b = ev("deal.won", { id: "b" }), c = ev("deal.won", { id: "c" });
  const loaded = [b, c];
  assert.deepEqual(mergeNewer(loaded, [a, b]).map((e) => e.id), ["a", "b", "c"]);
  assert.equal(mergeNewer(loaded, [b]), loaded, "nothing new: the same list");
});

test("tones: won green, lost red, an objection amber, a call grey", () => {
  assert.equal(eventTone("deal.won"), "positive");
  assert.equal(eventTone("deal.lost"), "risk");
  assert.equal(eventTone("signal.stakeholder_left"), "risk");
  assert.equal(eventTone("signal.objection_raised"), "warning");
  assert.equal(eventTone("conversation.call_ended"), "neutral");
  assert.equal(eventTone("signal.something_new"), "neutral");
});

test("the interpreted events (GET-950) have a family, a line and a tone", () => {
  assert.equal(eventFamilyLabel("account.champion_left"), "Accounts");
  assert.equal(eventLabel("account.champion_left"), "Champion left");
  assert.equal(eventLabel("deal.stalled"), "Deal stalled");
  assert.equal(eventSummary(ev("account.champion_left", { data: { person: { name: "Mara Quill" }, replacement: { name: "Ines Varga" } } })), "Mara Quill left; Ines Varga takes over");
  assert.equal(eventSummary(ev("account.expansion_requested", { data: { product: "Lumen Scan" } })), "Asked for more Lumen Scan");
  assert.equal(eventSummary(ev("deal.stalled", { data: { stage: "Proposal sent", days_in_stage: 25 } })), "25 days in Proposal sent");
  assert.equal(eventTone("account.champion_left"), "risk");
  assert.equal(eventTone("account.expansion_requested"), "positive");
  assert.equal(eventTone("deal.stalled"), "warning");
  assert.ok(EVENT_FILTER_GROUPS.find((g) => g.family === "deal.*")?.types.includes("deal.stalled"));
  assert.equal(needsSubscription("account.champion_left"), false, "read from signals, logged for every workspace");
  assert.equal(needsSubscription("deal.stalled"), false, "computed for every workspace");
  assert.equal(needsSubscription("deal.*"), true, "the rest of the family still needs a webhook");
});

test("people added is not a filter on the feed (GET-1014)", () => {
  assert.ok(!EVENT_FILTER_GROUPS.some((g) => g.types.includes("people.added")));
});

test("a date range starts today at midnight, or N days back; any time has no start", () => {
  const now = new Date(2026, 9, 22, 15, 30);
  assert.equal(rangeSince("any", now), null);
  assert.equal(rangeSince("today", now), new Date(2026, 9, 22, 0, 0).toISOString());
  assert.equal(rangeSince("7d", now), new Date(now.getTime() - 7 * 86_400_000).toISOString());
  assert.match(eventsUrl("https://api", "ws", { since: "2026-10-15T00:00:00.000Z" }), /since=2026-10-15T00%3A00%3A00.000Z/);
});

// Sentence case, insight lines and day headings (the Events feed polish)
test("a Title Case signal reads in sentence case; acronyms and names keep their capitals", () => {
  const fact = "Not a silver bullet, they said. The handoff PDF is too long.";
  assert.equal(sentenceCase("Not A Silver Bullet", fact), "Not a silver bullet");
  assert.equal(sentenceCase("Handoff PDF Verbosity", fact), "Handoff PDF verbosity");
  assert.equal(sentenceCase("Heavy Grokbot Experiments", "They run heavy experiments with Grokbot every week."), "Heavy Grokbot experiments");
  assert.equal(sentenceCase("Grok vs Nous Data", "Compared Grok with what Nous gives them."), "Grok vs Nous data");
  assert.equal(sentenceCase("Champion Left: Sarah Chen", "Sarah Chen left the company."), "Champion left: Sarah Chen");
  // Nothing to check names against, or already sentence case: left alone.
  assert.equal(sentenceCase("Champion left: Sarah Chen", null), "Champion left: Sarah Chen");
  assert.equal(sentenceCase("Ready for stakeholders", "Ready to present."), "Ready for stakeholders");
  assert.equal(eventSummary(ev("signal.objection_raised", { data: { title: "Agent Confidence Critique", text: "They do not trust the agent's confidence." } })), "Agent confidence critique");
});

test("a new insight says what it is and how many accounts", () => {
  assert.equal(eventSummary(ev("insight.emerged", { data: { insight: { title: "Wants call recording built in", accounts: 5 } } })), "Wants call recording built in · 5 accounts");
  assert.equal(eventSummary(ev("insight.rising", { data: { insight: { topic: "Pricing", accounts: 1 } } })), "Pricing · 1 account");
});

test("events sit under Today, Yesterday, then the date", () => {
  const now = new Date(2026, 9, 22, 15, 0);
  assert.equal(eventDay(new Date(2026, 9, 22, 9, 0).toISOString(), now), "Today");
  assert.equal(eventDay(new Date(2026, 9, 21, 23, 0).toISOString(), now), "Yesterday");
  assert.equal(eventDay(new Date(2026, 9, 7, 12, 0).toISOString(), now), "7 Oct");
  assert.equal(eventDay(new Date(2025, 11, 30, 12, 0).toISOString(), now), "30 Dec 2025");
});
