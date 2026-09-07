import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { ARTIFACTS, rowCount } from './helpers';

test('Run poll now shows a status message and refreshes the page', async ({ page }) => {
  await page.goto('/');
  const before = await page.locator('h1 + p').textContent();
  const statBefore = await page.locator('.card').first().textContent();

  const btn = page.getByRole('button', { name: 'Run poll now' });
  await expect(btn).toBeVisible();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/jobs/poll') && r.request().method() === 'POST'),
    btn.click(),
  ]);
  expect(resp.status(), 'POST /api/jobs/poll').toBe(200);

  await expect(page.getByText(/Saw \d+ listings/)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${ARTIFACTS}/poll-result.png`, fullPage: true });

  const after = await page.locator('h1 + p').textContent();
  const statAfter = await page.locator('.card').first().textContent();
  expect(
    after !== before || statAfter !== statBefore,
    'after a poll the page should show refreshed data (last-checked timestamp or counts)',
  ).toBeTruthy();
});

test('Run poll now on /settings adds a row to the poll log', async ({ page }) => {
  await page.goto('/settings');
  const rowsBefore = await rowCount(page, 1);
  await page.getByRole('button', { name: 'Run poll now' }).click();
  await expect(page.getByText(/Saw \d+ listings/)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  const rowsAfter = await rowCount(page, 1);
  await page.screenshot({ path: `${ARTIFACTS}/poll-settings-log.png`, fullPage: true });
  expect(rowsAfter, 'the poll log should grow without a manual reload').toBeGreaterThan(rowsBefore);
});

test('poll failure is surfaced to the user', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/jobs/poll', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"provider exploded"}' }));
  await page.getByRole('button', { name: 'Run poll now' }).click();
  await expect(page.getByText(/provider exploded/)).toBeVisible({ timeout: 10_000 });
});

test('Excel export honours the on-screen filters', async ({ page, request }) => {
  const qs = 'minPrice=700000&type=SINGLE_FAMILY';
  await page.goto(`/listings?${qs}`);
  const onScreen = await rowCount(page);
  expect(onScreen).toBeGreaterThan(0);

  const exportHref = await page.locator('a[href*="/api/export/xlsx"]').getAttribute('href');
  expect(exportHref, 'export link should carry the current query string').toContain('minPrice=700000');
  expect(exportHref).toContain('type=SINGLE_FAMILY');

  const res = await request.get(exportHref!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  expect(res.headers()['content-disposition']).toContain('.xlsx');

  const buf = Buffer.from(await res.body());
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  fs.writeFileSync(`${ARTIFACTS}/export-filtered.xlsx`, buf);
  expect(buf.subarray(0, 2).toString()).toBe('PK'); // real zip/xlsx

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.worksheets.find((w) => /listing/i.test(w.name)) ?? wb.worksheets[0];

  // Compare the actual address column against what the page shows, not just a row count.
  const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const addrCol = headers.findIndex((h) => /address/i.test(h));
  expect(addrCol, 'xlsx should have an address column').toBeGreaterThan(0);

  const xlsxAddresses: string[] = [];
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    const v = row.getCell(addrCol).value as unknown;
    if (v == null) return;
    const text = typeof v === 'object' && v !== null && 'text' in v ? String((v as { text: unknown }).text) : String(v);
    xlsxAddresses.push(text.trim());
  });

  const screenAddresses = (await page.locator('tbody tr td:nth-child(2) a[href^="/listings/"]').allTextContents()).map((s) => s.trim());
  expect(xlsxAddresses.sort(), 'xlsx rows must be exactly the rows shown on screen').toEqual(screenAddresses.sort());
  expect(xlsxAddresses.length, `xlsx should hold the ${onScreen} filtered rows`).toBe(onScreen);
});

test('Excel export of an empty filter set still produces a valid file', async ({ request }) => {
  const res = await request.get('/api/export/xlsx?minPrice=9000000');
  expect(res.status()).toBe(200);
  const buf = Buffer.from(await res.body());
  expect(buf.subarray(0, 2).toString()).toBe('PK');
});

test('Saved page export link filters to favorites', async ({ page }) => {
  await page.goto('/saved');
  const href = await page.locator('a[href*="/api/export/xlsx"]').getAttribute('href');
  expect(href).toContain('favorites=1');
});
