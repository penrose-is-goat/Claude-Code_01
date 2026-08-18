/**
 * Independent UI audit — written from scratch against the running production build.
 * Nothing here modifies src/; it only observes and reports.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import {
  ARTIFACTS, PAGES, collect, isExternalAssetNoise, rowCount, horizontalOverflow,
  textContrastReport, loadListings, clearSavedListings, type Row,
} from './helpers';

fs.mkdirSync(ARTIFACTS, { recursive: true });

const findings: { id: string; severity: string; title: string; detail: string }[] = [];
function bug(id: string, severity: string, title: string, detail: string) {
  findings.push({ id, severity, title, detail });
  console.log(`\n[${severity}] ${id} — ${title}\n${detail}\n`);
}

test.afterAll(() => {
  fs.writeFileSync(`${ARTIFACTS}/audit-findings.json`, JSON.stringify(findings, null, 2));
});

async function firstListingId(): Promise<string> {
  const rows = await loadListings();
  return rows[0].id;
}

// ---------------------------------------------------------------- 1. rendering

test('1. every page renders with no console errors or exceptions', async ({ page }) => {
  const all: Record<string, unknown> = {};
  const id = await firstListingId();
  const targets = [...PAGES, { path: `/listings/${id}`, name: 'detail' }];

  for (const p of targets) {
    const c = collect(page);
    const resp = await page.goto(p.path, { waitUntil: 'networkidle' });
    expect(resp?.status(), `${p.path} HTTP status`).toBeLessThan(400);
    await page.waitForTimeout(400);
    const real = c.console.filter((m) => !isExternalAssetNoise(m.text));
    const errs = c.pageErrors;
    all[p.path] = { console: real, pageErrors: errs, failedRequests: c.failedRequests };
    await page.screenshot({ path: `${ARTIFACTS}/audit-render-${p.name}.png`, fullPage: true });
    if (real.length || errs.length) {
      bug(`RENDER-${p.name}`, 'HIGH', `console noise on ${p.path}`,
        JSON.stringify({ console: real, pageErrors: errs }, null, 2));
    }
    // main landmark and an h1 should exist
    expect(await page.locator('h1').count(), `${p.path} has an h1`).toBeGreaterThan(0);
  }
  fs.writeFileSync(`${ARTIFACTS}/audit-console.json`, JSON.stringify(all, null, 2));
});

test('1b. unknown listing id gives a 404 page, not a crash', async ({ page }) => {
  const c = collect(page);
  const resp = await page.goto('/listings/does-not-exist');
  expect(resp?.status()).toBe(404);
  expect(c.pageErrors, 'no uncaught errors on 404').toEqual([]);
});

// ------------------------------------------------------------------ 2. filters

function expected(rows: Row[], f: Partial<{ minPrice: number; maxPrice: number; minBeds: number; status: string; type: string }>) {
  return rows.filter((r) => {
    // NOTE: the app deliberately keeps null-price rows when a price filter is set.
    if (f.minPrice != null && !(r.price == null || r.price >= f.minPrice)) return false;
    if (f.maxPrice != null && !(r.price == null || r.price <= f.maxPrice)) return false;
    if (f.minBeds != null && !(r.beds != null && r.beds >= f.minBeds)) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.type && r.type !== f.type) return false;
    return true;
  }).length;
}

test('2. filters actually filter, and the URL round-trips', async ({ page }) => {
  const rows = await loadListings();
  await page.goto('/listings');
  const baseline = await rowCount(page);
  expect(baseline, 'unfiltered row count matches DB').toBe(rows.length);

  const cases: { qs: string; f: Parameters<typeof expected>[1]; label: string }[] = [
    { qs: 'minPrice=1000000', f: { minPrice: 1_000_000 }, label: 'min price' },
    { qs: 'maxPrice=500000', f: { maxPrice: 500_000 }, label: 'max price' },
    { qs: 'minPrice=600000&maxPrice=900000', f: { minPrice: 600_000, maxPrice: 900_000 }, label: 'price band' },
    { qs: 'minBeds=4', f: { minBeds: 4 }, label: 'beds' },
    { qs: 'status=PENDING', f: { status: 'PENDING' }, label: 'status' },
    { qs: 'type=CONDO', f: { type: 'CONDO' }, label: 'type' },
    { qs: 'type=CONDO&minBeds=2', f: { type: 'CONDO', minBeds: 2 }, label: 'type+beds' },
  ];

  for (const c of cases) {
    await page.goto(`/listings?${c.qs}`);
    const got = await rowCount(page);
    const want = expected(rows, c.f);
    if (got !== want) {
      bug(`FILTER-${c.label}`, 'HIGH', `${c.label} filter returns the wrong number of rows`,
        `/listings?${c.qs} showed ${got} rows, DB says ${want}`);
    }
    expect(got, `${c.label} (${c.qs})`).toBe(want);

    // subtitle must reflect the count
    const sub = (await page.locator('h1 + p').textContent()) ?? '';
    expect(sub, `${c.label} subtitle count`).toContain(`${got} match`);
  }
});

test('2b. filter form controls repopulate from the URL (round-trip on reload)', async ({ page }) => {
  await page.goto('/listings?minPrice=600000&maxPrice=900000&minBeds=3&status=ACTIVE&type=SINGLE_FAMILY&favorites=1');
  await expect(page.locator('input[name=minPrice]')).toHaveValue('600000');
  await expect(page.locator('input[name=maxPrice]')).toHaveValue('900000');
  await expect(page.locator('input[name=minBeds]')).toHaveValue('3');
  await expect(page.locator('select[name=status]')).toHaveValue('ACTIVE');
  await expect(page.locator('select[name=type]')).toHaveValue('SINGLE_FAMILY');
  await expect(page.locator('input[name=favorites]')).toBeChecked();
});

test('2c. the subtitle names every filter that is applied', async ({ page }) => {
  const rowsA = await loadListings();
  expect(rowsA.length).toBeGreaterThan(0);
  await page.goto('/listings?minPrice=600000&status=ACTIVE&type=CONDO&sort=price-asc');
  const sub = (await page.locator('h1 + p').textContent()) ?? '';
  for (const frag of ['min $600,000', 'status Active', 'type Condo']) {
    expect(sub, 'subtitle mentions ' + frag).toContain(frag);
  }

  // Area is a filter offered by the form; is it described too?
  const areaVal = await page.locator('select[name=areaId] option').nth(1).getAttribute('value');
  if (areaVal) {
    await page.goto(`/listings?areaId=${areaVal}`);
    const sub2 = (await page.locator('h1 + p').textContent()) ?? '';
    const areaName = await page.locator(`select[name=areaId] option[value="${areaVal}"]`).textContent();
    if (!sub2.includes(areaName ?? '__none__')) {
      bug('FILTER-subtitle-area', 'LOW', 'subtitle omits the Area filter',
        `/listings?areaId=${areaVal} filters to one area but the subtitle reads "${sub2.trim()}" — the only ` +
        `filter that changes the result set is invisible. Sort is also undescribed (acceptable), but Area is a real narrowing filter.`);
    }
  }
});

test('2d. Reset clears the form, not just the URL', async ({ page }) => {
  await page.goto('/listings?minPrice=1000000&minBeds=4&status=ACTIVE&favorites=1');
  const before = await rowCount(page);
  await page.locator('button', { hasText: 'Reset' }).click();
  await page.waitForURL('**/listings');
  await page.waitForTimeout(500);

  const after = await rowCount(page);
  const minPrice = await page.locator('input[name=minPrice]').inputValue();
  const minBeds = await page.locator('input[name=minBeds]').inputValue();
  const status = await page.locator('select[name=status]').inputValue();
  const favChecked = await page.locator('input[name=favorites]').isChecked();
  await page.screenshot({ path: `${ARTIFACTS}/audit-reset.png`, fullPage: true });

  const stale = [
    minPrice ? `minPrice="${minPrice}"` : '',
    minBeds ? `minBeds="${minBeds}"` : '',
    status ? `status="${status}"` : '',
    favChecked ? 'favorites=checked' : '',
  ].filter(Boolean);

  if (stale.length) {
    bug('RESET-desync', 'HIGH', 'Reset clears the results but leaves the filter form filled in',
      `From /listings?minPrice=1000000&minBeds=4&status=ACTIVE&favorites=1 (${before} rows), clicking Reset ` +
      `navigates to /listings and the table returns to ${after} rows, but the form still shows ${stale.join(', ')}. ` +
      `Pressing Apply immediately after Reset re-applies the "cleared" filters. Cause: the inputs use ` +
      `defaultValue/defaultChecked and Reset is a client-side <Link>, so React never re-initialises the DOM values.`);
  }
  expect(stale, 'form fields after Reset').toEqual([]);
});

