import { test, expect, type Page } from '@playwright/test';
import { ARTIFACTS, rowCount, loadListings, type Row } from './helpers';

let DATA: Row[] = [];
test.beforeAll(async () => {
  DATA = await loadListings();
  expect(DATA.length, 'demo DB should hold listings — run `npx tsx scripts/poll.ts`').toBeGreaterThan(0);
});


function expected(f: Partial<{ minPrice: number; maxPrice: number; minBeds: number; minBaths: number; status: string; type: string }>) {
  return DATA.filter(
    (d) =>
      (f.minPrice == null || (d.price != null && d.price >= f.minPrice)) &&
      (f.maxPrice == null || (d.price != null && d.price <= f.maxPrice)) &&
      (f.minBeds == null || (d.beds != null && d.beds >= f.minBeds)) &&
      (f.minBaths == null || (d.baths != null && d.baths >= f.minBaths)) &&
      (f.status == null || d.status === f.status) &&
      (f.type == null || d.type === f.type),
  ).length;
}

async function subtitle(page: Page) {
  return (await page.locator('h1 + p').first().textContent())?.trim() ?? '';
}

test('baseline: all listings shown', async ({ page }) => {
  await page.goto('/listings');
  expect(await rowCount(page)).toBe(DATA.length);
  expect(await subtitle(page)).toBe(`${DATA.length} match${DATA.length === 1 ? '' : 'es'}`);
});

const CASES: { name: string; qs: string; f: Parameters<typeof expected>[0]; subtitleContains: string[] }[] = [
  { name: 'min price', qs: 'minPrice=700000', f: { minPrice: 700000 }, subtitleContains: ['min $700,000'] },
  { name: 'max price', qs: 'maxPrice=600000', f: { maxPrice: 600000 }, subtitleContains: ['max $600,000'] },
  { name: 'price band', qs: 'minPrice=500000&maxPrice=1000000', f: { minPrice: 500000, maxPrice: 1000000 }, subtitleContains: ['min $500,000', 'max $1,000,000'] },
  { name: 'min beds', qs: 'minBeds=4', f: { minBeds: 4 }, subtitleContains: ['4+ beds'] },
  { name: 'min baths', qs: 'minBaths=2.5', f: { minBaths: 2.5 }, subtitleContains: ['2.5+ baths'] },
  { name: 'status pending', qs: 'status=PENDING', f: { status: 'PENDING' }, subtitleContains: ['status Pending'] },
  { name: 'type condo', qs: 'type=CONDO', f: { type: 'CONDO' }, subtitleContains: ['type Condo'] },
  { name: 'type + beds', qs: 'type=CONDO&minBeds=2', f: { type: 'CONDO', minBeds: 2 }, subtitleContains: ['2+ beds', 'type Condo'] },
];

for (const c of CASES) {
  test(`filter via URL: ${c.name}`, async ({ page }) => {
    await page.goto(`/listings?${c.qs}`);
    const want = expected(c.f);
    expect(await rowCount(page), `${c.qs} row count`).toBe(want);
    const sub = await subtitle(page);
    expect(sub).toContain(`${want} match`);
    for (const frag of c.subtitleContains) expect(sub, `subtitle should mention ${frag}`).toContain(frag);
  });
}

test('filter via the form UI, URL round-trips on reload', async ({ page }) => {
  await page.goto('/listings');
  await page.fill('input[name="minPrice"]', '700000');
  await page.selectOption('select[name="type"]', 'SINGLE_FAMILY');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  const want = expected({ minPrice: 700000, type: 'SINGLE_FAMILY' });
  expect(await rowCount(page)).toBe(want);

  const url = new URL(page.url());
  expect(url.searchParams.get('minPrice')).toBe('700000');
  expect(url.searchParams.get('type')).toBe('SINGLE_FAMILY');

  // reload: form fields must be repopulated from the URL and counts identical
  await page.reload();
  expect(await rowCount(page)).toBe(want);
  await expect(page.locator('input[name="minPrice"]')).toHaveValue('700000');
  await expect(page.locator('select[name="type"]')).toHaveValue('SINGLE_FAMILY');
  await page.screenshot({ path: `${ARTIFACTS}/filters-applied.png`, fullPage: true });
});

test('checkbox filters round-trip (open house, favorites)', async ({ page }) => {
  await page.goto('/listings');
  await page.check('input[name="openHouse"]');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');
  expect(new URL(page.url()).searchParams.get('openHouse')).toBe('1');
  await page.reload();
  await expect(page.locator('input[name="openHouse"]')).toBeChecked();
  expect(await subtitle(page)).toContain('has upcoming open house');
});

test('sort round-trips and actually reorders', async ({ page }) => {
  await page.goto('/listings?sort=price-asc');
  const asc = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  await page.goto('/listings?sort=price-desc');
  const desc = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  expect(asc[0]).not.toBe(desc[0]);
  const nums = asc.map((s) => Number(s.replace(/[^0-9]/g, '')));
  expect([...nums].sort((a, b) => a - b)).toEqual(nums);
});

