import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { PAGES, collect, ARTIFACTS } from './helpers';

function writeReport(key: string, value: unknown) {
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(`${ARTIFACTS}/console-report.json`, 'utf8')); } catch { /* first run */ }
  existing[key] = value;
  fs.writeFileSync(`${ARTIFACTS}/console-report.json`, JSON.stringify(existing, null, 2));
}

/** Noise from the sandbox, not from the app: no favicon asset, and photos hotlinked to a blocked CDN. */
const NOISE = /favicon\.ico|photos\.zillowstatic\.com|ERR_TUNNEL_CONNECTION_FAILED/;

test.describe('every page renders cleanly', () => {
  for (const p of PAGES) {
    test(`${p.path} renders with no console/page errors`, async ({ page }) => {
      const c = collect(page);
      const res = await page.goto(p.path, { waitUntil: 'networkidle' });
      expect(res?.status(), `${p.path} HTTP status`).toBeLessThan(400);

      await expect(page.locator('h1')).toBeVisible();
      await page.waitForTimeout(1200); // let React hydrate so hydration warnings surface

      await page.screenshot({ path: `${ARTIFACTS}/desktop-${p.name}.png`, fullPage: true });

      writeReport(p.path, { console: c.console, pageErrors: c.pageErrors, failedRequests: c.failedRequests });

      expect(c.pageErrors, `uncaught exceptions on ${p.path}`).toEqual([]);
      const realErrors = c.console.filter((m) => m.type === 'error' && !NOISE.test(m.text) && !NOISE.test(m.location));
      expect(realErrors, `console errors on ${p.path}`).toEqual([]);
      const hydration = c.console.filter((m) => /hydrat|did not match|server HTML|key/i.test(m.text));
      expect(hydration, `hydration/key warnings on ${p.path}`).toEqual([]);
    });
  }

  test('/listings/[id] detail page renders cleanly', async ({ page }) => {
    const c = collect(page);
    await page.goto('/listings');
    const href = await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href');
    expect(href).toBeTruthy();
    await page.goto(href!, { waitUntil: 'networkidle' });
    await expect(page.locator('h1')).toBeVisible();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${ARTIFACTS}/desktop-listing-detail.png`, fullPage: true });

    writeReport('/listings/[id]', { console: c.console, pageErrors: c.pageErrors, failedRequests: c.failedRequests });

    expect(c.pageErrors).toEqual([]);
    const errs = c.console.filter((m) => m.type === 'error' && !NOISE.test(m.text) && !NOISE.test(m.location));
    expect(errs).toEqual([]);
  });

  test('404 page for unknown listing id', async ({ page }) => {
    const res = await page.goto('/listings/does-not-exist');
    expect(res?.status()).toBe(404);
    await page.screenshot({ path: `${ARTIFACTS}/listing-404.png`, fullPage: true });
  });
});
