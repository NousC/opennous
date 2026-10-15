// The API plan Home's stat cards (GET-628), pinned.
//
// Run: node --test apps/frontend/tests/apiHome.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { callsToday, callsTodayLabel, connectedSources } from "../src/lib/apiHome.ts";

test("calls today sums every key", () => {
  assert.equal(callsToday({ days: 1, keys: [{ api_key_id: "a", calls: 368 }, { api_key_id: "b", calls: 44 }] }), 412);
  assert.equal(callsToday({ days: 1, keys: [] }), 0);
});

test("no payload is no number, not zero", () => {
  assert.equal(callsToday(null), null);
  assert.equal(callsToday({} as never), null);
  assert.equal(connectedSources(undefined), null);
});

test("sources keep the server's order and fall back to the name", () => {
  assert.deepEqual(connectedSources({ tools: [{ name: "gmail", label: "Gmail", logo_url: "g.png" }, { name: "fireflies", label: "", logo_url: null }] }), [
    { name: "gmail", label: "Gmail", logo: "g.png" },
    { name: "fireflies", label: "fireflies", logo: "/provider-logos/fireflies.svg" },
  ]);
});

test("a tool with no server logo shows the app's own mark; an unknown tool keeps the letter", () => {
  const s = connectedSources({ tools: [{ name: "granola", label: "Granola", logo_url: null }, { name: "attio", label: "Attio" }, { name: "mystery", label: "Mystery", logo_url: null }] });
  assert.deepEqual(s?.map((x) => x.logo), ["/provider-logos/granola.svg", "/provider-logos/attio.svg", null]);
});

test("a member's calls-today card says it is theirs", () => {
  assert.equal(callsTodayLabel(true), "Calls today");
  assert.equal(callsTodayLabel(false), "Your calls today");
});