async function formState(page: Page) {
  return page.evaluate(() => {
    const f = document.querySelector('form')!;
    const out: Record<string, unknown> = {};
    f.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((e) => {
      out[e.name] = (e as HTMLInputElement).type === 'checkbox' ? (e as HTMLInputElement).checked : e.value;
    });
    return out;
  });
}

test('Reset clears every filter control, not just the URL', async ({ page }) => {
  await page.goto('/listings?minPrice=700000&status=PENDING&sort=price-asc&openHouse=1&favorites=1');
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForLoadState('networkidle');

  expect(new URL(page.url()).pathname).toBe('/listings');
  expect(new URL(page.url()).search).toBe('');
  expect(await rowCount(page)).toBe(DATA.length);

  const state = await formState(page);
  await page.screenshot({ path: `${ARTIFACTS}/BUG-reset-form-desync.png`, fullPage: true });
  expect(state, 'after Reset the filter panel must not still show the old filters').toMatchObject({
    minPrice: '',
    status: '',
    sort: 'newest',
    openHouse: false,
    favorites: false,
  });
});

test('pressing Apply straight after Reset does not re-apply the cleared filters', async ({ page }) => {
  await page.goto('/listings?status=PENDING&openHouse=1&favorites=1');
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForLoadState('networkidle');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  const url = new URL(page.url());
  expect(url.searchParams.get('status') || '', 'status should be gone after Reset+Apply').toBe('');
  expect(url.searchParams.get('openHouse') || '').toBe('');
  expect(url.searchParams.get('favorites') || '').toBe('');
  expect(await rowCount(page)).toBe(DATA.length);
});

test('client-side navigation resyncs the filter panel (Back button)', async ({ page }) => {
  await page.goto('/listings');
  await page.selectOption('select[name="status"]', 'PENDING');
  await page.check('input[name="openHouse"]');
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  await page.goBack();
  await page.waitForLoadState('networkidle');
  expect(new URL(page.url()).search).toBe('');
  const state = await formState(page);
  expect(state, 'going Back to the unfiltered URL should also clear the controls').toMatchObject({
    status: '',
    openHouse: false,
  });
});

test('header nav link back to /listings resyncs the filter panel', async ({ page }) => {
  await page.goto('/listings?status=SOLD&favorites=1');
  await page.getByRole('link', { name: 'Listings', exact: true }).click();
  await page.waitForLoadState('networkidle');
  const state = await formState(page);
  expect(state, 'navigating to unfiltered /listings should clear the controls').toMatchObject({
    status: '',
    favorites: false,
  });
});

test('area filter is reflected in the subtitle', async ({ page }) => {
  await page.goto('/listings');
  const areaSelect = page.locator('select[name="areaId"]');
  if ((await areaSelect.count()) === 0) test.skip();
  const options = await areaSelect.locator('option').all();
  const value = await options[1].getAttribute('value');
  const label = (await options[1].textContent())!.trim();
  await page.goto(`/listings?areaId=${value}`);
  const sub = await subtitle(page);
  await page.screenshot({ path: `${ARTIFACTS}/filter-area-subtitle.png`, fullPage: true });
  expect(sub, `subtitle should say the area "${label}" was applied`).toContain(label);
});

test('search box filters and is case-insensitive like a user expects', async ({ page }) => {
  await page.goto('/listings?q=Pine');
  const hits = await rowCount(page);
  expect(hits).toBeGreaterThan(0);

  await page.goto('/listings?q=pine');
  const lower = await rowCount(page);
  await page.screenshot({ path: `${ARTIFACTS}/filter-search-lowercase.png`, fullPage: true });
  expect(lower, 'lowercase search should match the same rows as capitalised search').toBe(hits);
});

test('empty state for a zero-result filter combination', async ({ page }) => {
  await page.goto('/listings?minPrice=9000000');
  expect(await rowCount(page)).toBe(0);
  await expect(page.locator('table')).toHaveCount(0);
  await expect(page.getByText('No listings match')).toBeVisible();
  expect(await subtitle(page)).toContain('0 matches');
  await page.screenshot({ path: `${ARTIFACTS}/empty-state-listings.png`, fullPage: true });
});

test('empty state for status=SOLD and type=LAND', async ({ page }) => {
  for (const qs of ['type=LAND', 'minBeds=99', 'minPrice=99000000']) {
    await page.goto(`/listings?${qs}`);
    expect(await rowCount(page), qs).toBe(0);
    await expect(page.getByText('No listings match'), qs).toBeVisible();
  }
});

test('nonsense filter values do not break the page', async ({ page }) => {
  for (const qs of ['minPrice=abc', 'minPrice=-5', 'status=BOGUS', 'sort=nonsense', 'minBeds=1e999']) {
    const res = await page.goto(`/listings?${qs}`);
    expect(res?.status(), qs).toBeLessThan(500);
    await expect(page.locator('h1'), qs).toBeVisible();
  }
});
