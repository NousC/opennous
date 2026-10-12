// Visual baselines (GET-596): each route as the preview fixture world renders it.
// The page list mirrors the interface refresh boards; add a route here when a page is added.
import { expect, test } from "@playwright/test";
import { NOW } from "../../playwright.config";

const ROUTES: [name: string, path: string][] = [
  ["home", "/"],
  ["pipeline-board", "/pipeline"],
  ["pipeline-list", "/pipeline?layout=list"],
  ["accounts", "/accounts"],
  ["people", "/people"],
  ["customers", "/customers"],
  ["tasks", "/tasks"],
  ["account", "/accounts/c1"],
  ["deal", "/accounts/c1/deals/dl-01"],
  ["reporting", "/reporting"],
  ["insights", "/insights"],
  ["automations", "/automations"],
  ["ui-gallery", "/ui-gallery.html"],
];

test.beforeEach(async ({ page }, info) => {
  const dark = info.project.name.includes("dark");
  const desktop = info.project.name.startsWith("desktop");
  await page.clock.setFixedTime(new Date(NOW));
  await page.addInitScript(
    ({ theme, desktop }) => {
      try {
        // No cookie banner and the theme under test. On desktop the sidebar is open; on a
        // phone it is left to the app, which collapses it under 900px.
        localStorage.setItem("nous_cookie_consent", JSON.stringify({ consent: "essential", timestamp: "2026-10-01T00:00:00Z" }));
        localStorage.setItem("nous-theme", theme);
        if (desktop) localStorage.setItem("nous.sidebar.collapsed", "false");
      } catch {
        /* ignore */
      }
    },
    { theme: dark ? "dark" : "light", desktop },
  );
});

for (const [name, path] of ROUTES) {
  test(name, async ({ page }, info) => {
    const url = info.project.name.includes("dark") && path.endsWith(".html") ? `${path}?theme=dark` : path;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    // Never capture a loader: wait until no "Loading…" text is left (a route whose data never
    // arrives fails here instead of baselining a spinner), then let the first render settle.
    await page.waitForFunction(() => !/\bLoading\b/.test(document.body.innerText), null, { timeout: 10_000 });
    await page.waitForTimeout(600);
    await expect(page).toHaveScreenshot(`${name}.png`);
  });
}

// The top bar's Priorities panel, open (GET-598).
test("priorities-open", async ({ page }, info) => {
  test.skip(!info.project.name.startsWith("desktop"), "desktop only");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /^Priorities/ }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("priorities-open.png");
});

// Invite teammates (GET-600): two addresses typed, then the result of sending them.
test("invite-modal", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Invite teammates" }).click();
  await page.keyboard.type("maya@opennous.example, jonas@opennous.example,");
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot("invite-modal.png");
  await page.keyboard.press("Meta+Enter");
  await page.getByText("Email sent").waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("invite-sent.png");
});

// Home's "Waiting on you" (GET-603): one follow-up open, with its email, deal change and tasks.
test("home-waiting-open", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /Halcyon Retail Group/ }).click();
  await page.getByRole("button", { name: /Halcyon Retail Group/ }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("home-waiting-open.png");
});

// Pipeline (GET-604): the owner filter open, one person picked; the board narrows to their deals.
test("pipeline-owner-filter", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /Everyone/ }).click();
  await page.getByRole("menuitemcheckbox", { name: /Jordan/ }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("pipeline-owner-filter.png");
});

// Accounts (GET-605): a row's actions menu open.
test("accounts-row-menu", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/accounts", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const row = page.locator("tbody tr").first();
  await row.hover();
  await row.getByRole("button", { name: "Account actions" }).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot("accounts-row-menu.png");
});

// Customers (GET-606): the Expansion view, and a signal's detail (the customer's own words) on hover.
test("customers-expansion-signal", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/customers?view=expansion", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByText("Asked about Service desk").hover();
  await page.getByRole("tooltip").first().waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("customers-expansion-signal.png");
});