test('2e. submitting the form does not fill the URL with empty params', async ({ page }) => {
  await page.goto('/listings');
  await page.locator('input[name=minBeds]').fill('4');
  await page.locator('button[type=submit]').click();
  await page.waitForLoadState('networkidle');
  const url = new URL(page.url());
  const empties = [...url.searchParams.entries()].filter(([, v]) => v === '').map(([k]) => k);
  if (empties.length) {
    bug('FORM-empty-params', 'LOW', 'Apply writes every empty field into the URL',
      `After typing Beds=4 and pressing Apply the URL is ${url.pathname}${url.search} — ` +
      `empty keys: ${empties.join(', ')}. Shareable/bookmarkable URLs are noisy; behaviour is otherwise correct.`);
  }
});

// ---------------------------------------------------------------- 3. favorites

test('3. favorite toggle persists, shows on /saved, and un-favorites', async ({ page }) => {
  await clearSavedListings();
  await page.goto('/listings');
  const star = page.locator('tbody tr').first().locator('button[aria-label*="favorites" i]');
  const addr = (await page.locator('tbody tr').first().locator('td').nth(1).textContent()) ?? '';
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: `${ARTIFACTS}/audit-fav-on.png` });

  await page.reload();
  await expect(page.locator('tbody tr').first().locator('button[aria-label*="favorites" i]'))
    .toHaveAttribute('aria-pressed', 'true');

  await page.goto('/saved');
  expect(await rowCount(page), '/saved shows the favorite').toBe(1);
  expect((await page.locator('tbody').textContent()) ?? '').toContain(addr.split(',')[0].trim().slice(0, 12));

  // unfavorite from /saved
  await page.locator('tbody tr').first().locator('button[aria-label*="favorites" i]').click();
  await page.waitForTimeout(800);
  await page.reload();
  expect(await rowCount(page), '/saved is empty after unfavoriting').toBe(0);
  await expect(page.getByText('Nothing saved yet')).toBeVisible();
});

