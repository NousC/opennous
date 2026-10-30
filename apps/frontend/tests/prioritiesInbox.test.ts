// The Priorities inbox's list rules (GET-678, reshaped by GET-681), pinned. Priorities holds three
// groups only: "After your meetings" (one row per waiting follow-up card, named for the meeting),
// "From signals" (GET-944: the Deal signals drafts, named for the signal) and "Drafts to review"
// (every other pending_actions draft, named for the automation that wrote it). Briefs,
// reach-outs, quiet accounts, handoffs and deals past close are not Priorities'. A group of more
// than three shows three and says how many more.
//
// Run: node --test apps/frontend/tests/prioritiesInbox.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, TABS, buildItems, followUpLine, groupItems, isInboxTab, meetingWhen, openCount, signalLine, signalOf, tabOf, visibleItems, type InboxAction, type InboxOutcome } from "../src/components/priorities/inboxModel.ts";

const NOW = new Date("2026-10-02T15:30:00");
const acct = (n: string) => ({ id: `id-${n}`, name: n, domain: `${n.toLowerCase()}.example` });
const rec = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, kind, title: `x ${name}`, why: `why ${name}`, entity_id: `id-${name}`, account: acct(name), when: null, created_at: "2026-10-01T09:00:00", ...extra,
});
const card = (id: string, name: string, meeting: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  rec(id, "follow_up_call", name, { due: "today", followup: { status: "ready", email: { subject: `Next steps ${name}` }, meeting, meetings: meeting ? [meeting] : [] }, ...extra });

const data = {
  recommendations: [
    card("fu:1", "Bravo", { kind: "Call", title: "Security review", at: "2026-10-02T15:00:00" }),
    card("fu:3", "Kilo", { kind: "Demo", title: null, at: "2026-10-01T10:30:00" }),
    rec("fu:2", "follow_up_call", "Charlie", { due: "today", followup: { status: "approved" } }),
    rec("r1", "follow_up_call", "Delta", { due: "today" }),
    rec("q1", "follow_up_quiet", "Echo", { due: "this_week" }),
    rec("b1", "meeting_brief", "Foxtrot", { when: "2026-10-02T15:30:00", due: "2026-10-02T15:30:00" }),
    rec("o1", "reach_out", "Golf", { due: "today" }),
    rec("h1", "handoff", "Alpha", { why: "Closed won — the handoff brief is ready.", document_id: "d1" }),
  ],
  deal_changes: [
    { deal_id: "dl1", deal: "Platform", account_id: "id-Bravo", account: "Bravo", domain: "bravo.example", stage: "Proposal", close_date: "2026-09-23" },
  ],
};

const draft = (id: string, extra: Partial<InboxAction> = {}): InboxAction => ({
  id, kind: "email", recipient: "Pat Lee", recipient_email: "pat@x.example", linkedin_url: null, subject: `Subject ${id}`, body: "Hi",
  rationale: null, status: "pending", entity_id: `p-${id}`, rec_id: null, created_at: "2026-10-02T10:00:00",
  origin: { source: "routine", name: "Deal risk detection", why: null }, account: { id: `c-${id}`, name: `Acct ${id}`, domain: `${id}.example` },
  ...extra,
});

test("three groups only, meetings first; briefs, nudges, handoffs and deals are not listed", () => {
  assert.deepEqual(GROUPS.map((g) => g.label), ["After your meetings", "From signals", "Drafts to review"]);
  const items = buildItems({ ...data, actions: [draft("a1")] }, NOW);
  assert.deepEqual(items.map((i) => i.key), ["fu:1", "fu:3", "act:a1"]);
  assert.deepEqual(groupItems(items, new Set()).map((g) => g.label), ["After your meetings", "Drafts to review"]);
  // An empty group is left out; nothing at all is an empty list.
  assert.deepEqual(groupItems(buildItems(data, NOW), new Set()).map((g) => g.label), ["After your meetings"]);
  assert.deepEqual(buildItems({ recommendations: [rec("b1", "meeting_brief", "F")] }, NOW), []);
});

test("a meeting row names the account and the meeting, never the email", () => {
  const [bravo, kilo] = buildItems(data, NOW);
  assert.equal(bravo.kind, "meeting");
  assert.equal(bravo.title, "Bravo");
  assert.equal(bravo.sub, "Security review · Today 15:00");
  assert.equal(bravo.at, "2026-10-02T15:00:00");
  assert.deepEqual(bravo.meeting, { title: "Security review", kind: "Call", at: "2026-10-02T15:00:00" });
  assert.equal(bravo.href, "/?followup=fu%3A1");
  // No title: the kind names it.
  assert.equal(kilo.sub, "Demo · Yesterday 10:30");
  // A card merged over two meetings: the latest names it, a count says the rest.
  const merged = buildItems({ recommendations: [rec("fu:9", "follow_up_call", "Lima", { followup: { status: "ready", meeting: { kind: "Call", title: "Scoping", at: "2026-09-29T14:00:00" }, meetings: [{ kind: "Demo", at: "2026-09-26T10:00:00" }, { kind: "Call", at: "2026-09-29T14:00:00" }] } })] }, NOW)[0];
  assert.equal(merged.sub, "Scoping +1 · 29 Sep 14:00");
});

test("only cards still waiting are listed; an older nudge without a card is not a meeting wrap-up", () => {
  const keys = buildItems(data, NOW).map((i) => i.key);
  assert.equal(keys.includes("fu:2"), false);
  assert.equal(keys.includes("r1"), false);
});

test("meetingWhen reads today, yesterday, then the date", () => {
  assert.equal(meetingWhen("2026-10-02T09:05:00", NOW), "Today 09:05");
  assert.equal(meetingWhen("2026-10-01T17:00:00", NOW), "Yesterday 17:00");
  assert.equal(meetingWhen("2026-09-28T08:00:00", NOW), "28 Sep 08:00");
  assert.equal(meetingWhen(null, NOW), "");
});

test("a waiting draft is a row to approve: account, automation and subject, dated when it was drafted", () => {
  const [i] = buildItems({ actions: [draft("a1")] }, NOW);
  assert.equal(i.kind, "approve");
  assert.equal(i.key, "act:a1");
  assert.equal(i.title, "Acct a1");
  assert.equal(i.sub, "Deal risk detection · Subject a1");
  assert.equal(i.domain, "a1.example");
  assert.equal(i.at, "2026-10-02T10:00:00");
  assert.equal(i.by, "Deal risk detection");
  assert.equal(i.href, "/accounts/c-a1");
  assert.equal(buildItems({ actions: [draft("a2", { account: null })] }, NOW)[0].title, "Pat Lee");
  assert.equal(buildItems({ actions: [draft("a3", { kind: "linkedin_message", subject: null, origin: { source: "play", name: "Deal rescue" } })] }, NOW)[0].sub, "Deal rescue · LinkedIn message");
  assert.equal(buildItems({ actions: [draft("a4", { origin: { source: "rec", name: "Stale deal detection", why: "Deal sat in Proposal for 16 days." } })] }, NOW)[0].why, "Deal sat in Proposal for 16 days.");
});

test("each group reads newest first", () => {
  const items = buildItems({ actions: [draft("old", { created_at: "2026-09-30T08:00:00" }), draft("new", { created_at: "2026-10-02T12:00:00" })] }, NOW);
  assert.deepEqual(items.map((i) => i.key), ["act:new", "act:old"]);
});

test("a decided draft keeps its row with the result; the counts leave it out; a failed one is not listed", () => {
  const items = buildItems({ actions: [draft("a1", { status: "sent" }), draft("a2", { status: "rejected" }), draft("a3"), draft("a4", { status: "failed" })] }, NOW);
  assert.deepEqual(items.map((i) => [i.key, i.done ?? null]), [["act:a1", "Sent"], ["act:a2", "Done"], ["act:a3", null]]);
  assert.equal(openCount(items), 1);
  const [g] = groupItems(items, new Set());
  assert.equal(g.count, 1);
  assert.equal(g.shown.length, 3);
  // The ⚑ count is meetings plus drafts still open.
  assert.equal(openCount(buildItems({ ...data, actions: [draft("x"), draft("y", { status: "sent" })] }, NOW)), 3);
});

test("a group of more than three shows three and counts the rest; expanding shows all", () => {
  const items = buildItems({ actions: ["a", "b", "c", "d", "e"].map((x) => draft(x)) }, NOW);
  const [g] = groupItems(items, new Set());
  assert.equal(g.shown.length, 3);
  assert.equal(g.more, 2);
  assert.equal(groupItems(items, new Set(["approve"]))[0].shown.length, 5);
});

test("keyboard order follows what is on screen", () => {
  const groups = groupItems(buildItems({ ...data, actions: [draft("a1")] }, NOW), new Set());
  assert.deepEqual(visibleItems(groups).map((i) => i.key), ["fu:1", "fu:3", "act:a1"]);
});

test("an automation run waiting on review sits under Drafts to review, named by its account (GET-737)", () => {
  const items = buildItems({
    runs: [{ run_id: "r1", requested_at: "2026-10-05T18:00:00Z", automation: { id: "a1", name: "Call summary" },
      account: { id: "c1", name: "Ridgeway Haulage", domain: "ridgeway-haulage.example" }, why: "After the call: Theo x Dana", what: "Email draft · 3 tasks" }],
  });
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].key, items[0].kind, items[0].title, items[0].sub, items[0].href],
    ["run:r1", "approve", "Ridgeway Haulage", "Call summary · Email draft · 3 tasks", "/accounts/c1"]);
});

