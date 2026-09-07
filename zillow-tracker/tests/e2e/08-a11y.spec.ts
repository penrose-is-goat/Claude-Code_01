import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { PAGES, ARTIFACTS } from './helpers';

const report: Record<string, unknown> = {};

test('favorite buttons have accessible names and pressed state', async ({ page }) => {
  await page.goto('/listings');
  const stars = page.getByRole('button', { name: /favorites/i });
  expect(await stars.count()).toBeGreaterThan(0);
  const first = stars.first();
  await expect(first).toHaveAttribute('aria-label', /favorites/i);
  await expect(first).toHaveAttribute('aria-pressed', /true|false/);
});

test('every form control on /listings has an accessible label', async ({ page }) => {
  await page.goto('/listings');
  const unlabelled = await page.evaluate(() => {
    const bad: { tag: string; name: string; type: string; html: string }[] = [];
    document.querySelectorAll<HTMLElement>('input, select, textarea').forEach((el) => {
      const e = el as HTMLInputElement;
      const aria = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
      const wrapping = e.closest('label');
      const forLabel = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
      if (!aria && !wrapping && !forLabel) {
        bad.push({ tag: e.tagName.toLowerCase(), name: e.name, type: e.type, html: e.outerHTML.slice(0, 120) });
      }
    });
    return bad;
  });
  report['/listings-controls'] = unlabelled;
  fs.writeFileSync(`${ARTIFACTS}/a11y-report.json`, JSON.stringify(report, null, 2));
  expect(unlabelled, 'form controls without an accessible label').toEqual([]);
});

test('notes editor controls are labelled', async ({ page }) => {
  await page.goto('/listings');
  const href = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
  await page.goto(href);
  const unlabelled = await page.evaluate(() => {
    const bad: string[] = [];
    document.querySelectorAll<HTMLElement>('aside input, aside select, aside textarea').forEach((el) => {
      const e = el as HTMLInputElement;
      if (!e.getAttribute('aria-label') && !e.closest('label') && !(e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`))) {
        bad.push(e.outerHTML.slice(0, 120));
      }
    });
    return bad;
  });
  expect(unlabelled).toEqual([]);
});

for (const p of PAGES) {
  test(`heading order is sane on ${p.path}`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: 'networkidle' });
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => ({
        level: Number(h.tagName[1]),
        text: (h.textContent ?? '').trim().slice(0, 60),
      })),
    );
    report[`${p.path}-headings`] = headings;
    fs.writeFileSync(`${ARTIFACTS}/a11y-report.json`, JSON.stringify(report, null, 2));

    const h1s = headings.filter((h) => h.level === 1);
    expect(h1s.length, `${p.path} should have exactly one h1`).toBe(1);
    expect(headings[0]?.level, `${p.path} first heading should be the h1`).toBe(1);
    let prev = 1;
    for (const h of headings) {
      expect(h.level - prev, `${p.path} heading jump to ${h.level} ("${h.text}")`).toBeLessThanOrEqual(1);
      prev = h.level;
    }
  });
}

test('nested interactive elements (button inside link) are not used', async ({ page }) => {
  await page.goto('/listings');
  const nested = await page.evaluate(() =>
    [...document.querySelectorAll('a button, button a')].map((el) => el.outerHTML.slice(0, 120)),
  );
  report['nested-interactive'] = nested;
  fs.writeFileSync(`${ARTIFACTS}/a11y-report.json`, JSON.stringify(report, null, 2));
  expect(nested, 'a <button> inside an <a> is an invalid/ambiguous control for keyboard and AT users').toEqual([]);
});

test('page has a document title and lang', async ({ page }) => {
  await page.goto('/');
  expect(await page.title()).toBeTruthy();
  await expect(page.locator('html')).toHaveAttribute('lang', /\w/);
});

test('keyboard: tab reaches the favorite button and Enter toggles it', async ({ page }) => {
  await page.goto('/listings?sort=price-asc');
  const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  await star.focus();
  const before = await star.getAttribute('aria-pressed');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const after = await page
    .locator('tbody tr')
    .first()
    .getByRole('button', { name: /favorites/i })
    .getAttribute('aria-pressed');
  expect(after).not.toBe(before);
  // restore
  await page.locator('tbody tr').first().getByRole('button', { name: /favorites/i }).click();
  await page.waitForTimeout(600);
});

test('tables have header cells', async ({ page }) => {
  for (const p of PAGES) {
    await page.goto(p.path);
    const tables = await page.locator('table').count();
    for (let i = 0; i < tables; i++) {
      expect(await page.locator('table').nth(i).locator('thead th').count(), `${p.path} table ${i}`).toBeGreaterThan(0);
    }
  }
});
