import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { PAGES, ARTIFACTS, horizontalOverflow } from './helpers';

const WIDTHS = [375, 768, 1440];
const findings: Record<string, unknown> = {};

for (const w of WIDTHS) {
  test.describe(`viewport ${w}px`, () => {
    test.use({ viewport: { width: w, height: 900 } });

    for (const p of [...PAGES, { path: '__detail__', name: 'listing-detail' }]) {
      test(`${p.name} does not scroll the page horizontally`, async ({ page }) => {
        let target = p.path;
        if (p.path === '__detail__') {
          await page.goto('/listings');
          target = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
        }
        await page.goto(target, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);

        const info = await horizontalOverflow(page);
        await page.screenshot({ path: `${ARTIFACTS}/responsive-${w}-${p.name}.png`, fullPage: true });
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(`${ARTIFACTS}/responsive-report.json`, 'utf8')); } catch { /* first run */ }
        existing[`${w}-${p.name}`] = info;
        fs.writeFileSync(`${ARTIFACTS}/responsive-report.json`, JSON.stringify(existing, null, 2));

        expect(
          info.overflows,
          `${p.name} @${w}px: document scrollWidth ${info.scrollWidth} > clientWidth ${info.clientWidth}. Offenders: ${JSON.stringify(info.offenders)}`,
        ).toBe(false);
      });
    }

    test(`listings table scrolls inside .table-scroll @${w}px`, async ({ page }) => {
      await page.goto('/listings');
      const box = page.locator('.table-scroll').first();
      const scrolls = await box.evaluate((el) => ({
        overflowX: getComputedStyle(el).overflowX,
        scrollable: el.scrollWidth > el.clientWidth,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(scrolls.overflowX).toBe('auto');
      // At narrow widths the wide table MUST be scrollable inside its own box.
      if (w <= 768) expect(scrolls.scrollable, `table should scroll inside its container @${w}px`).toBe(true);
    });
  });
}

test.describe('mobile usability', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('nav is reachable at 375px', async ({ page }) => {
    await page.goto('/');
    for (const label of ["What's New", 'Listings', 'Open Houses', 'Saved', 'Areas', 'Settings']) {
      await expect(page.getByRole('link', { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first()).toBeVisible();
    }
  });

  test('detail page columns stack rather than squeeze at 375px', async ({ page }) => {
    await page.goto('/listings');
    const href = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
    await page.goto(href);
    const aside = page.locator('aside');
    const main = page.locator('aside').locator('xpath=preceding-sibling::div[1]');
    const a = await aside.boundingBox();
    const m = await main.boundingBox();
    await page.screenshot({ path: `${ARTIFACTS}/responsive-375-detail-columns.png`, fullPage: true });
    expect(
      a && m ? a.y >= m.y + m.height - 5 || a.width >= 300 : true,
      `notes sidebar is squeezed next to the main column at 375px (main ${JSON.stringify(m)}, aside ${JSON.stringify(a)})`,
    ).toBeTruthy();
  });
});
