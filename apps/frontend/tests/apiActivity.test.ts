// Settings > API & MCP activity (GET-898): the page's pure formatting, pinned.
//
// Run: node --test apps/frontend/tests/apiActivity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callsQuery, pct, ms, aboutHref, aboutLabel, clientLabel, keyLabel, bucketLabel, latencyNote, splitNote, isError,
} from "../src/lib/apiActivity.ts";

test("callsQuery: window and limit always, empty filters left out, search trimmed", () => {
  assert.equal(callsQuery("7d"), "window=7d&limit=50");
  assert.equal(
    callsQuery("24h", { surface: "mcp", route: "get_account", status: "error", key: "k1", q: "  harbor  " }, "2026-10-15T10:00:00Z|9", 25),
    "window=24h&limit=25&surface=mcp&route=get_account&status=error&key=k1&q=harbor&before=2026-10-15T10%3A00%3A00Z%7C9",
  );
  assert.equal(callsQuery("30d", { q: "   ", surface: null }), "window=30d&limit=50");
});

test("pct and ms: a dash for nothing, never a fake zero", () => {
  assert.equal(pct(null), "—");
  assert.equal(pct(0), "0%");
  assert.equal(pct(0.0213), "2.1%");
  assert.equal(pct(0.25), "25%");
  assert.equal(pct(1), "100%");
  assert.equal(pct(0.0004), "<0.1%");
  assert.equal(ms(null), "—");
  assert.equal(ms(120.4), "120 ms");
  assert.equal(ms(1840), "1.8 s");
});

test("about: a company links to its account, a person to their page, a deal and a raw target do not", () => {
  assert.equal(aboutHref({ id: "c1", type: "company", name: "Harborline Supply" }), "/accounts/c1");
  assert.equal(aboutHref({ id: "p1", type: "person", name: "Dana" }), "/people/p1");
  assert.equal(aboutHref({ id: "d1", type: "deal", name: "Platform" }), null);
  assert.equal(aboutHref(null), null);
  assert.equal(aboutLabel({ id: "c1", type: "company", name: "Harborline Supply" }, "c1"), "Harborline Supply");
  assert.equal(aboutLabel({ id: "c1", type: "company", name: null }, "harborline.example"), "harborline.example");
  assert.equal(aboutLabel(null, null), "—");
});

test("labels: client, key, status", () => {
  assert.equal(clientLabel(null), "Unknown");
  assert.equal(clientLabel(" "), "Unknown");
  assert.equal(clientLabel("Cursor"), "Cursor");
  assert.equal(keyLabel("Laptop agent", "aaaaaaaa-bbbb"), "Laptop agent");
  assert.equal(keyLabel(null, "aaaaaaaa-bbbb"), "Key aaaaaaaa");
  assert.equal(isError(404), true);
  assert.equal(isError(200), false);
});

test("chart buckets: hours as HH:00, days as '15 Oct'", () => {
  assert.equal(bucketLabel("2026-10-15T09:00:00Z", true), "09:00");
  assert.equal(bucketLabel("2026-10-15", false), "15 Oct");
});

test("header notes", () => {
  const t = { calls: 1234, mcp: 1000, rest: 234, errors: 3, error_rate: 3 / 1234, p50_ms: 90, p95_ms: 2100, keys: 2, clients: 3, targets: 9 };
  assert.equal(splitNote(t), "1,000 MCP · 234 REST");
  assert.equal(latencyNote(t), "p95 2.1 s");
  assert.equal(latencyNote({ ...t, p95_ms: null }), "");
  assert.equal(splitNote(null), "");
});
