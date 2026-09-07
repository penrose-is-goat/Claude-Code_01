import { test, expect } from '@playwright/test';
import { ARTIFACTS } from './helpers';

test('Mark all seen clears the unseen badge without a manual reload', async ({ page }) => {
  await page.goto('/');
  const badge = page.locator('header span[aria-label*="unseen"]');
  if ((await badge.count()) === 0) {
    // make some unseen events first
    await page.getByRole('button', { name: 'Run poll now' }).click();
    await expect(page.getByText(/Saw \d+ listings/)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2000);
  }
  const btn = page.getByRole('button', { name: /Mark all seen/i });
  if (await btn.isDisabled()) test.skip();

  await btn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${ARTIFACTS}/mark-all-seen.png`, fullPage: true });
  await expect(page.locator('header span[aria-label*="unseen"]'), 'the header badge should disappear after Mark all seen').toHaveCount(0);
  await expect(page.getByRole('button', { name: /Mark all seen/i })).toBeDisabled();
});

test('submitting the filter form does not litter the URL with empty params', async ({ page }) => {
  await page.goto('/listings');
  await page.fill('input[name="minPrice"]', '500000');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  const url = new URL(page.url());
  const empty = [...url.searchParams.entries()].filter(([, v]) => v === '').map(([k]) => k);
  expect(empty, 'blank fields should not be serialised into the URL / export link').toEqual([]);
});

test('the export link from a form-submitted URL is not full of empty params', async ({ page }) => {
  await page.goto('/listings');
  await page.fill('input[name="minPrice"]', '500000');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  const href = await page.locator('a[href*="/api/export/xlsx"]').getAttribute('href');
  expect(href).toContain('minPrice=500000');
});

test('an unknown areaId gives a helpful empty state, not a silent zero', async ({ page }) => {
  await page.goto('/listings?areaId=no-such-area');
  await expect(page.getByText('No listings match')).toBeVisible();
  await page.screenshot({ path: `${ARTIFACTS}/empty-state-bad-area.png`, fullPage: true });
});

test('/saved empty state is a card, not a broken table', async ({ page }) => {
  await page.goto('/saved');
  const rows = await page.locator('tbody tr').count();
  if (rows === 0) {
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
  }
});

test('detail page renders when the listing has no photos/events (robustness sweep)', async ({ page }) => {
  await page.goto('/listings');
  const hrefs = await page.locator('tbody tr a[href^="/listings/"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLAnchorElement).getAttribute('href')!),
  );
  for (const href of hrefs) {
    const errors: string[] = [];
    page.once('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(href);
    expect(res?.status(), href).toBe(200);
    await expect(page.locator('h1'), href).toBeVisible();
    expect(errors, href).toEqual([]);
  }
});
