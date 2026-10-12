// Keyboard first (GET-601): the shortcuts do what the ? sheet says. Behaviour, not pixels.
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "behaviour is the same in every view");
  await page.addInitScript(() => {
    localStorage.setItem("nous_cookie_consent", JSON.stringify({ consent: "essential", timestamp: "2026-10-01T00:00:00Z" }));
  });
});

test("G then T goes to Tasks; G then H back Home", async ({ page }) => {
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/tasks$/);
  await page.keyboard.press("g");
  await page.keyboard.press("h");
  await expect(page).toHaveURL(/\/$/);
});

test("C opens a new task from anywhere", async ({ page }) => {
  await page.goto("/accounts", { waitUntil: "networkidle" });
  await page.keyboard.press("c");
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("? opens the shortcut sheet", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});

test("J / K move the table cursor", async ({ page }) => {
  await page.goto("/ui-gallery.html", { waitUntil: "networkidle" });
  const active = () => page.locator("tr[data-active]").getAttribute("data-row");
  await page.keyboard.press("j");
  expect(await active()).toBe("1");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  expect(await active()).toBe("3");
  await page.keyboard.press("k");
  expect(await active()).toBe("2");
});