test('3b. optimistic favorite reverts on failure — and tells the user', async ({ page }) => {
  await clearSavedListings();
  await page.goto('/listings');

  // Server-side truth: a bogus id is rejected.
  const api = await page.request.post('/api/listings/bogus-id-123/favorite');
  expect(api.status(), 'bogus listing id is a 404').toBe(404);

  // Force the same failure for a real click, with a delay so the optimistic state is observable.
  await page.route('**/api/listings/*/favorite', async (r) => {
    await new Promise((res) => setTimeout(res, 700));
    await r.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false,"error":"No Listing found"}' });
  });

  const star = page.locator('tbody tr').first().locator('button[aria-label*="favorites" i]');
  const before = ((await page.locator('main').textContent()) ?? '').replace(/\s+/g, ' ');
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true'); // optimistic flip
  await page.waitForTimeout(1800);
  const reverted = await star.getAttribute('aria-pressed');
  await page.screenshot({ path: `${ARTIFACTS}/audit-fav-failure.png`, fullPage: false });

  const after = ((await page.locator('main').textContent()) ?? '').replace(/\s+/g, ' ');
  const toldUser = after !== before; // any new message at all would change the page text
  if (reverted === 'false' && !toldUser) {
    bug('FAV-silent-failure', 'MEDIUM', 'A failed favorite silently un-stars with no error message',
      `With the favorite endpoint returning 404 (reproduce for real by POSTing /api/listings/<deleted-or-bogus-id>/favorite, ` +
      `or by starring a listing that was removed in another tab), the star flips on, then flips back off ~200ms later ` +
      `and nothing is shown to the user. The UI is indistinguishable from a mis-click, so the user just clicks again. ` +
      `src/components/actions.tsx FavoriteButton.toggle(): "if (!res.ok) setFav(!next)" with no error surface.`);
  }
  expect(reverted, 'optimistic state reverts on failure').toBe('false');
  await page.unroute('**/api/listings/*/favorite');
});

test('3c. favorite state stays in sync with the server after a refresh', async ({ page }) => {
  await clearSavedListings();
  const id = await firstListingId();
  await page.goto(`/listings/${id}`);

  // Saving a note (never touching the star) — does the star agree with the DB afterwards?
  await page.locator('textarea').fill('sync probe');
  await page.locator('button', { hasText: 'Save' }).click();
  await page.waitForTimeout(1200);

  const starPressed = await page.locator('button[aria-label*="favorites" i]').getAttribute('aria-pressed');
  const { prisma } = await import('../../src/lib/db/client');
  const saved = await prisma.savedListing.findUnique({ where: { listingId: id } });
  const dbFav = saved?.favorite ?? false;

  await page.goto('/saved');
  const onSavedPage = await rowCount(page);
  await page.screenshot({ path: `${ARTIFACTS}/audit-notes-implicit-favorite.png`, fullPage: true });

  if (dbFav && starPressed === 'false') {
    bug('NOTES-implicit-favorite', 'HIGH', 'Saving a note silently favorites the listing, and the star lies about it',
      `Repro: /saved is empty. Open any listing detail page, type anything in Notes, press Save (do NOT touch the star). ` +
      `The star on that page still reads aria-pressed="false" / ☆, but the DB row now has favorite=true and the listing ` +
      `appears on /saved (${onSavedPage} row(s)). Clicking the star next — which looks like "add to favorites" — actually ` +
      `REMOVES it, and silently discards nothing else but is the opposite of the labelled action. ` +
      `Cause: queries.updateSaved() creates SavedListing with favorite:true, and FavoriteButton keeps its own useState ` +
      `seeded once from props, so router.refresh() cannot correct it.`);
  }
  expect({ starPressed, dbFav }).toEqual({ starPressed: dbFav ? 'true' : 'false', dbFav });
});

