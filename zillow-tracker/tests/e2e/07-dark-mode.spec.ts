import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { PAGES, ARTIFACTS, textContrastReport } from './helpers';

function writeReport(file: string, key: string, value: unknown) {
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(`${ARTIFACTS}/${file}`, 'utf8')); } catch { /* first run */ }
  existing[key] = value;
  fs.writeFileSync(`${ARTIFACTS}/${file}`, JSON.stringify(existing, null, 2));
}

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });

  for (const p of PAGES) {
    test(`${p.path} has readable text in dark mode`, async ({ page }) => {
      await page.goto(p.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${ARTIFACTS}/dark-${p.name}.png`, fullPage: true });

      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg, 'body should pick up the dark palette').not.toBe('rgb(247, 247, 245)');

      const results = await textContrastReport(page);
      const bad = results.filter((r) => r.ratio < 3);
      writeReport('dark-mode-report.json', p.path, { bodyBg, worst: results.sort((a, b) => a.ratio - b.ratio).slice(0, 12), bad });

      expect(bad, `text with contrast < 3:1 on ${p.path} in dark mode`).toEqual([]);
    });
  }

  test('listing detail is readable in dark mode', async ({ page }) => {
    await page.goto('/listings');
    const href = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
    await page.goto(href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${ARTIFACTS}/dark-listing-detail.png`, fullPage: true });
    const bad = (await textContrastReport(page)).filter((r) => r.ratio < 3);
    writeReport('dark-mode-report.json', '/listings/[id]', bad);
    expect(bad).toEqual([]);
  });

  test('form controls are legible in dark mode', async ({ page }) => {
    await page.goto('/listings');
    const styles = await page.locator('input[name="minPrice"]').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { color: cs.color, background: cs.backgroundColor, border: cs.borderColor };
    });
    writeReport('dark-mode-report.json', 'form-controls', styles);
    expect(styles.color).not.toBe(styles.background);
  });

  test('status badges keep contrast in dark mode', async ({ page }) => {
    await page.goto('/listings', { waitUntil: 'networkidle' });
    const badges = await page.locator('span:has-text("Pending"), span:has-text("Active")').evaluateAll((els) =>
      els.map((el) => {
        const cs = getComputedStyle(el);
        let bgEl: Element | null = el;
        let bg = 'rgba(0, 0, 0, 0)';
        while (bgEl) {
          const c = getComputedStyle(bgEl).backgroundColor;
          if (!/rgba\(0, 0, 0, 0\)/.test(c)) { bg = c; break; }
          bgEl = bgEl.parentElement;
        }
        return { text: el.textContent, color: cs.color, bg };
      }),
    );
    writeReport('dark-mode-report.json', 'badges', badges);
    expect(badges.length).toBeGreaterThan(0);
  });
});

test.describe('light mode sanity', () => {
  test.use({ colorScheme: 'light' });
  test('listings text is readable in light mode', async ({ page }) => {
    await page.goto('/listings', { waitUntil: 'networkidle' });
    const bad = (await textContrastReport(page)).filter((r) => r.ratio < 3);
    fs.writeFileSync(`${ARTIFACTS}/light-mode-report.json`, JSON.stringify(bad, null, 2));
    expect(bad).toEqual([]);
  });
});
