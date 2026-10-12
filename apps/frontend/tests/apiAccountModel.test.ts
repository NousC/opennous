// The API plan's accounts list and record rules (GET-634), pinned.
//
// Run: node --test apps/frontend/tests/apiAccountModel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimText, confidenceOf, dealLabel, factGroups, hasTiers, inTab, sourceOf, tierCounts, tierOf,
} from "../src/components/account/apiAccountModel.ts";

test("tiers: the tierFromScore thresholds, and below 50 is no tier", () => {
  assert.equal(tierOf(92), 1);
  assert.equal(tierOf(85), 1);
  assert.equal(tierOf(84), 2);
  assert.equal(tierOf(70), 2);
  assert.equal(tierOf(50), 3);
  assert.equal(tierOf(49), null);
  assert.equal(tierOf(null), null);
  assert.equal(tierOf(undefined), null);
});

test("tier counts and tabs", () => {
  const rows = [{ icpScore: 90 }, { icpScore: 72 }, { icpScore: 71 }, { icpScore: 55 }, { icpScore: 10 }, { icpScore: null }];
  const c = tierCounts(rows);
  assert.deepEqual(c, { all: 6, t1: 1, t2: 2, t3: 1 });
  assert.ok(hasTiers(c));
  assert.ok(!hasTiers(tierCounts([{ icpScore: null }, { icpScore: 20 }])));
  assert.ok(inTab(10, "all"));
  assert.ok(inTab(72, "t2"));
  assert.ok(!inTab(72, "t1"));
  assert.ok(!inTab(null, "t3"));
});

test("confidence bands", () => {
  assert.equal(confidenceOf(0.95), "High");
  assert.equal(confidenceOf(0.8), "High");
  assert.equal(confidenceOf(0.6), "Medium");
  assert.equal(confidenceOf(0.2), "Low");
  assert.equal(confidenceOf(null), null);
});

test("claim values read as one line", () => {
  assert.equal(claimText({ value: "Payments" }), "Payments");
  assert.equal(claimText(["Salesforce", "Gong"]), "Salesforce, Gong");
  assert.equal(claimText(210), "210");
  assert.equal(claimText(null), "");
});

test("sources: providers only, never how a fact was written", () => {
  assert.equal(sourceOf("signal_extraction", "fireflies"), "fireflies");
  assert.equal(sourceOf("fellow:health"), "fellow");
  assert.equal(sourceOf("google-calendar"), "google_calendar");
  assert.equal(sourceOf("manual", "agent", null), null);
});

test("fact groups: company from claims, open CRM deals, intel by category in order", () => {
  const groups = factGroups({
    claims: [
      { property: "industry", value: "Payments", confidence: 0.9, freshness: "fresh", last_observed_at: "2026-10-01T00:00:00Z" },
      { property: "employee_count", value: 210, confidence: 0.6, freshness: "stale", last_observed_at: "2026-08-01T00:00:00Z" },
      { property: "icp_score", value: 92 },
    ],
    company: { industry: "ignored, the claim wins", location: "London" },
    deals: [
      { id: "d1", name: "Platform annual", stage: "Proposal", status: "open", value: 132000, close_date: "2026-10-31", hubspot_url: "https://x" },
      { id: "d2", name: "Old", stage: "Closed Won", status: "won", value: 5, close_date: null },
      { id: "account", implied: true, name: "Implied", stage: null, status: "open", value: null, close_date: null },
    ],
    notes: [
      { id: "n1", category: "pain", content: "Reps lose a day a week", confidence: 0.85, created_at: "2026-09-20T00:00:00Z", source: "signal_extraction", metadata: { extraction_source: "fireflies" } },
      { id: "n2", category: "objection", content: "Needs EU residency", confidence: 0.9, created_at: "2026-09-21T00:00:00Z", metadata: { voiced_by_contact_id: "p1" } },
      { id: "n3", category: "objection", content: "A brief", metadata: { doc_type: "meeting_brief" } },
      { id: "n4", category: "general", content: "bookkeeping", intel: false },
    ],
    order: ["objection", "pain"],
    categoryName: (c) => c === "objection" ? "Objection" : c === "pain" ? "Pain" : c,
    nameOf: (id) => (id === "p1" ? "Maya Lindqvist" : null),
  });
  assert.deepEqual(groups.map((g) => g.title), ["Company", "Deal", "Objection", "Pain"]);
  const [company, deal, objection, pain] = groups;
  assert.deepEqual(company.facts.map((f) => [f.label, f.value, f.confidence, f.stale]), [
    ["Industry", "Payments", "High", false],
    ["Headcount", "210", "Medium", true],
    ["Location", "London", null, false],
  ]);
  assert.equal(deal.facts.length, 1);
  assert.match(deal.facts[0].value, /^\$132,000 · Proposal · closes 31 Oct$/);
  assert.equal(deal.facts[0].source, "hubspot");
  assert.equal(objection.facts.length, 1);
  assert.equal(objection.facts[0].label, "Maya Lindqvist");
  assert.equal(pain.facts[0].source, "fireflies");
  assert.equal(pain.facts[0].confidence, "High");
});

test("fact groups: nothing known is nothing shown", () => {
  assert.deepEqual(factGroups({}), []);
});

test("a deal named after its account drops the account's name on that account", () => {
  assert.equal(dealLabel("Meridian Analytics · Platform", "Meridian Analytics"), "Platform");
  assert.equal(dealLabel("Meridian Analytics - RevOps seats", "meridian analytics"), "RevOps seats");
  assert.equal(dealLabel("Meridian Analytics", "Meridian Analytics"), "Meridian Analytics");
  assert.equal(dealLabel("Platform annual", "Kestrel (UK)"), "Platform annual");
  assert.equal(dealLabel("Platform annual", null), "Platform annual");
});