// -------------------------------------------------------------------- 4. notes

test('4. notes / rating / status / tags persist across a reload', async ({ page }) => {
  await clearSavedListings();
  const id = await firstListingId();
  await page.goto(`/listings/${id}`);

  await page.locator('select').first().selectOption('TOURED');
  await page.locator('select').nth(1).selectOption('4');
  await page.locator('textarea').fill('Great light. Roof needs work.');
  await page.locator('input[placeholder*="good schools"]').fill('quiet');
  await page.locator('button', { hasText: 'Save' }).click();
  await expect(page.locator('aside span.good', { hasText: 'Saved' })).toBeVisible();

  await page.reload();
  await expect(page.locator('select').first()).toHaveValue('TOURED');
  await expect(page.locator('select').nth(1)).toHaveValue('4');
  await expect(page.locator('textarea')).toHaveValue('Great light. Roof needs work.');
  await expect(page.locator('input[placeholder*="good schools"]')).toHaveValue('quiet');
  await page.screenshot({ path: `${ARTIFACTS}/audit-notes-persisted.png`, fullPage: true });
});

test('4b. the tags field lets you type a second tag', async ({ page }) => {
  await clearSavedListings();
  const id = await firstListingId();
  await page.goto(`/listings/${id}`);
  const tags = page.locator('input[placeholder*="good schools"]');

  await tags.click();
  await page.keyboard.type('alpha, beta', { delay: 30 });
  const typed = await tags.inputValue();
  await page.screenshot({ path: `${ARTIFACTS}/audit-tags-typing.png` });

  if (typed !== 'alpha, beta') {
    bug('TAGS-comma-swallowed', 'HIGH', 'The tags field eats the comma, so a second tag cannot be typed',
      `Repro: open any listing detail page, click the "Tags (comma separated)" input and type: alpha, beta ` +
      `The field ends up reading "${typed}" instead of "alpha, beta". Every keystroke is round-tripped through ` +
      `split(',').map(trim).filter(Boolean).join(', '), so the trailing comma (and the space after it) is deleted the ` +
      `instant you type it and the caret jumps. The placeholder tells you to separate tags with commas; you cannot. ` +
      `Only paste, or typing the tags out of order, works. src/components/actions.tsx SavedNotesEditor tags input.`);
  }
  expect(typed).toBe('alpha, beta');
});

