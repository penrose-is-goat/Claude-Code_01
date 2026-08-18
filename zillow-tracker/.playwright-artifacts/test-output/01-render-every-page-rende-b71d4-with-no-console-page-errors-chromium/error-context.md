# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-render.spec.ts >> every page renders cleanly >> /saved renders with no console/page errors
- Location: tests/e2e/01-render.spec.ts:17:5

# Error details

```
Error: /saved HTTP status

expect(received).toBeLessThan(expected)

Expected: < 400
Received:   500
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - 'heading "Application error: a server-side exception has occurred while loading localhost (see the server logs for more information)." [level=2] [ref=e4]'
  - paragraph [ref=e5]: "Digest: 750024223"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import fs from 'node:fs';
  3  | import { PAGES, collect, ARTIFACTS } from './helpers';
  4  | 
  5  | function writeReport(key: string, value: unknown) {
  6  |   let existing: Record<string, unknown> = {};
  7  |   try { existing = JSON.parse(fs.readFileSync(`${ARTIFACTS}/console-report.json`, 'utf8')); } catch { /* first run */ }
  8  |   existing[key] = value;
  9  |   fs.writeFileSync(`${ARTIFACTS}/console-report.json`, JSON.stringify(existing, null, 2));
  10 | }
  11 | 
  12 | /** Noise from the sandbox, not from the app: no favicon asset, and photos hotlinked to a blocked CDN. */
  13 | const NOISE = /favicon\.ico|photos\.zillowstatic\.com|ERR_TUNNEL_CONNECTION_FAILED/;
  14 | 
  15 | test.describe('every page renders cleanly', () => {
  16 |   for (const p of PAGES) {
  17 |     test(`${p.path} renders with no console/page errors`, async ({ page }) => {
  18 |       const c = collect(page);
  19 |       const res = await page.goto(p.path, { waitUntil: 'networkidle' });
> 20 |       expect(res?.status(), `${p.path} HTTP status`).toBeLessThan(400);
     |                                                      ^ Error: /saved HTTP status
  21 | 
  22 |       await expect(page.locator('h1')).toBeVisible();
  23 |       await page.waitForTimeout(1200); // let React hydrate so hydration warnings surface
  24 | 
  25 |       await page.screenshot({ path: `${ARTIFACTS}/desktop-${p.name}.png`, fullPage: true });
  26 | 
  27 |       writeReport(p.path, { console: c.console, pageErrors: c.pageErrors, failedRequests: c.failedRequests });
  28 | 
  29 |       expect(c.pageErrors, `uncaught exceptions on ${p.path}`).toEqual([]);
  30 |       const realErrors = c.console.filter((m) => m.type === 'error' && !NOISE.test(m.text) && !NOISE.test(m.location));
  31 |       expect(realErrors, `console errors on ${p.path}`).toEqual([]);
  32 |       const hydration = c.console.filter((m) => /hydrat|did not match|server HTML|key/i.test(m.text));
  33 |       expect(hydration, `hydration/key warnings on ${p.path}`).toEqual([]);
  34 |     });
  35 |   }
  36 | 
  37 |   test('/listings/[id] detail page renders cleanly', async ({ page }) => {
  38 |     const c = collect(page);
  39 |     await page.goto('/listings');
  40 |     const href = await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href');
  41 |     expect(href).toBeTruthy();
  42 |     await page.goto(href!, { waitUntil: 'networkidle' });
  43 |     await expect(page.locator('h1')).toBeVisible();
  44 |     await page.waitForTimeout(1200);
  45 |     await page.screenshot({ path: `${ARTIFACTS}/desktop-listing-detail.png`, fullPage: true });
  46 | 
  47 |     writeReport('/listings/[id]', { console: c.console, pageErrors: c.pageErrors, failedRequests: c.failedRequests });
  48 | 
  49 |     expect(c.pageErrors).toEqual([]);
  50 |     const errs = c.console.filter((m) => m.type === 'error' && !NOISE.test(m.text) && !NOISE.test(m.location));
  51 |     expect(errs).toEqual([]);
  52 |   });
  53 | 
  54 |   test('404 page for unknown listing id', async ({ page }) => {
  55 |     const res = await page.goto('/listings/does-not-exist');
  56 |     expect(res?.status()).toBe(404);
  57 |     await page.screenshot({ path: `${ARTIFACTS}/listing-404.png`, fullPage: true });
  58 |   });
  59 | });
  60 | 
```