// GET-944: the Deal signals drafts are a signal's next move, listed under From signals.
const signalDraft = (id: string, signal: Record<string, unknown>, extra: Partial<InboxAction> = {}) => draft(id, {
  origin: { source: "rec", name: "Deal signals", why: "Decision maker identified", builtin: "deal_signals",
    signal: { kind: "stakeholder_identified", label: "Stakeholder identified", said_at: "2026-10-01T10:00:00", text: "CEO has a say in the decision (name not yet known)", quote: "Our CEO signs off", speaker: "Dana", research: null, ...signal } },
  ...extra,
});

test("a Deal signals draft sits under From signals, between meetings and drafts, named by the signal", () => {
  const items = buildItems({ ...data, actions: [draft("d1"), signalDraft("s1", { research: { name: "Dana Whitfield", title: "CEO", source_url: "https://x", source_title: null, contact_id: null } })] }, NOW);
  const groups = groupItems(items, new Set());
  assert.deepEqual(groups.map((g) => g.label), ["After your meetings", "From signals", "Drafts to review"]);
  const s = items.find((i) => i.key === "act:s1")!;
  assert.equal(s.kind, "signal");
  assert.equal(s.sub, "Stakeholder identified: Dana Whitfield, CEO");
  assert.equal(items.find((i) => i.key === "act:d1")!.kind, "approve");
});

