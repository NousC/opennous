// Activity's ledger pages by a cursor (GET-903): the first page asks for a few rows, the rest come
// on request, and a row that shows on two pages is listed once.
//
// Run: node --test apps/frontend/tests/activityLedger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_PAGE, conversationsQuery, mergePage } from "../src/lib/activityLedger.ts";

test("conversationsQuery: workspace, window and page size; the cursor only when there is one", () => {
  assert.equal(conversationsQuery("ws1", 30), `workspaceId=ws1&days=30&limit=${FIRST_PAGE}`);
  assert.equal(conversationsQuery("ws1", null, 100), "workspaceId=ws1&days=all&limit=100");
  assert.equal(conversationsQuery("ws 1", 7, 50, "eyJ0cyI6IjIw+/="), "workspaceId=ws%201&days=7&limit=50&cursor=eyJ0cyI6IjIw%2B%2F%3D");
  assert.equal(conversationsQuery("ws1", 7, 50, null), "workspaceId=ws1&days=7&limit=50");
});

test("the first page is small enough to come back fast", () => {
  assert.ok(FIRST_PAGE <= 50);
});

test("mergePage: appends in order and keeps the first (newest) copy of an id", () => {
  const a = [{ id: "tid:1", n: 1 }, { id: "c2", n: 2 }];
  const b = [{ id: "tid:1", n: 9 }, { id: "c3", n: 3 }];
  assert.deepEqual(mergePage(a, b), [{ id: "tid:1", n: 1 }, { id: "c2", n: 2 }, { id: "c3", n: 3 }]);
  assert.deepEqual(mergePage(null, b), b);
  assert.deepEqual(mergePage(a, []), a);
});
