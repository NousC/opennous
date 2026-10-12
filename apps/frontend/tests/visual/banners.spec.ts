// Real failures, said plainly (GET-618): the CRM banners under the top bar.
import { expect, test } from "@playwright/test";
import { NOW } from "../../playwright.config";

const day = 86_400_000;
test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(() => {
    localStorage.setItem("nous_cookie_consent", JSON.stringify({ consent: "essential", timestamp: "2026-10-01T00:00:00Z" }));
    localStorage.setItem("nous.sidebar.collapsed", "false");
  });
});

test("stale sync shows a dismissible warning", async ({ page }) => {
  await page.route("**/api/crm/sync-config*", (r) =>
    r.fulfill({ json: { config: { auto_sync: true, last_synced_at: new Date(Date.parse(NOW) - 3 * day).toISOString() } } }));
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  const banner = page.getByRole("status").filter({ hasText: "last synced" });
  await expect(banner).toContainText("HubSpot last synced 3 days ago");
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("banner-stale.png", { clip: { x: 232, y: 0, width: 1208, height: 140 } });
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);
});

test("a disconnected CRM shows an alert that can't be dismissed", async ({ page }) => {
  await page.route("**/api/onboarding/checklist*", (r) => r.fulfill({ json: { crm: { done: false, provider: "hubspot" } } }));
  await page.route("**/api/crm/sync-config*", (r) =>
    r.fulfill({ json: { config: { auto_sync: true, last_synced_at: new Date(Date.parse(NOW) - day).toISOString() } } }));
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  const alert = page.getByRole("alert").filter({ hasText: "disconnected" });
  await expect(alert).toContainText("HubSpot is disconnected. Nothing new is syncing");
  await expect(alert.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
  await expect(alert.getByRole("button", { name: "Reconnect HubSpot" })).toBeVisible();
});

test("a fresh sync shows nothing", async ({ page }) => {
  await page.route("**/api/crm/sync-config*", (r) =>
    r.fulfill({ json: { config: { auto_sync: true, last_synced_at: new Date(Date.parse(NOW) - 3_600_000).toISOString() } } }));
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await expect(page.getByText("last synced")).toHaveCount(0);
});