test('4c. tags survive commas-in-value, quotes, unicode, and an over-long tag', async ({ page }) => {
  await clearSavedListings();
  const id = await firstListingId();
  const { prisma } = await import('../../src/lib/db/client');
  const tagsInput = 'input[placeholder*="good schools"]';

  // (i) quotes + unicode, entered by paste (typing is covered above)
  await page.goto(`/listings/${id}`);
  await page.locator(tagsInput).fill('he said "yes", 日本語タグ, café — naïve');
  await page.locator('button', { hasText: 'Save' }).click();
  await expect(page.locator('aside span.good', { hasText: 'Saved' })).toBeVisible();
  await page.reload();
  const after = await page.locator(tagsInput).inputValue();
  expect(after, 'unicode + quotes round-trip').toContain('日本語タグ');
  expect(after, 'unicode + quotes round-trip').toContain('café — naïve');
  await page.screenshot({ path: `${ARTIFACTS}/audit-tags-unicode.png`, fullPage: true });
  // a tag containing a comma is destroyed by the comma-splitting model
  if (!after.includes('he said "yes",')) {
    bug('TAGS-no-escape', 'LOW', 'A tag that contains a comma is silently split into two tags',
      `Enter the tag: he said "yes"  →  it is stored as ["he said \\"yes\\"", ...]. Entering any value with a comma in it ` +
      `(e.g. "Boulder, CO") becomes two tags with no way to escape. Inherent to the comma-split model; worth a chip UI.`);
  }

  // (ii) over-long tag: server rejects at 60 chars — does the UI notice?
  const longTag = 'x'.repeat(120);
  await page.goto(`/listings/${id}`);
  await page.locator(tagsInput).fill(longTag);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/saved') && r.request().method() === 'POST'),
    page.locator('button', { hasText: 'Save' }).click(),
  ]);
  const status = resp.status();
  await page.waitForTimeout(800);
  const showsSaved = await page.locator('aside span.good', { hasText: 'Saved' }).isVisible();
  const bodyText = (await page.locator('aside').textContent()) ?? '';
  const showsError = /too long|invalid|error|failed|not saved|60 character/i.test(bodyText);
  await page.screenshot({ path: `${ARTIFACTS}/audit-notes-long-tag.png`, fullPage: true });

  const row = await prisma.savedListing.findUnique({ where: { listingId: id } });
  const persisted = row ? (JSON.parse(row.tags) as string[]) : [];

  if (status >= 400 && showsSaved && !showsError) {
    bug('NOTES-false-save', 'HIGH', 'The notes editor reports "Saved" even when the server rejects the save',
      `Repro: open a listing detail page, paste a tag longer than 60 characters (e.g. 120 x's) into the Tags field ` +
      `and press Save. The POST /api/listings/<id>/saved returns HTTP ${status} and nothing is written, but the green ` +
      `"Saved" confirmation appears anyway and no error is shown. Reload and the tag is gone — DB still holds ` +
      `${JSON.stringify(persisted)}. The same silent-loss path applies to notes over 10,000 characters and to more than ` +
      `30 tags. Cause: src/components/actions.tsx SavedNotesEditor.save() never inspects the response ` +
      `("await fetch(...); setSaved(true)") and has no catch.`);
  }
  expect({ status, showsSaved, showsError }).not.toEqual({ status: 400, showsSaved: true, showsError: false });
});

test('4d. a rejected save throws away the whole edit, silently', async ({ page }) => {
  await clearSavedListings();
  const id = await firstListingId();
  const { prisma } = await import('../../src/lib/db/client');

  await page.goto(`/listings/${id}`);
  await page.locator('select').first().selectOption('OFFER');
  await page.locator('select').nth(1).selectOption('5');
  await page.locator('textarea').fill('We are making an offer on Monday.');
  await page.locator('input[placeholder*="good schools"]').fill('x'.repeat(70)); // one bad tag
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/saved') && r.request().method() === 'POST'),
    page.locator('button', { hasText: 'Save' }).click(),
  ]);
  await page.waitForTimeout(800);
  const confirmed = await page.locator('aside span.good', { hasText: 'Saved' }).isVisible();
  const row = await prisma.savedListing.findUnique({ where: { listingId: id } });
  await page.reload();
  const notesAfter = await page.locator('textarea').inputValue();
  const statusAfter = await page.locator('select').first().inputValue();

  if (resp.status() >= 400 && confirmed && !notesAfter) {
    bug('NOTES-whole-edit-lost', 'HIGH', 'One invalid tag silently discards the notes, rating AND status typed alongside it',
      `Repro: on a listing detail page set My status = OFFER, Rating = 5, type notes, and add one tag longer than ` +
      `60 chars. Press Save. HTTP ${resp.status()} comes back, the whole payload is rejected, the green "Saved" badge ` +
      `still appears, and reloading shows notes="${notesAfter}" status="${statusAfter}" (DB row: ${row ? 'exists' : 'absent'}). ` +
      `Everything the user typed is gone with no warning. The editor posts all four fields as one object and ignores the response.`);
  }
  expect({ status: resp.status(), confirmed }).not.toEqual({ status: 400, confirmed: true });
});

test('2f. pressing Apply right after Reset silently re-applies the cleared filters', async ({ page }) => {
  await page.goto('/listings?status=PENDING');
  const filtered = await rowCount(page);
  await page.locator('button', { hasText: 'Reset' }).click();
  await page.waitForURL('**/listings');
  await page.waitForTimeout(400);
  const afterReset = await rowCount(page);
  await page.locator('button[type=submit]').click();
  await page.waitForLoadState('networkidle');
  const afterApply = await rowCount(page);
  if (afterReset !== afterApply) {
    bug('RESET-reapplies', 'HIGH', 'Reset then Apply re-applies the filter you just cleared',
      `Start at /listings?status=PENDING (${filtered} rows). Click Reset -> ${afterReset} rows at /listings. ` +
      `Without touching any field, click Apply -> ${afterApply} rows at ${page.url()}. The stale <select> value was ` +
      `resubmitted, so Reset only looked like it worked.`);
  }
  expect(afterApply, 'rows after Reset + Apply').toBe(afterReset);
});