// Tasks (GET-607): the board layout with No date folded, and the New task form opened from an
// account (C on /accounts/c3 lands on /tasks?new=1&account=c3) with its deal menu open.
test("tasks-board", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/tasks", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("radio", { name: "Board" }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("tasks-board.png");
});

test("tasks-new", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/tasks?new=1&account=c3", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.keyboard.type("Send Marcus the pilot plan");
  await page.getByRole("button", { name: "Deal" }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("tasks-new.png");
});

// The record's Intel tab with a topic open (GET-610).
test("account-intel", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "desktop only");
  await page.goto("/accounts/c1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: /^Intel/ }).click();
  await page.getByRole("option", { name: /Security review timing/ }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("account-intel.png");
});

// Hover previews on the record pages (GET-611): a deal from the account, the account from a deal.
test("record-preview", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "desktop only");
  await page.goto("/accounts/c1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("aside").getByText("Platform", { exact: true }).hover();
  await page.getByText("Last activity", { exact: true }).last().waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("record-preview-deal.png");
  await page.goto("/accounts/c1/deals/dl-01", { waitUntil: "networkidle" });
  await page.locator("aside").getByText("Meridian Analytics", { exact: true }).hover();
  await page.getByText("Open pipeline", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("record-preview-account.png");
});

// Sources on the record (GET-612): an Intel fact's call, open in the source dock on the quoted line.
test("record-source-dock", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "desktop only");
  await page.goto("/accounts/c1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: /^Intel/ }).click();
  await page.getByRole("option", { name: /Security review timing/ }).click();
  await page.getByRole("button", { name: "Open the call" }).first().click();
  await page.getByText("Meridian security review", { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot("record-source-dock.png");
});

// Ask Nous (GET-613): a thread with a traced, cited answer, a draft and an undoable change; the
// empty new chat; and the thread with its steps opened.
for (const [name, path] of [["chat-thread", "/?thread=th1"], ["chat-new", "/?chat=1"]] as const) {
  test(name, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !/\bLoading\b/.test(document.body.innerText), null, { timeout: 10_000 });
    await page.waitForTimeout(600);
    // The thread auto-scrolls; pin every scroll box to the bottom (what a reader sees) and wait
    // until nothing moves, so the shot doesn't catch the scroll mid-flight.
    const positions = () => page.evaluate(() => [...document.querySelectorAll("*")]
      .filter((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
      .map((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; }).join(","));
    let last = await positions();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(150);
      const now = await positions();
      if (now === last) break;
      last = now;
    }
    await expect(page).toHaveScreenshot(`${name}.png`);
  });
}

test("chat-trace-open", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/?thread=th1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /^Completed in/ }).click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("chat-trace-open.png");
});

// Insights (GET-615): the first topic opened in place, with what's going wrong and the quotes.
test("insights-row-open", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/insights", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "Open topic" }).waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("insights-row-open.png");
});

// Automations (GET-616): the Run history tab, numbers on top and the runs table.
test("automations-history", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/automations", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: /Run history/ }).click();
  await page.getByRole("table", { name: "Run history" }).waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("automations-history.png");
});

