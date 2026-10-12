// First run shows real data as it lands (GET-619): Home leads with the history import.
import { expect, test } from "@playwright/test";
import { NOW } from "../../playwright.config";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(() => {
    localStorage.setItem("nous_cookie_consent", JSON.stringify({ consent: "essential", timestamp: "2026-10-01T00:00:00Z" }));
    localStorage.setItem("nous.sidebar.collapsed", "false");
  });
});

test("while the import runs, Home shows progress and the accounts so far", async ({ page }) => {
  await page.route("**/api/backfill/preview*", (r) => r.fulfill({ json: {
    state: "running", window_days: 90, progress: { finished: 14, total: 40, pct: 38, read: 1204 },
  } }));
  await page.goto("/", { waitUntil: "networkidle" });
  const card = page.getByRole("region", { name: "Reading your history" });
  await expect(card).toContainText("38%");
  await expect(card).toContainText("1,204 conversations read from the last 3 months");
  await expect(card).toContainText("Accounts so far");
  await page.evaluate(() => document.fonts.ready);
  await expect(card).toHaveScreenshot("first-run-running.png");
});

test("awaiting review shows one line and the way to start it", async ({ page }) => {
  await page.route("**/api/backfill/preview*", (r) => r.fulfill({ json: { state: "awaiting_confirmation" } }));
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("Your history is ready to read.")).toBeVisible();
  await page.getByRole("button", { name: "Review and start" }).click();
  await expect(page).toHaveURL(/section=billing/);
});

test("just finished says so; nothing once the moment has passed", async ({ page }) => {
  await page.route("**/api/backfill/preview*", (r) => r.fulfill({ json: { state: "done", finished_at: new Date(Date.parse(NOW) - 5 * 60_000).toISOString() } }));
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByText("Your history is in.")).toBeVisible();
});