test('2g. text search and sort behave', async ({ page }) => {
  const rows = await loadListings();
  await page.goto('/listings?q=Pine');
  const n = await rowCount(page);
  expect(n).toBe(rows.filter((r) => r.addr.toLowerCase().includes('pine')).length);

  await page.goto('/listings?sort=price-asc');
  const prices = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  const nums = prices.map((p) => Number(p.replace(/[^0-9]/g, '')));
  expect(nums, 'price-asc is sorted').toEqual([...nums].sort((a, b) => a - b));

  await page.goto('/listings?sort=price-desc');
  const d = (await page.locator('tbody tr td:nth-child(3)').allTextContents()).map((p) => Number(p.replace(/[^0-9]/g, '')));
  expect(d, 'price-desc is sorted').toEqual([...d].sort((a, b) => b - a));
});

test('2h. junk filter values do not break the page', async ({ page }) => {
  for (const qs of ['minPrice=abc', 'minBeds=-5', 'status=NOT_A_STATUS', 'type=<script>alert(1)</script>', 'sort=bogus', 'minPrice=1e999']) {
    const c = collect(page);
    const resp = await page.goto(`/listings?${qs}`);
    expect(resp?.status(), qs).toBeLessThan(500);
    expect(c.pageErrors, qs).toEqual([]);
    await expect(page.locator('h1')).toHaveText('Listings');
  }
});

// ------------------------------------------------------------------ 5. export

test('5. Excel export matches the on-screen filters', async ({ page }) => {
  const qs = 'minPrice=600000&status=ACTIVE';
  await page.goto(`/listings?${qs}`);
  const onScreen = await rowCount(page);

  const href = await page.locator('a', { hasText: 'Export to Excel' }).getAttribute('href');
  expect(href, 'export link carries the filters').toContain('minPrice=600000');
  expect(href).toContain('status=ACTIVE');

  const resp = await page.request.get(href!);
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toBe(
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(resp.headers()['content-disposition']).toContain('.xlsx');

  const buf = await resp.body();
  fs.writeFileSync(`${ARTIFACTS}/audit-export.xlsx`, buf);
  expect(buf.length).toBeGreaterThan(1000);
  expect(buf.subarray(0, 2).toString('latin1'), 'is a real zip/xlsx').toBe('PK');

  // Count rows in the workbook's Listings sheet.
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.worksheets.find((w) => /listing/i.test(w.name)) ?? wb.worksheets[0];
  let dataRows = 0;
  sheet.eachRow({ includeEmpty: false }, (_r, n) => { if (n > 1) dataRows++; });
  const names = wb.worksheets.map((w) => w.name);

  if (dataRows !== onScreen) {
    bug('EXPORT-count', 'HIGH', 'Exported workbook row count differs from the screen',
      `/listings?${qs} shows ${onScreen} rows; the workbook's "${sheet.name}" sheet has ${dataRows} data rows. Sheets: ${names.join(', ')}`);
  }
  expect(dataRows, `export rows vs screen rows (sheets: ${names.join(', ')})`).toBe(onScreen);
});

test('5b. export honours a zero-result filter', async ({ page }) => {
  const resp = await page.request.get('/api/export/xlsx?minPrice=99000000&maxPrice=99000001');
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('spreadsheetml');
});

// -------------------------------------------------------------------- 6. poll

test('6. "Run poll now" refreshes the page and reports what happened', async ({ page }) => {
  await page.goto('/');
  const before = await rowCount(page, 0);
  const btn = page.locator('button', { hasText: 'Run poll now' });
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.getByText(/Saw \d+ listings/)).toBeVisible({ timeout: 30_000 });
  const msg = await page.getByText(/Saw \d+ listings/).textContent();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${ARTIFACTS}/audit-poll.png`, fullPage: true });
  expect(msg).toMatch(/Saw \d+ listings, \d+ update\(s\)/);
  expect(await rowCount(page, 0)).toBeGreaterThanOrEqual(Math.min(before, 1));
});

// ------------------------------------------------------------- 7. empty states

test('7. a zero-result filter shows an empty state, not a broken table', async ({ page }) => {
  await page.goto('/listings?minPrice=99000000');
  expect(await page.locator('table').count(), 'no table is rendered').toBe(0);
  await expect(page.getByText('No listings match')).toBeVisible();
  const sub = (await page.locator('h1 + p').textContent()) ?? '';
  expect(sub).toContain('0 matches');
  await page.screenshot({ path: `${ARTIFACTS}/audit-empty.png`, fullPage: true });

  // the search box with a nonsense term
  await page.goto('/listings?q=zzzzznotanaddress');
  await expect(page.getByText('No listings match')).toBeVisible();
});

// --------------------------------------------------------------- 8. responsive

for (const width of [375, 768, 1440]) {
  test(`8. no horizontal page scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const id = await firstListingId();
    const targets = [...PAGES, { path: `/listings/${id}`, name: 'detail' }];
    for (const p of targets) {
      await page.goto(p.path, { waitUntil: 'networkidle' });
      const o = await horizontalOverflow(page);
      await page.screenshot({ path: `${ARTIFACTS}/audit-${width}-${p.name}.png`, fullPage: true });
      if (o.overflows) {
        bug(`RESPONSIVE-${width}-${p.name}`, 'HIGH', `page scrolls horizontally at ${width}px on ${p.path}`,
          `documentElement.scrollWidth=${o.scrollWidth} vs clientWidth=${o.clientWidth}. Offenders: ` +
          JSON.stringify(o.offenders));
      }
      expect(o.overflows, `${p.path} @${width}px (offenders: ${JSON.stringify(o.offenders)})`).toBe(false);
    }
  });
}