test("a signal row with nothing researched says what was said, without the 'name not known'", () => {
  assert.equal(signalLine({ kind: "stakeholder_identified", label: "Stakeholder identified", said_at: null, text: "CEO has a say in the decision (name not yet known)", quote: null, speaker: null, research: null }, null),
    "Stakeholder identified: CEO has a say in the decision");
  assert.equal(signalLine(null, "Subject"), "Subject");
});

test("a snoozed signal waits until its time; a decided one keeps its row", () => {
  const later = signalDraft("s1", {}, {});
  later.origin!.snoozed_until = "2026-10-05T09:00:00";
  const past = signalDraft("s2", {}, {});
  past.origin!.snoozed_until = "2026-10-01T09:00:00";
  const keys = buildItems({ actions: [later, past] }, NOW).map((i) => i.key);
  assert.deepEqual(keys, ["act:s2"]);
  const sent = signalDraft("s3", {}, { status: "sent" });
  sent.origin!.snoozed_until = "2026-10-05T09:00:00";
  assert.deepEqual(buildItems({ actions: [sent] }, NOW).map((i) => i.done), ["Sent"]);
});

test("a 5-day follow-up reads as one (GET-949)", () => {
  const n = signalDraft("n1", { nudge: true, research: { name: "Dana Whitfield", title: "CEO", source_url: null, source_title: null, contact_id: null } });
  assert.equal(buildItems({ actions: [n] }, NOW)[0].sub, "Follow-up · Stakeholder identified: Dana Whitfield, CEO");
});

test("churn risk and expansion drafts sit under From signals; a stale deal draft stays a draft (GET-953)", () => {
  const by = (id: string, builtin: string) => draft(id, { origin: { source: "rec", name: id, why: null, builtin } });
  const items = buildItems({ actions: [by("risk", "deal_risk"), by("exp", "expansion"), by("stale", "stale_deal")] }, NOW);
  assert.deepEqual(items.map((i) => [i.key, i.kind]).sort(), [["act:exp", "signal"], ["act:risk", "signal"], ["act:stale", "approve"]]);
});

// The Inbox page's tabs (2026-10-29).
const outcome = (id: string, extra: Partial<InboxOutcome> = {}): InboxOutcome => ({
  id, routine_id: "wf1", automation: "Weekly pipeline report", status: "ok", started_at: "2026-10-02T08:00:00",
  document_id: null, document_title: null, ...extra,
});

