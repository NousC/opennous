// GET-890: the app frame stays fixed to the viewport on a RevBox page with the Job Builder's
// ask card open. The card's sr-only radios used to be laid out against <body> (no positioned
// ancestor), making the document taller than the screen, so a wheel over the chat scrolled the
// whole shell up and left a blank band below it.
//
//   node apps/frontend/preview/server.mjs  +  pnpm --filter ./apps/frontend run dev:preview
//   node apps/frontend/preview/revbox-frame-smoke.mjs        (BASE=http://127.0.0.1:8080 by default)
import { chromium, expect } from '@playwright/test';
const base = process.env.BASE || 'http://127.0.0.1:8080';
const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--headless=old'], args: ['--headless=new'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => localStorage.setItem('nous_cookie_consent', JSON.stringify({ consent: 'essential', timestamp: Date.now() })));
// How far the document reaches past the viewport, and how far it has been scrolled.
const overflow = () => page.evaluate(() => ({ extra: document.scrollingElement.scrollHeight - innerHeight, scrolled: document.scrollingElement.scrollTop }));
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Create RevBox', exact: true }).click();
  await page.getByLabel('RevBox name').waitFor();
  await page.getByRole('button', { name: 'New job', exact: true }).first().click();
  await page.getByLabel('Describe the job').fill('Set up a job that pulls Credit Check account summaries from HubSpot and creates a report every morning for me into the Slack channel "Credit Check CS handoff".');
  await page.getByLabel('Describe the job').press('ControlOrMeta+Enter');
  await expect(page.getByRole('tab', { name: 'Channel' })).toBeVisible({ timeout: 20000 });
  for (const [width, height] of [[1440, 900], [1200, 800], [900, 700], [390, 800]]) {
    await page.setViewportSize({ width, height });
    await page.mouse.move(width / 2, height / 2);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    expect(await overflow(), `frame at ${width}x${height}`).toEqual({ extra: 0, scrolled: 0 });
  }
  await page.getByRole('button', { name: 'Results', exact: true }).click();
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  expect(await overflow(), 'frame on Results').toEqual({ extra: 0, scrolled: 0 });
  console.log('revbox frame smoke: ok');
} finally { await browser.close(); }