test('8b. the detail page main column is still readable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  const id = await firstListingId();
  await page.goto(`/listings/${id}`);
  const box = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    const grid = aside?.parentElement as HTMLElement | null;
    const main = grid?.firstElementChild as HTMLElement | null;
    return {
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
      mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
      asideWidth: aside ? Math.round(aside.getBoundingClientRect().width) : null,
      priceWidth: main ? Math.round((main.querySelector('section span') as HTMLElement)?.getBoundingClientRect().width ?? 0) : null,
    };
  });
  await page.screenshot({ path: `${ARTIFACTS}/audit-375-detail-columns.png`, fullPage: true });
  if (box.mainWidth != null && box.mainWidth < 200) {
    bug('RESPONSIVE-detail-columns', 'HIGH', 'Listing detail keeps a two-column layout on phones; the main column collapses',
      `At a 375px viewport the detail page grid is still "${box.cols}" (minmax(0,2fr) minmax(260px,1fr) with no media ` +
      `query). The sidebar holds its 260px minimum, so the PRIMARY column — price, beds/baths, description, price ` +
      `history, activity — is squeezed to ${box.mainWidth}px. Every table and the price headline wrap to one or two ` +
      `characters per line. Repro: open any /listings/<id> at 375x900.`);
  }
  expect(box.mainWidth, `main column width at 375px (cols=${box.cols}, aside=${box.asideWidth})`).toBeGreaterThan(200);
});

test('8c. wide tables scroll inside their own container', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/listings');
  const scrolls = await page.evaluate(() => {
    const el = document.querySelector('.table-scroll') as HTMLElement | null;
    if (!el) return null;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX };
  });
  expect(scrolls?.overflowX).toBe('auto');
  expect(scrolls!.scrollWidth).toBeGreaterThan(scrolls!.clientWidth);
});

// ---------------------------------------------------------------- 9. dark mode

