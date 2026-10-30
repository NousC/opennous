// Which sidebar a page shows (GET-1082), pinned.
//
// Run: node --test apps/frontend/tests/spaces.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spaceOf } from "../src/components/shell/spaces.ts";

test("Inbox and Tasks are the Inbox space, with their detail pages", () => {
  for (const p of ["/inbox", "/tasks", "/tasks/t1"]) assert.equal(spaceOf(p), "inbox", p);
});

test("the graph, both Insights and Knowledge are the Context Graph space", () => {
  for (const p of ["/graph", "/insights", "/insights/pricing", "/gtm-insights", "/gtm-insights/k", "/knowledge"]) assert.equal(spaceOf(p), "graph", p);
});

test("everything else is Home, and a path that only starts the same is not a match", () => {
  for (const p of ["/", "/accounts", "/contacts/c1", "/rev-plays", "/events", "/pipeline", "/inboxes", "/graphs"]) assert.equal(spaceOf(p), "home", p);
});
