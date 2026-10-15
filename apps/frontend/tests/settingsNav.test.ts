// The settings rail's plan rules (GET-625), pinned.
//
// Run: node --test apps/frontend/tests/settingsNav.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupNav, resolveSection, settingsNav } from "../src/components/settings/settingsNav.ts";

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

test("API plan admin: the board's three groups, billing goes to /usage, no Repo (GET-882)", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false });
  // Repo was the API rail's only Connections row; with it gone (GET-882) the group is empty and drops.
  assert.deepEqual(groupNav(nav).map((g) => g.group), ["Account", "Workspace"]);
  assert.deepEqual(ids(nav), [
    "profile", "notifications", "security",
    "integrations", "company-sources", "webhooks", "api-keys",
    "general", "members", "activity-log", "billing",
  ]);
  const billing = nav.find((i) => i.id === "billing")!;
  assert.equal(billing.label, "Usage and billing");
  assert.equal(billing.href, "/usage");
  // The sidebar holds Personal, Shared, Webhooks and API keys on API, so the rail does not repeat
  // them (GET-857); they stay routable, so /settings?section=integrations still lands on the page.
  const rail = groupNav(nav).flatMap((g) => g.items.map((i) => i.id));
  assert.deepEqual(rail, ["profile", "notifications", "security", "general", "members", "activity-log", "billing"]);
  assert.equal(resolveSection("repo", nav), "profile");
  assert.equal(resolveSection("integrations", nav), "integrations");
});

test("Custom plan admin: Billing is the Usage page too (GET-660), no Repo, no Agent group", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  const billing = nav.find((i) => i.id === "billing")!;
  assert.equal(billing.label, "Usage and billing");
  assert.equal(billing.href, "/usage");
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

test("Connections rows open the standalone pages on every plan (GET-660)", () => {
  for (const tier of ["api", "custom"] as const) {
    const nav = settingsNav({ tier, isWorkspaceAdmin: true, isOwner: false });
    const href = (id: string) => nav.find((i) => i.id === id)?.href;
    assert.equal(href("integrations"), "/integrations", tier);
    assert.equal(href("company-sources"), "/company-sources", tier);
    assert.equal(href("webhooks"), "/webhooks", tier);
    assert.equal(href("api-keys"), "/keys", tier);
    assert.equal(href("billing"), "/usage", tier);
  }
  const plain = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  for (const id of ["profile", "notifications", "security", "general", "members"]) {
    assert.ok(!("href" in plain.find((i) => i.id === id)!), `${id} stays in Settings`);
  }
});

test("self-host admin: no Connections group (the sidebar has them), no billing, Instance setup first in Workspace", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false, selfHosted: true });
  assert.deepEqual(groupNav(nav).map((g) => g.group), ["Account", "Workspace"]);
  assert.deepEqual(ids(nav), ["profile", "security", "instance", "general", "members"]);
  assert.equal(resolveSection("notifications", nav), "profile", "a hidden section lands on Account");
});

test("self-host member: no Instance setup", () => {
  const nav = settingsNav({ tier: "api", isWorkspaceAdmin: false, isOwner: false, selfHosted: true });
  assert.ok(!ids(nav).includes("instance"));
});

test("Custom plan keeps the Connections rows in the rail: its sidebar has no Integrations group (GET-857)", () => {
  const nav = settingsNav({ tier: "custom", isWorkspaceAdmin: true, isOwner: false });
  const rail = groupNav(nav).flatMap((g) => g.items.map((i) => i.id));
  for (const id of ["integrations", "company-sources", "webhooks", "api-keys"]) assert.ok(rail.includes(id), id);
});

test("RevBoxes on: Context and Signals in their own section, after Connections, on API and Workspace plans (GET-882)", () => {
  for (const tier of ["api", "custom"] as const) {
    for (const isWorkspaceAdmin of [true, false]) {
      const nav = settingsNav({ tier, isWorkspaceAdmin, isOwner: false, revboxes: true });
      const groups = groupNav(nav);
      const own = groups.find((g) => g.group === "Context & signals")!;
      assert.deepEqual(ids(own.items), ["context", "signals"], `${tier} admin=${isWorkspaceAdmin}: Context then Signals`);
      assert.ok(!groups.some((g) => g.group === "Workspace" && ids(g.items).includes("context")), "not under Workspace");
      const order = groups.map((g) => g.group);
      assert.ok(order.indexOf("Context & signals") < (order.includes("Workspace") ? order.indexOf("Workspace") : Infinity), `${tier}: before Workspace`);
      assert.equal(resolveSection("context", nav), "context");
      assert.equal(resolveSection("signals", nav), "signals");
    }
  }
  const off = settingsNav({ tier: "api", isWorkspaceAdmin: true, isOwner: false });
  assert.ok(!ids(off).includes("context") && !ids(off).includes("signals"));
  assert.equal(resolveSection("signals", off), "profile");
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