test('9. dark mode has no unreadable text', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const page: Page = await ctx.newPage();
  const bad: string[] = [];
  const id = await firstListingId();

  // make sure there's an unseen-count badge to inspect
  const targets = [...PAGES, { path: `/listings/${id}`, name: 'detail' }];
  for (const p of targets) {
    await page.goto(p.path, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${ARTIFACTS}/audit-dark-${p.name}.png`, fullPage: true });
    const report = await textContrastReport(page);
    for (const r of report) {
      const large = r.size >= 18.66;
      const min = large ? 3 : 4.5;
      if (r.ratio < min) bad.push(`${p.path} | "${r.text}" | ${r.fg} on ${r.bg} | ${r.ratio}:1 (need ${min})`);
    }
  }
  fs.writeFileSync(`${ARTIFACTS}/audit-dark-contrast.json`, JSON.stringify(bad, null, 2));
  if (bad.length) {
    bug('DARK-contrast', 'MEDIUM', 'Low-contrast text in dark mode',
      bad.slice(0, 15).join('\n'));
  }
  await ctx.close();
  expect(bad, 'dark-mode contrast failures').toEqual([]);
});

// --------------------------------------------------------------- 10. a11y

test('10. accessibility basics', async ({ page }) => {
  const id = await firstListingId();
  const problems: string[] = [];

  // (a) favorite button accessible name
  await page.goto('/listings');
  const star = page.locator('tbody tr').first().locator('button').first();
  const label = await star.getAttribute('aria-label');
  if (!label) problems.push('favorite button has no accessible name');

  // (b) every form control is labelled
  for (const path of ['/listings', `/listings/${id}`]) {
    await page.goto(path);
    const unlabelled = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('input, select, textarea').forEach((el) => {
        const e = el as HTMLInputElement;
        const has =
          e.labels?.length ||
          e.getAttribute('aria-label') ||
          e.getAttribute('aria-labelledby') ||
          (e.id && document.querySelector(`label[for="${e.id}"]`));
        if (!has) out.push(`${e.tagName.toLowerCase()}[name=${e.name || '?'}] type=${e.type ?? ''}`);
      });
      return out;
    });
    if (unlabelled.length) problems.push(`${path}: unlabelled controls -> ${unlabelled.join(', ')}`);
  }

  // (c) heading order
  for (const p of PAGES) {
    await page.goto(p.path);
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1])));
    const h1s = levels.filter((l) => l === 1).length;
    if (h1s !== 1) problems.push(`${p.path}: ${h1s} <h1> elements`);
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] - levels[i - 1] > 1) problems.push(`${p.path}: heading jumps h${levels[i - 1]} -> h${levels[i]}`);
    }
  }

  // (d) invalid nesting: interactive inside interactive
  await page.goto('/listings');
  const nested = await page.evaluate(() =>
    [...document.querySelectorAll('a button, button a')].map((el) => {
      const p = el.parentElement;
      return `${p?.tagName.toLowerCase()} > ${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
    }));
  if (nested.length) {
    bug('A11Y-nested-interactive', 'LOW', 'A <button> is nested inside an <a>',
      `/listings renders ${nested.join('; ')}. Invalid HTML (interactive-in-interactive); screen readers announce ` +
      `a link and a button for the same target, and the button is not keyboard-focusable as a separate control.`);
  }

  if (problems.length) {
    bug('A11Y-basics', 'MEDIUM', 'Accessibility problems', problems.join('\n'));
  }
  expect(problems).toEqual([]);
});

test('10b. the export button is a real link and the poll button is reachable by keyboard', async ({ page }) => {
  await page.goto('/listings');
  await page.keyboard.press('Tab');
  const focusChain: string[] = [];
  for (let i = 0; i < 12; i++) {
    focusChain.push(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? `${a.tagName.toLowerCase()}:${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 20)}` : 'none';
    }));
    await page.keyboard.press('Tab');
  }
  expect(focusChain.join(' | ')).toBeTruthy();
});

test('5c. the /saved export silently drops delisted favorites that the page shows', async ({ page }) => {
  const { prisma } = await import('../../src/lib/db/client');
  await clearSavedListings();
  const removed = await prisma.listing.findFirst({ where: { removedAt: { not: null } } });
  const live = await prisma.listing.findFirst({ where: { removedAt: null } });
  test.skip(!removed || !live, 'needs at least one delisted listing in the DB');
  for (const l of [removed!, live!]) {
    await prisma.savedListing.create({ data: { listingId: l.id, addressKey: l.addressKey, favorite: true } });
  }

  await page.goto('/saved');
  const onScreen = await rowCount(page);
  const subtitle = (await page.locator('h1 + p').textContent()) ?? '';
  const href = await page.locator('a', { hasText: 'Export favorites' }).getAttribute('href');
  const resp = await page.request.get(href!);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await resp.body()) as unknown as ArrayBuffer);
  const sheet = wb.worksheets.find((w) => /listing/i.test(w.name))!;
  let n = 0;
  sheet.eachRow({ includeEmpty: false }, (_r, i) => { if (i > 1) n++; });
  await page.screenshot({ path: `${ARTIFACTS}/audit-saved-delisted.png`, fullPage: true });
  await clearSavedListings();

  if (n !== onScreen) {
    bug('EXPORT-saved-drops-delisted', 'MEDIUM', '"Export favorites to Excel" omits delisted favorites the page is showing',
      `Repro: favorite one live listing and one listing whose removedAt is set (any home that has since left the market — ` +
      `"${removed!.addressLine1}" here). /saved says "${subtitle.trim()}" and renders ${onScreen} rows, one greyed out and ` +
      `badged "Delisted". Click "Export favorites to Excel" (/api/export/xlsx?favorites=1) and the workbook contains only ` +
      `${n} listing row. Cause: the page calls findListings({favoritesOnly, includeRemoved:true}) but the export route ` +
      `rebuilds filters from the query string with parseFilters(), which never sets includeRemoved, so buildWhere() adds ` +
      `removedAt:null. The export claims to be "what you're looking at" and is not; there is no warning.`);
  }
  expect(n, 'export rows == page rows').toBe(onScreen);
});