test("tabs: Post-meetings, Follow-ups, Results", () => {
  assert.deepEqual(TABS.map((t) => t.label), ["Post-meetings", "Follow-ups", "Results"]);
  assert.equal(isInboxTab("act"), true);
  assert.equal(isInboxTab("signals"), false);
  assert.equal(isInboxTab(null), false);
});

test("tabs: signals, drafts and runs to review all land in Follow-ups", () => {
  const signal = draft("s1", { origin: { source: "routine", name: "Deal signals", builtin: "deal_signals", why: null } });
  const stale = draft("d1", { origin: { source: "routine", name: "Stale deal detection", why: null } });
  const run = { run_id: "r1", requested_at: "2026-10-02T09:00:00", automation: { id: "a1", name: "Follow-up" }, account: null, why: null };
  const items = buildItems({ ...data, actions: [signal, stale], runs: [run], outcomes: [outcome("o1")] }, NOW);
  const by = (tab: string) => items.filter((i) => tabOf(i) === tab).map((i) => i.key);
  assert.deepEqual(by("meetings"), ["fu:1", "fu:3"]);
  assert.deepEqual(new Set(by("act")), new Set(["act:s1", "act:d1", "run:r1"]));
  assert.deepEqual(by("workflows"), ["out:o1"]);
});

test("tabs: a workflow's outcome is there to read, so it never counts", () => {
  const items = buildItems({ outcomes: [outcome("o1"), outcome("o2")] }, NOW);
  assert.equal(items.length, 2);
  assert.equal(openCount(items), 0);
});

test("tabs: only finished runs, newest first; a run that wrote a page opens it", () => {
  const items = buildItems({ outcomes: [
    outcome("old", { started_at: "2026-09-30T08:00:00" }),
    outcome("new", { started_at: "2026-10-02T08:00:00", document_id: "doc9", document_title: "Pipeline, week 40" }),
    outcome("bad", { status: "error" }),
  ] }, NOW);
  assert.deepEqual(items.map((i) => i.key), ["out:new", "out:old"]);
  assert.equal(items[0].href, "/pages/doc9");
  assert.equal(items[0].sub, "Pipeline, week 40");
  assert.equal(items[1].href, "/rev-plays/wf1?tab=runs");
});

// Follow-ups' columns (2026-10-29).
test("follow-ups: the first column says what to follow up on", () => {
  const signal = draft("s1", { origin: { source: "routine", name: "Deal signals", builtin: "deal_signals", why: null,
    signal: { kind: "objection", label: "Objection raised", said_at: null, text: "Dana asked for SOC 2", quote: null, speaker: null, research: null } } });
  const stale = draft("d1", { subject: "Checking in", origin: { source: "routine", name: "Stale deal detection", why: "Deal sat in Proposal for 38 days" } });
  const bare = draft("d2", { subject: "Next steps", rationale: null });
  const run = { run_id: "r1", requested_at: null, automation: { id: "a1", name: "Deal signals" }, account: null, why: "Dominic is worried about data isolation", what: "Email draft" };
  const quiet = { run_id: "r2", requested_at: null, automation: { id: "a1", name: "Follow-up" }, account: null, why: null, what: "Email draft · 3 tasks" };
  const items = buildItems({ actions: [signal, stale, bare], runs: [run, quiet] }, NOW);
  const line = (k: string) => followUpLine(items.find((i) => i.key === k)!);
  assert.equal(line("act:s1"), "Objection raised: Dana asked for SOC 2");
  assert.equal(line("act:d1"), "Deal sat in Proposal for 38 days");
  assert.equal(line("act:d2"), "Next steps");
  assert.equal(line("run:r1"), "Dominic is worried about data isolation");
  assert.equal(line("run:r2"), "Email draft · 3 tasks");
});

test("follow-ups: the Signal column is the signal's kind, else the workflow", () => {
  const signal = draft("s1", { origin: { source: "routine", name: "Deal signals", builtin: "deal_signals", why: null,
    signal: { kind: "expansion_signal", label: "Expansion signal", said_at: null, text: null, quote: null, speaker: null, research: null } } });
  const stale = draft("d1", { origin: { source: "routine", name: "Stale deal detection", why: null } });
  const items = buildItems({ actions: [signal, stale] }, NOW);
  assert.equal(signalOf(items.find((i) => i.key === "act:s1")!), "Expansion signal");
  assert.equal(signalOf(items.find((i) => i.key === "act:d1")!), "Stale deal detection");
});
