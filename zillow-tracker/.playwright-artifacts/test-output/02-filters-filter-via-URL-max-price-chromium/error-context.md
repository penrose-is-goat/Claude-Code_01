# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-filters.spec.ts >> filter via URL: max price
- Location: tests/e2e/02-filters.spec.ts:45:3

# Error details

```
Error: maxPrice=600000 row count

expect(received).toBe(expected) // Object.is equality

Expected: 2
Received: 0
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - 'heading "Application error: a server-side exception has occurred while loading localhost (see the server logs for more information)." [level=2] [ref=e4]'
  - paragraph [ref=e5]: "Digest: 437234774"
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import { ARTIFACTS, rowCount, loadListings, type Row } from './helpers';
  3   | 
  4   | let DATA: Row[] = [];
  5   | test.beforeAll(async () => {
  6   |   DATA = await loadListings();
  7   |   expect(DATA.length, 'demo DB should hold listings — run `npx tsx scripts/poll.ts`').toBeGreaterThan(0);
  8   | });
  9   | 
  10  | 
  11  | function expected(f: Partial<{ minPrice: number; maxPrice: number; minBeds: number; minBaths: number; status: string; type: string }>) {
  12  |   return DATA.filter(
  13  |     (d) =>
  14  |       (f.minPrice == null || (d.price != null && d.price >= f.minPrice)) &&
  15  |       (f.maxPrice == null || (d.price != null && d.price <= f.maxPrice)) &&
  16  |       (f.minBeds == null || (d.beds != null && d.beds >= f.minBeds)) &&
  17  |       (f.minBaths == null || (d.baths != null && d.baths >= f.minBaths)) &&
  18  |       (f.status == null || d.status === f.status) &&
  19  |       (f.type == null || d.type === f.type),
  20  |   ).length;
  21  | }
  22  | 
  23  | async function subtitle(page: Page) {
  24  |   return (await page.locator('h1 + p').first().textContent())?.trim() ?? '';
  25  | }
  26  | 
  27  | test('baseline: all listings shown', async ({ page }) => {
  28  |   await page.goto('/listings');
  29  |   expect(await rowCount(page)).toBe(DATA.length);
  30  |   expect(await subtitle(page)).toBe(`${DATA.length} match${DATA.length === 1 ? '' : 'es'}`);
  31  | });
  32  | 
  33  | const CASES: { name: string; qs: string; f: Parameters<typeof expected>[0]; subtitleContains: string[] }[] = [
  34  |   { name: 'min price', qs: 'minPrice=700000', f: { minPrice: 700000 }, subtitleContains: ['min $700,000'] },
  35  |   { name: 'max price', qs: 'maxPrice=600000', f: { maxPrice: 600000 }, subtitleContains: ['max $600,000'] },
  36  |   { name: 'price band', qs: 'minPrice=500000&maxPrice=1000000', f: { minPrice: 500000, maxPrice: 1000000 }, subtitleContains: ['min $500,000', 'max $1,000,000'] },
  37  |   { name: 'min beds', qs: 'minBeds=4', f: { minBeds: 4 }, subtitleContains: ['4+ beds'] },
  38  |   { name: 'min baths', qs: 'minBaths=2.5', f: { minBaths: 2.5 }, subtitleContains: ['2.5+ baths'] },
  39  |   { name: 'status pending', qs: 'status=PENDING', f: { status: 'PENDING' }, subtitleContains: ['status Pending'] },
  40  |   { name: 'type condo', qs: 'type=CONDO', f: { type: 'CONDO' }, subtitleContains: ['type Condo'] },
  41  |   { name: 'type + beds', qs: 'type=CONDO&minBeds=2', f: { type: 'CONDO', minBeds: 2 }, subtitleContains: ['2+ beds', 'type Condo'] },
  42  | ];
  43  | 
  44  | for (const c of CASES) {
  45  |   test(`filter via URL: ${c.name}`, async ({ page }) => {
  46  |     await page.goto(`/listings?${c.qs}`);
  47  |     const want = expected(c.f);
> 48  |     expect(await rowCount(page), `${c.qs} row count`).toBe(want);
      |                                                       ^ Error: maxPrice=600000 row count
  49  |     const sub = await subtitle(page);
  50  |     expect(sub).toContain(`${want} match`);
  51  |     for (const frag of c.subtitleContains) expect(sub, `subtitle should mention ${frag}`).toContain(frag);
  52  |   });
  53  | }
  54  | 
  55  | test('filter via the form UI, URL round-trips on reload', async ({ page }) => {
  56  |   await page.goto('/listings');
  57  |   await page.fill('input[name="minPrice"]', '700000');
  58  |   await page.selectOption('select[name="type"]', 'SINGLE_FAMILY');
  59  |   await page.click('button[type="submit"]');
  60  |   await page.waitForLoadState('networkidle');
  61  | 
  62  |   const want = expected({ minPrice: 700000, type: 'SINGLE_FAMILY' });
  63  |   expect(await rowCount(page)).toBe(want);
  64  | 
  65  |   const url = new URL(page.url());
  66  |   expect(url.searchParams.get('minPrice')).toBe('700000');
  67  |   expect(url.searchParams.get('type')).toBe('SINGLE_FAMILY');
  68  | 
  69  |   // reload: form fields must be repopulated from the URL and counts identical
  70  |   await page.reload();
  71  |   expect(await rowCount(page)).toBe(want);
  72  |   await expect(page.locator('input[name="minPrice"]')).toHaveValue('700000');
  73  |   await expect(page.locator('select[name="type"]')).toHaveValue('SINGLE_FAMILY');
  74  |   await page.screenshot({ path: `${ARTIFACTS}/filters-applied.png`, fullPage: true });
  75  | });
  76  | 
  77  | test('checkbox filters round-trip (open house, favorites)', async ({ page }) => {
  78  |   await page.goto('/listings');
  79  |   await page.check('input[name="openHouse"]');
  80  |   await page.click('button[type="submit"]');
  81  |   await page.waitForLoadState('networkidle');
  82  |   expect(new URL(page.url()).searchParams.get('openHouse')).toBe('1');
  83  |   await page.reload();
  84  |   await expect(page.locator('input[name="openHouse"]')).toBeChecked();
  85  |   expect(await subtitle(page)).toContain('has upcoming open house');
  86  | });
  87  | 
  88  | test('sort round-trips and actually reorders', async ({ page }) => {
  89  |   await page.goto('/listings?sort=price-asc');
  90  |   const asc = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  91  |   await page.goto('/listings?sort=price-desc');
  92  |   const desc = await page.locator('tbody tr td:nth-child(3)').allTextContents();
  93  |   expect(asc[0]).not.toBe(desc[0]);
  94  |   const nums = asc.map((s) => Number(s.replace(/[^0-9]/g, '')));
  95  |   expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  96  | });
  97  | 
  98  | async function formState(page: Page) {
  99  |   return page.evaluate(() => {
  100 |     const f = document.querySelector('form')!;
  101 |     const out: Record<string, unknown> = {};
  102 |     f.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((e) => {
  103 |       out[e.name] = (e as HTMLInputElement).type === 'checkbox' ? (e as HTMLInputElement).checked : e.value;
  104 |     });
  105 |     return out;
  106 |   });
  107 | }
  108 | 
  109 | test('Reset clears every filter control, not just the URL', async ({ page }) => {
  110 |   await page.goto('/listings?minPrice=700000&status=PENDING&sort=price-asc&openHouse=1&favorites=1');
  111 |   await page.getByRole('button', { name: 'Reset' }).click();
  112 |   await page.waitForLoadState('networkidle');
  113 | 
  114 |   expect(new URL(page.url()).pathname).toBe('/listings');
  115 |   expect(new URL(page.url()).search).toBe('');
  116 |   expect(await rowCount(page)).toBe(DATA.length);
  117 | 
  118 |   const state = await formState(page);
  119 |   await page.screenshot({ path: `${ARTIFACTS}/BUG-reset-form-desync.png`, fullPage: true });
  120 |   expect(state, 'after Reset the filter panel must not still show the old filters').toMatchObject({
  121 |     minPrice: '',
  122 |     status: '',
  123 |     sort: 'newest',
  124 |     openHouse: false,
  125 |     favorites: false,
  126 |   });
  127 | });
  128 | 
  129 | test('pressing Apply straight after Reset does not re-apply the cleared filters', async ({ page }) => {
  130 |   await page.goto('/listings?status=PENDING&openHouse=1&favorites=1');
  131 |   await page.getByRole('button', { name: 'Reset' }).click();
  132 |   await page.waitForLoadState('networkidle');
  133 |   await page.click('button[type="submit"]');
  134 |   await page.waitForLoadState('networkidle');
  135 | 
  136 |   const url = new URL(page.url());
  137 |   expect(url.searchParams.get('status') || '', 'status should be gone after Reset+Apply').toBe('');
  138 |   expect(url.searchParams.get('openHouse') || '').toBe('');
  139 |   expect(url.searchParams.get('favorites') || '').toBe('');
  140 |   expect(await rowCount(page)).toBe(DATA.length);
  141 | });
  142 | 
  143 | test('client-side navigation resyncs the filter panel (Back button)', async ({ page }) => {
  144 |   await page.goto('/listings');
  145 |   await page.selectOption('select[name="status"]', 'PENDING');
  146 |   await page.check('input[name="openHouse"]');
  147 |   await page.click('button[type="submit"]');
  148 |   await page.waitForLoadState('networkidle');
```