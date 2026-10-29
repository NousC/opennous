// The settings rail's plan rules (GET-625), pinned.
//
// Run: node --test apps/frontend/tests/settingsNav.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupNav, resolveSection, settingsNav } from "../src/components/settings/settingsNav.ts";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("API plan admin: Account, Connections (Integrations, Webhooks), Workspace; billing in Settings, no Repo (GET-882)", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false });
  assert.deepEqual(groupNav(nav).map((g) => g.group), ["Account", "Connections", "Workspace"]);
  assert.deepEqual(ids(nav), [
    "profile", "notifications", "security", "api-keys",
    "integrations", "company-sources", "webhooks",
    "general", "members", "activity-log", "billing",
  ]);
  const billing = nav.find((i) => i.id === "billing")!;
  assert.equal(billing.label, "Usage and billing");
  assert.equal(billing.href, undefined, "opens in Settings, not /usage");
  // Integrations (Personal and Shared as tabs) and Webhooks moved off the sidebar into Settings
  // (GET-1043). Shared is one page's tab, so its id stays routable but is not its own row.
  // API keys are the account's own and live here, under Account, in the pane (GET-1030).
  const rail = groupNav(nav).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(rail, ["profile", "notifications", "security", "api-keys", "integrations", "webhooks", "general", "members", "activity-log", "billing"]);
  assert.equal(nav.find((i) => i.id === "integrations")!.label, "Integrations");
  assert.equal(nav.find((i) => i.id === "api-keys")!.href, undefined, "opens in Settings, not /keys");
  assert.equal(resolveSection("repo", nav), "profile");
  assert.equal(resolveSection("integrations", nav), "integrations");
});

test("Custom plan admin: Billing is the Usage page too (GET-660), no Repo, no Agent group", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  const billing = nav.find((i) => i.id === "billing")!;
  assert.equal(billing.label, "Usage and billing");
  assert.equal(billing.href, undefined, "opens in Settings, not /usage");
  assert.ok(!ids(nav).includes("repo"));
  assert.ok(!nav.some((i) => i.group === "Agent"));
});

test("a member sees no Workspace group; the public rail has no Admin row, even for the owner", () => {
  const member = settingsNav({ tier: "custom", isWorkspaceAdmin: false, isOwner: false });
  assert.ok(!member.some((i) => i.group === "Workspace"));
  assert.ok(!ids(member).includes("admin"));
  // Admin is the Workspace layer's row (cloud/settings/navRows, GET-761).
  const owner = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: true });
  assert.ok(!ids(owner).includes("admin"));
});

test("hidden sections stay out of the rail", () => {
  for (const tier of ["api", "custom"] as const) {
    const nav = ids(settingsNav({ tier, isWorkspaceAdmin: true, isOwner: true }));
    for (const hidden of ["config", "models", "changes", "spend", "adoption", "categories", "governance"]) {
      assert.ok(!nav.includes(hidden), `${hidden} on ${tier}`);
    }
  }
});

test("resolveSection: aliases, unknown and out-of-rail ids fall back", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  assert.equal(resolveSection("usage", nav), "billing");
  assert.equal(resolveSection("team", nav), "general");
  assert.equal(resolveSection("privacy", nav), "profile");
  assert.equal(resolveSection("notifications", nav), "notifications");
  assert.equal(resolveSection("nonsense", nav), "profile");
  assert.equal(resolveSection("models", nav), "profile");
  assert.equal(resolveSection(null, nav), "profile");
  const member = settingsNav({ tier: "custom", isWorkspaceAdmin: false, isOwner: false });
  assert.equal(resolveSection("members", member), "profile");
});

test("Integrations, Webhooks, API keys and billing open inside Settings on every plan", () => {
  for (const tier of ["api", "custom"] as const) {
    const nav = settingsNav({ tier, isWorkspaceAdmin: true, isOwner: false });
    const href = (id: string) => nav.find((i) => i.id === id)?.href;
    for (const id of ["integrations", "company-sources", "webhooks"]) assert.equal(href(id), undefined, `${tier}: ${id} in Settings`);
    assert.equal(resolveSection("company-sources", nav), "company-sources", `${tier}: the Shared tab still resolves`);
    assert.equal(href("api-keys"), undefined, `${tier}: api-keys in Settings`);
    assert.equal(href("billing"), undefined, `${tier}: billing in Settings`);
  }
  const plain = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  for (const id of ["profile", "notifications", "security", "general", "members"]) {
    assert.ok(!("href" in plain.find((i) => i.id === id)!), `${id} stays in Settings`);
  }
});

test("self-host admin: Integrations and Webhooks in Settings (no sidebar group any more), no billing, Instance setup first in Workspace", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false, selfHosted: true });
  assert.deepEqual(groupNav(nav).map((g) => g.group), ["Account", "Connections", "Workspace"]);
  assert.deepEqual(ids(nav), ["profile", "security", "integrations", "company-sources", "webhooks", "instance", "general", "members"]);
  assert.equal(resolveSection("notifications", nav), "profile", "a hidden section lands on Account");
});

test("self-host member: no Instance setup", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: false, isOwner: false, selfHosted: true });
  assert.ok(!ids(nav).includes("instance"));
});

test("Custom plan keeps the Connections rows in the rail: Integrations (one row, two tabs), Webhooks, API keys", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  const rail = groupNav(nav).flatMap((g) => g.items.map((i) => i.id));
  for (const id of ["integrations", "webhooks", "api-keys"]) assert.ok(rail.includes(id), id);
  assert.ok(!rail.includes("company-sources"), "Shared is a tab, not a row");
});

test("no Signals row of its own: it is the Workspace layer's (GET-910)", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false, can: () => true });
  assert.ok(!ids(nav).includes("signals"));
  assert.equal(resolveSection("signals", nav), "profile");
});

test("Knowledge is the public rail's (2026-10-29), where the plan has the revboxes feature", () => {
  const on = settingsNav({ tier: "custom", isWorkspaceAdmin: false, isOwner: false, can: (f) => f === "revboxes" });
  const row = on.find((i) => i.id === "context")!;
  assert.equal(row.label, "Knowledge");
  assert.equal(row.group, "Knowledge & signals");
  const off = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false, can: () => false });
  assert.ok(!ids(off).includes("context"));
});

test("Agent activity (was API & MCP activity, GET-900): Workspace group, admins on both plans, not self-host; access-log lands there (GET-898)", () => {
  for (const tier of ["api", "custom"] as const) {
    const nav = settingsNav({ tier, isWorkspaceAdmin: true, isOwner: false });
    const row = nav.find((i) => i.id === "activity-log")!;
    assert.equal(row.label, "Agent activity", tier);
    assert.equal(row.group, "Workspace", tier);
    assert.ok(!("href" in row), "a Settings page, not a link out");
    const ws = groupNav(nav).find((g) => g.group === "Workspace")!;
    assert.ok(ids(ws.items).indexOf("activity-log") === ids(ws.items).indexOf("members") + 1, `${tier}: after Members`);
    assert.equal(resolveSection("activity-log", nav), "activity-log");
    assert.equal(resolveSection("access-log", nav), "activity-log", "the old deep link");
    const member = settingsNav({ tier, isWorkspaceAdmin: false, isOwner: false });
    assert.ok(!ids(member).includes("activity-log"), `${tier}: members do not see it`);
    assert.equal(resolveSection("access-log", member), "profile");
  }
  const selfHost = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false, selfHosted: true });
  assert.ok(!ids(selfHost).includes("activity-log"));
});
