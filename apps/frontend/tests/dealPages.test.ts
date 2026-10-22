// Deal pages are a Workspace-plan, Cloud-only surface (GET-1008). On the API plan, and in the
// open-source build (no src/cloud/), an account still lists its deals, but a deal never opens.
//
// Run: node --test apps/frontend/tests/dealPages.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dealPagesOn, dealRowHref, dealOrAccountPath } from "../src/lib/dealPages.ts";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");

test("the API plan has no deal pages, even on Cloud", () => {
  assert.equal(dealPagesOn({ cloudDealPages: true, plan: "api" }), false);
});

test("the open-source build has no deal pages, on any plan", () => {
  assert.equal(dealPagesOn({ cloudDealPages: undefined, plan: "custom" }), false);
  assert.equal(dealPagesOn({ cloudDealPages: undefined, plan: "api" }), false);
});

test("a workspace plan on Cloud keeps its deal pages", () => {
  assert.equal(dealPagesOn({ cloudDealPages: true, plan: "custom" }), true);
  assert.equal(dealPagesOn({ cloudDealPages: true, plan: "workspace" }), true);
});

test("the account rail's deal row is plain without deal pages, a link with them", () => {
  assert.equal(dealRowHref(false, "acme-co", "d1"), null);
  assert.equal(dealRowHref(true, "acme-co", "d1"), "/accounts/acme-co/deals/d1");
});

test("a deal elsewhere (palette, home, pipeline) falls back to its account without deal pages", () => {
  assert.equal(dealOrAccountPath(false, "acme-co", "d1"), "/accounts/acme-co");
  assert.equal(dealOrAccountPath(true, "acme-co", "d1"), "/accounts/acme-co/deals/d1");
});

test("the deal page's code is not in the public tree", () => {
  for (const f of ["pages/Deal.tsx", "components/deals/DealDetailView.tsx", "components/deals/DealOverviewCard.tsx", "components/deals/DealPane.tsx", "components/deals/stageChoices.ts"]) {
    assert.equal(existsSync(join(src, f)), false, `${f} is public`);
  }
  const routes = readFileSync(join(src, "components/AppRoutes.tsx"), "utf8");
  assert.doesNotMatch(routes, /pages\/Deal"/);
  // The public app's only deal address is the redirect to the account, when Cloud is absent.
  assert.match(routes, /\{!cloud\.dealPages && <Route path="\/accounts\/:id\/deals\/:dealId" element=\{<RedirectToAccount \/>\} \/>\}/);
});
