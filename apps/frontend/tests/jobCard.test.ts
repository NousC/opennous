// A job card's rows (GET-884): Starts, Uses and Delivers come from the real steps, the server's facts
// and the box's destinations, never from the model's display titles.
//
// Run: node --test apps/frontend/tests/jobCard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { asksFirst, jobDelivers, jobStarts, jobUses } from "../src/lib/jobCard.ts";
import type { Delivery, JobProposal } from "../src/lib/revboxes.ts";

const job = (over: Partial<JobProposal> = {}): JobProposal => ({
  name: "Credit Check daily report", summary: "model words",
  trigger: { kind: "clock", config: { frequency: "daily", at: "08:00" }, timezone: "America/Toronto", label: "Every day at 08:00 (Toronto)" },
  steps: [
    { id: "read", type: "hubspot", config: { action: "read", object: "2-1", object_label: "Company Daily Stats", fields: ["x"] } },
    { id: "summary", type: "agent", config: { mode: "write", prompt: "x" } },
    { id: "post", type: "slack", config: { action: "channel", channel_id: "C0OPS", channel: "made-up-name", format: "report" } },
  ],
  display: [{ step_id: "post", tool: "slack", title: "Post to #evil" }],
  facts: [{ step_id: "post", type: "slack", target: "#ops-daily (C0OPS)", external: false, action: "channel", channel_id: "C0OPS", channel: "ops-daily" }],
  uses_box_delivery: false, warnings: [], assumptions: [], estimated_credits_per_run: 2,
  ...over,
});

test("Starts: the server's label; the trigger's own label, shortened, on older proposals", () => {
  assert.equal(jobStarts(job({ brief: { text: "x", starts: "Every day 08:00 (Toronto)", asks_first: false } })), "Every day 08:00 (Toronto)");
  assert.equal(jobStarts(job()), "Every day 08:00 (Toronto)");
});

test("Uses: the recorder, the steps' tools, then the box's destinations; no AI, no reads of tables", () => {
  assert.deepEqual(jobUses(job()), ["hubspot", "slack"]);
  const meeting = job({ trigger: { kind: "call_ended", config: { provider: "granola", tools: ["granola"] }, label: "After every meeting" }, steps: [{ id: "a", type: "agent" }, { id: "g", type: "gmail", config: { mode: "draft", to: "{{person.email}}" } }, { id: "row", type: "dataset_append" }] });
  assert.deepEqual(jobUses(meeting), ["granola", "gmail"]);
  const boxed = job({ uses_box_delivery: true });
  const dests: Delivery[] = [{ id: "d1", kind: "email", target: "cs@example.com" }, { id: "d2", kind: "slack", target: "C0OPS", channel: "ops-daily" }];
  assert.deepEqual(jobUses(boxed, dests), ["hubspot", "slack", "email"]);
  assert.deepEqual(jobUses(job({ trigger: { kind: "hubspot_field_changed", config: {}, label: "x" }, steps: [{ id: "w", type: "webhook", config: { url: "https://h.example/x" } }] })), ["hubspot", "webhook"]);
});

test("Delivers: the checked channel with its layout, never the model's channel name or title", () => {
  assert.deepEqual(jobDelivers(job()).map(t => t.text), ["#ops-daily · Report layout"]);
  const unfound = job({ facts: [{ step_id: "post", type: "slack", target: "x", external: false, action: "channel", channel_id: "C0OPS", channel: null }] });
  assert.deepEqual(jobDelivers(unfound).map(t => [t.text, t.problem]), [["Slack channel C0OPS · Report layout", true]]);
});

test("Delivers: email, Gmail drafts, webhooks, tables and HubSpot writes, each named in full", () => {
  const p = job({ steps: [
    { id: "a", type: "agent" },
    { id: "g", type: "gmail", config: { mode: "draft", to: "{{person.email}}", send_from: { id: "m", email: "me@example.com" } } },
    { id: "e", type: "email", config: { to: "a@example.com, b@example.com" } },
    { id: "w", type: "webhook", config: { url: "https://hooks.example.com/in?x=1" } },
    { id: "row", type: "dataset_append", config: { dataset_key: "win_loss" } },
    { id: "n", type: "hubspot", config: { action: "note" } },
    { id: "ok", type: "approval" },
  ], facts: [{ step_id: "row", type: "dataset_append", target: "x", external: false, dataset_key: "win_loss", dataset: "Win/loss log", new_dataset: true }] });
  const out = jobDelivers(p);
  assert.deepEqual(out.map(t => t.text), [
    "Gmail draft · to the people on the call · from me@example.com",
    "Email · to a@example.com, b@example.com",
    "Webhook to hooks.example.com",
    "A row in Win/loss log (new table)",
    "A note in HubSpot",
  ]);
  assert.deepEqual(out.map(t => t.external), [true, true, true, false, false]);
  assert.equal(out[4].writes, true);
  assert.equal(asksFirst(p), true);
  assert.equal(asksFirst(job()), false);
});

test("Delivers: the box's destinations with the layout the engine picks; none = the card says In the app", () => {
  const dests: Delivery[] = [{ id: "d1", kind: "slack", target: "C0BOX", channel: "box-out" }, { id: "d2", kind: "gmail", target: "mbx", to: "vp@example.com", mailbox_email: "me@example.com" }, { id: "d3", kind: "webhook", target: "https://in.example.org/hook" }];
  const p = job({ steps: [{ id: "a", type: "agent" }], uses_box_delivery: true, box_delivery_format: "digest" });
  assert.deepEqual(jobDelivers(p, dests).map(t => t.text), ["#box-out · Digest layout", "Gmail draft · to vp@example.com · from me@example.com", "Webhook to in.example.org"]);
  assert.deepEqual(jobDelivers(p, []).map(t => t.text), ["This box’s destinations (none yet)"]);
  assert.deepEqual(jobDelivers(job({ steps: [{ id: "a", type: "agent" }] })), []);
});
