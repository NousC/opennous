// Settings > API & MCP activity (GET-898): the page's pure formatting, pinned.
//
// Run: node --test apps/frontend/tests/apiActivity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callsQuery, pct, ms, aboutHref, aboutLabel, clientLabel, keyLabel, bucketLabel, latencyNote, splitNote, isError,
  activityGet, errorNote, isSignedOut, HttpError, UNKNOWN_CLIENT,
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
  assert.equal(aboutHref({ id: "p1", type: "person", name: "Dana" }), "/contacts/p1");
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

// ── GET-900: the fetch helper. 30 and 90 days failed because the page sent a token captured in
// React state, which had rotated out; the API answered 401 and the page said "Could not load". ──

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function recorder(answers: Response[]) {
  const seen: { url: string; auth: string | undefined }[] = [];
  const doFetch = async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>)?.Authorization });
    return answers.shift() ?? json(500, { error: "no_more_answers" });
  };
  return { seen, doFetch };
}

test("activityGet: mints a token for every request, never reuses one", async () => {
  let n = 0;
  const tokens: (boolean | undefined)[] = [];
  const getToken = async (o?: { force?: boolean }) => { tokens.push(o?.force); return `t${++n}`; };
  const { seen, doFetch } = recorder([json(200, { window: "7d" }), json(200, { window: "30d" })]);
  assert.deepEqual(await activityGet("/a?window=7d", getToken, doFetch), { window: "7d" });
  assert.deepEqual(await activityGet("/a?window=30d", getToken, doFetch), { window: "30d" });
  assert.deepEqual(seen.map((s) => s.auth), ["Bearer t1", "Bearer t2"]);
  assert.deepEqual(tokens, [undefined, undefined], "no forced refresh when the token works");
});

test("activityGet: a 401 forces a new token and retries once", async () => {
  const getToken = async (o?: { force?: boolean }) => (o?.force ? "fresh" : "stale");
  const { seen, doFetch } = recorder([json(401, { error: "invalid_token" }), json(200, { ok: 1 })]);
  assert.deepEqual(await activityGet("/a", getToken, doFetch), { ok: 1 });
  assert.deepEqual(seen.map((s) => s.auth), ["Bearer stale", "Bearer fresh"]);
});

test("activityGet: still 401 after the refresh throws HttpError 401, tried only twice", async () => {
  const { seen, doFetch } = recorder([json(401, { error: "invalid_token" }), json(401, { error: "invalid_token" })]);
  const err = await activityGet("/a", async () => "x", doFetch).catch((e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 401);
  assert.equal(err.code, "invalid_token");
  assert.equal(seen.length, 2);
  assert.ok(isSignedOut(err));
  assert.equal(errorNote(err), "401 · sign in again");
});

test("activityGet: other errors carry status and code, no retry; a dropped connection is status 0", async () => {
  const { seen, doFetch } = recorder([json(503, { error: "activity_unavailable" })]);
  const err = await activityGet("/a", async () => "x", doFetch).catch((e) => e);
  assert.equal(err.status, 503);
  assert.equal(err.code, "activity_unavailable");
  assert.equal(seen.length, 1);
  assert.equal(errorNote(err), "503 · activity_unavailable");
  const html = await activityGet("/a", async () => "x", async () => new Response("<html>", { status: 502 })).catch((e) => e);
  assert.equal(errorNote(html), "502 · http_502");
  const down = await activityGet("/a", async () => "x", async () => { throw new TypeError("Failed to fetch"); }).catch((e) => e);
  assert.equal(down.status, 0);
  assert.equal(errorNote(down), "No connection to the API");
  assert.ok(!isSignedOut(down));
});

test("activityGet: no token sends no Authorization header (the API then answers 401)", async () => {
  const { seen, doFetch } = recorder([json(200, {})]);
  await activityGet("/a", async () => null, doFetch);
  assert.equal(seen[0].auth, undefined);
});

test("callsQuery: the client filter (GET-900), Unknown as its own value", () => {
  assert.equal(callsQuery("7d", { client: "Claude Code" }), "window=7d&limit=50&client=Claude+Code");
  assert.equal(callsQuery("7d", { client: UNKNOWN_CLIENT }), "window=7d&limit=50&client=%28unknown%29");
});
