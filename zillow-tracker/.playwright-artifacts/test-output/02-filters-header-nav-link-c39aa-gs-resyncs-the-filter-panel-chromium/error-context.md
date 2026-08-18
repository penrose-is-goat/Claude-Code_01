# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-filters.spec.ts >> header nav link back to /listings resyncs the filter panel
- Location: tests/e2e/02-filters.spec.ts:160:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('link', { name: 'Listings', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - 'heading "Application error: a server-side exception has occurred while loading localhost (see the server logs for more information)." [level=2] [ref=e4]'
  - paragraph [ref=e5]: "Digest: 437234774"
```

# Test source

```ts
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
  149 | 
  150 |   await page.goBack();
  151 |   await page.waitForLoadState('networkidle');
  152 |   expect(new URL(page.url()).search).toBe('');
  153 |   const state = await formState(page);
  154 |   expect(state, 'going Back to the unfiltered URL should also clear the controls').toMatchObject({
  155 |     status: '',
  156 |     openHouse: false,
  157 |   });
  158 | });
  159 | 
  160 | test('header nav link back to /listings resyncs the filter panel', async ({ page }) => {
  161 |   await page.goto('/listings?status=SOLD&favorites=1');
> 162 |   await page.getByRole('link', { name: 'Listings', exact: true }).click();
      |                                                                   ^ Error: locator.click: Test timeout of 60000ms exceeded.
  163 |   await page.waitForLoadState('networkidle');
  164 |   const state = await formState(page);
  165 |   expect(state, 'navigating to unfiltered /listings should clear the controls').toMatchObject({
  166 |     status: '',
  167 |     favorites: false,
  168 |   });
  169 | });
  170 | 
  171 | test('area filter is reflected in the subtitle', async ({ page }) => {
  172 |   await page.goto('/listings');
  173 |   const areaSelect = page.locator('select[name="areaId"]');
  174 |   if ((await areaSelect.count()) === 0) test.skip();
  175 |   const options = await areaSelect.locator('option').all();
  176 |   const value = await options[1].getAttribute('value');
  177 |   const label = (await options[1].textContent())!.trim();
  178 |   await page.goto(`/listings?areaId=${value}`);
  179 |   const sub = await subtitle(page);
  180 |   await page.screenshot({ path: `${ARTIFACTS}/filter-area-subtitle.png`, fullPage: true });
  181 |   expect(sub, `subtitle should say the area "${label}" was applied`).toContain(label);
  182 | });
  183 | 
  184 | test('search box filters and is case-insensitive like a user expects', async ({ page }) => {
  185 |   await page.goto('/listings?q=Pine');
  186 |   const hits = await rowCount(page);
  187 |   expect(hits).toBeGreaterThan(0);
  188 | 
  189 |   await page.goto('/listings?q=pine');
  190 |   const lower = await rowCount(page);
  191 |   await page.screenshot({ path: `${ARTIFACTS}/filter-search-lowercase.png`, fullPage: true });
  192 |   expect(lower, 'lowercase search should match the same rows as capitalised search').toBe(hits);
  193 | });
  194 | 
  195 | test('empty state for a zero-result filter combination', async ({ page }) => {
  196 |   await page.goto('/listings?minPrice=9000000');
  197 |   expect(await rowCount(page)).toBe(0);
  198 |   await expect(page.locator('table')).toHaveCount(0);
  199 |   await expect(page.getByText('No listings match')).toBeVisible();
  200 |   expect(await subtitle(page)).toContain('0 matches');
  201 |   await page.screenshot({ path: `${ARTIFACTS}/empty-state-listings.png`, fullPage: true });
  202 | });
  203 | 
  204 | test('empty state for status=SOLD and type=LAND', async ({ page }) => {
  205 |   for (const qs of ['type=LAND', 'minBeds=99', 'minPrice=99000000']) {
  206 |     await page.goto(`/listings?${qs}`);
  207 |     expect(await rowCount(page), qs).toBe(0);
  208 |     await expect(page.getByText('No listings match'), qs).toBeVisible();
  209 |   }
  210 | });
  211 | 
  212 | test('nonsense filter values do not break the page', async ({ page }) => {
  213 |   for (const qs of ['minPrice=abc', 'minPrice=-5', 'status=BOGUS', 'sort=nonsense', 'minBeds=1e999']) {
  214 |     const res = await page.goto(`/listings?${qs}`);
  215 |     expect(res?.status(), qs).toBeLessThan(500);
  216 |     await expect(page.locator('h1'), qs).toBeVisible();
  217 |   }
  218 | });
  219 | 
```