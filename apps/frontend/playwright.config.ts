import { defineConfig } from "@playwright/test";

// Visual baselines (GET-596, interface refresh). Every route of the app, plus the UI gallery,
// screenshotted in preview mode against the fixture world, so a page PR can't drift from the
// design canvas unnoticed. One fixed clock for the mock API and the browser keeps the
// fixtures' relative dates ("closes in 12 days") identical run to run.
//
//   pnpm --filter ./apps/frontend test:visual           compare against the baselines
//   pnpm --filter ./apps/frontend test:visual:update    accept intended changes
//
// Baselines are per platform (font rendering differs); the committed ones are macOS.
export const NOW = "2026-10-02T17:30:00Z";
// Ports are overridable so several worktrees can run the suite at once.
const WEB = Number(process.env.VISUAL_WEB_PORT) || 8092;
const API = Number(process.env.VISUAL_API_PORT) || 3000;

export default defineConfig({
  testDir: "./tests/visual",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}-{platform}{ext}",
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.05, animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL: `http://localhost:${WEB}`,
    timezoneId: "Europe/Berlin",
    locale: "en-US",
  },
  projects: [
    { name: "desktop-light", use: { viewport: { width: 1440, height: 900 }, colorScheme: "light" } },
    { name: "desktop-dark", use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" } },
    { name: "mobile-light", use: { viewport: { width: 390, height: 844 }, colorScheme: "light" } },
  ],
  webServer: [
    {
      command: "node --import ./preview/fixed-clock.mjs preview/server.mjs",
      port: API,
      env: { PREVIEW_NOW: NOW, TZ: "Europe/Berlin", PORT: String(API) },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${WEB} --strictPort`,
      port: WEB,
      env: { VITE_PREVIEW: "1", VITE_PROXY_TARGET: `http://localhost:${API}` },
      reuseExistingServer: false,
    },
  ],
});
