// CRM names (GET-602): the app names the workspace's own CRM, never a fixed one.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "behaviour is the same in every view");
  await page.addInitScript(() => {
    localStorage.setItem("nous_cookie_consent", JSON.stringify({ consent: "essential", timestamp: "2026-10-01T00:00:00Z" }));
  });
});

for (const [provider, label] of [["hubspot", "HubSpot"], ["salesforce", "Salesforce"], ["attio", "Attio"]] as const) {
  test(`account record links to ${label}`, async ({ page }) => {
    await page.route("**/api/onboarding/checklist*", (r) =>
      r.fulfill({ json: { crm: { done: true, provider, imported: true, accounts: 20 } } }));
    await page.goto("/accounts/c1", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: `View in ${label}`, exact: true })).toBeVisible();
  });
}

test("no CRM connected reads 'your CRM'", async ({ page }) => {
  await page.route("**/api/onboarding/checklist*", (r) => r.fulfill({ json: { crm: { done: false, provider: null } } }));
  await page.goto("/customers?view=all", { waitUntil: "networkidle" });
  // The health column is "Health score" since GET-606; its tooltip names whose score it is.
  await expect(page.locator(`[title^="your CRM's health score"]`).first()).toBeVisible();
});
