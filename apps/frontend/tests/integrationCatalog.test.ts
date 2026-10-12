// The Add integration dialog's catalogue rules (GET-638), pinned.
//
// Run: node --test apps/frontend/tests/integrationCatalog.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  catalogCategoryOf, matchesSearch, neverFor, railCounts, readsFor, sortByRail, tileLine, RAIL,
} from "../src/components/integrations/integrationCatalog.ts";

const P = (name: string, display_name: string, category: string | null, description: string | null = null) =>
  ({ name, display_name, category, description });

const CATALOGUE = [
  P("gmail_oauth", "Gmail", "communication"),
  P("google_calendar", "Google Calendar", "communication"),
  P("cal_com", "Cal.com", "meetings"),
  P("fireflies", "Fireflies.ai", "meetings"),
  P("fellow", "Fellow", "meetings"),
  P("hubspot", "HubSpot", "crm"),
  P("instantly", "Instantly", "outbound"),
  P("linkedin", "LinkedIn", "communication"),
  P("slack", "Slack", "communication"),
  P("apollo", "Apollo", "enrichment"),
  P("stripe", "Stripe", "billing"),
];

test("the real catalogue maps onto the rail", () => {
  assert.equal(catalogCategoryOf(CATALOGUE[0]), "mail");
  assert.equal(catalogCategoryOf(CATALOGUE[1]), "mail");
  // A booking page is a calendar tool even though the catalogue files it under meetings.
  assert.equal(catalogCategoryOf(CATALOGUE[2]), "mail");
  assert.equal(catalogCategoryOf(CATALOGUE[3]), "notes");
  assert.equal(catalogCategoryOf(CATALOGUE[5]), "crm");
  assert.equal(catalogCategoryOf(CATALOGUE[6]), "outbound");
  assert.equal(catalogCategoryOf(CATALOGUE[7]), "chat");
  assert.equal(catalogCategoryOf(CATALOGUE[8]), "chat");
  // Nothing falls off the rail: what fits none of the board's five sits under Other.
  assert.equal(catalogCategoryOf(CATALOGUE[9]), "other");
  assert.equal(catalogCategoryOf(CATALOGUE[10]), "other");
  assert.equal(catalogCategoryOf(P("mystery", "Mystery", null)), "other");
});

test("counts add up, and every rail key has one", () => {
  const c = railCounts(CATALOGUE);
  assert.equal(c.all, CATALOGUE.length);
  assert.equal(c.mail + c.notes + c.crm + c.outbound + c.chat + c.other, c.all);
  for (const r of RAIL) assert.equal(typeof c[r.key], "number");
  assert.deepEqual(c, { all: 11, mail: 3, notes: 2, crm: 1, outbound: 1, chat: 2, other: 2 });
});

test("search matches the name, the slug and the category", () => {
  assert.equal(matchesSearch(CATALOGUE[5], "hub"), true);
  assert.equal(matchesSearch(CATALOGUE[0], "gmail_"), true);
  assert.equal(matchesSearch(CATALOGUE[3], "meeting"), true);
  assert.equal(matchesSearch(CATALOGUE[3], "crm"), false);
  assert.equal(matchesSearch(CATALOGUE[3], "  "), true);
});

test("the detail step only says what the code does", () => {
  assert.deepEqual(readsFor(CATALOGUE[5]), ["Companies, contacts and deals"]);
  assert.equal(neverFor(CATALOGUE[5]), "Never creates, edits or deletes a deal");
  // No guarantee in the code, no promise on the screen.
  assert.equal(neverFor(CATALOGUE[0]), null);
  assert.equal(neverFor(CATALOGUE[7]), null);
  assert.deepEqual(readsFor(P("mystery", "Mystery", null)), []);
});

test("a tile's line prefers the catalogue's own copy", () => {
  assert.equal(tileLine(P("hubspot", "HubSpot", "crm", "Your HubSpot portal")), "Your HubSpot portal");
  assert.equal(tileLine(CATALOGUE[5]), "Companies, contacts and deals");
  assert.equal(tileLine(P("mystery", "Mystery", null)), "Other");
});

test("All lists tools in the rail's order, stable inside a category", () => {
  const sorted = sortByRail([CATALOGUE[10], CATALOGUE[5], CATALOGUE[3], CATALOGUE[0], CATALOGUE[1]]).map((p) => p.name);
  assert.deepEqual(sorted, ["gmail_oauth", "google_calendar", "fireflies", "hubspot", "stripe"]);
});