// Ask Nous follow-ups (GET-649): a chip under the last answer asks its question; the new answer
// brings its own chips and the old ones go, so only the latest answer offers what to ask next.
test("chat-followup-sent", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/?thread=th1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const followUps = page.getByRole("group", { name: "Suggested follow-ups" });
  await followUps.getByRole("button", { name: "Brief me for the infosec call" }).click();
  await expect(page.getByText("Brief me for the infosec call", { exact: true })).toBeVisible();
  await expect(followUps.getByRole("button", { name: "Brief me on Meridian Analytics" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Who else should be on this deal?" })).toHaveCount(0);
  await expect(followUps).toHaveCount(1);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await expect(page).toHaveScreenshot("chat-followup-sent.png");
});

// Hover previews on the list pages (GET-646): an account's card from a Pipeline list row, opened
// over the row without opening the deal.
test("list-preview", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline?layout=list", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("table", { name: "Deals" }).getByText("Meridian Analytics", { exact: true }).first().hover();
  await page.getByText("Open pipeline", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/pipeline/);
  await expect(page).toHaveScreenshot("list-preview.png");
});

// Previous and next on a record (GET-650): a deal opened from the Pipeline board says where it
// sits in the board's order, and J moves to the next one. A deep link shows no navigator.
test("record-prev-next", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByText("Vantage Legal · Pilot", { exact: true }).click();
  await expect(page.getByText("2 of 19", { exact: true })).toBeVisible();
  await page.keyboard.press("j");
  await expect(page).toHaveURL(/\/accounts\/c2\/deals\/dl-13$/);
  await expect(page.getByText("3 of 19", { exact: true })).toBeVisible();
  await page.waitForFunction(() => !/\bLoading\b/.test(document.body.innerText), null, { timeout: 10_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot("record-prev-next.png");
  await page.goto("/accounts/c1/deals/dl-01", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: /^Overview/ }).waitFor();
  await expect(page.getByRole("button", { name: "Next deal" })).toHaveCount(0);
});

// The person record on the record layout (GET-655): the same two panes, tabs and cards as the
// account and the deal.
test("person-record", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/people/p1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !/\bLoading\b/.test(document.body.innerText), null, { timeout: 10_000 });
  await page.waitForTimeout(600);
  await expect(page).toHaveScreenshot("person-record.png");
});

// Polish pass (GET-656): the pipeline picker is the shared select, so it opens like every other
// menu (hairline border, 13px rows, the soft hover band) instead of the browser's own list.
test("pipeline-select-open", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("combobox", { name: "Pipeline" }).click();
  await page.getByRole("option", { name: /Expansion pipeline/ }).waitFor();
  await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot("pipeline-select-open.png");
});

// Polish pass (GET-657): Settings → Members, no page title of its own, the shared Select in the
// invite row and one plain style for every access value.
test("settings-members", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/settings?section=members", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByText("Jordan Reyes").waitFor();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("settings-members.png");
});

// Polish round 2 (GET-658): the account's Activity tab in the search palette's list language (one
// hairline card, inset rows led by the tool's logo, no lines between them).
test("account-activity", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/accounts/c1", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: /^Activity/ }).click();
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("account-activity.png");
});

// The Priorities inbox (GET-678, GET-681): the panel open on a meeting's wrap-up, read in place on
// the right with Home's own card in three parts: the thank-you email, the tasks, the CRM updates.
test("priorities-inbox-meeting", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /^Priorities/ }).click();
  // The newest meeting is selected as the panel opens, and the list takes the keyboard.
  await expect(page.getByRole("listbox", { name: "Priorities" })).toBeFocused();
  await expect(page.getByRole("option", { name: /Halcyon store analytics check-in/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Approve & send" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Follow-up email" })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("priorities-inbox-meeting.png");
});

// To approve (GET-681): a draft an automation wrote, waiting on your yes, read in place: who drafted
// it and when, why, and the email in chat's own approval card (Approve & send, Edit, Skip).
test("priorities-inbox-approve", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /^Priorities/ }).click();
  await expect(page.getByRole("listbox", { name: "Priorities" })).toBeFocused();
  // Past the three meetings and the automation run waiting on review (GET-737) to the second draft.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Stale deal detection · Pricing for the pilot/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Drafted by Stale deal detection", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & send" })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("priorities-inbox-approve.png");
});

// To approve, an automation's run (GET-737): on the Workspace plan its review is in Priorities —
// the tasks each with Skip / Approve, then the email draft — and Automations has no Approvals tab.
test("priorities-inbox-run", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "one view is enough");
  await page.goto("/pipeline", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: /^Priorities/ }).click();
  await expect(page.getByRole("listbox", { name: "Priorities" })).toBeFocused();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: /Follow-up after every call/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Send the SOC 2 report to Grace")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  await expect(page).toHaveScreenshot("priorities-inbox-run.png");
});
