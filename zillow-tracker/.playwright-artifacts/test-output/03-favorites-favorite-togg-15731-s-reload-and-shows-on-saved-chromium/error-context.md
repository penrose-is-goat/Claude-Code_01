# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 03-favorites.spec.ts >> favorite toggle >> star persists across reload and shows on /saved
- Location: tests/e2e/03-favorites.spec.ts:11:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.textContent: Test timeout of 60000ms exceeded.
Call log:
  - waiting for locator('tbody tr').first().locator('a[href^="/listings/"]').first()

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - 'heading "Application error: a server-side exception has occurred while loading localhost (see the server logs for more information)." [level=2] [ref=e4]'
  - paragraph [ref=e5]: "Digest: 437234774"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { ARTIFACTS, rowCount, clearSavedListings } from './helpers';
  3  | 
  4  | async function firstRowAddress(page: import('@playwright/test').Page) {
> 5  |   return (await page.locator('tbody tr').first().locator('a[href^="/listings/"]').first().textContent())!.trim();
     |                                                                                           ^ Error: locator.textContent: Test timeout of 60000ms exceeded.
  6  | }
  7  | 
  8  | test.describe.serial('favorite toggle', () => {
  9  |   test.beforeAll(async () => { await clearSavedListings(); });
  10 | 
  11 |   test('star persists across reload and shows on /saved', async ({ page }) => {
  12 |     await page.goto('/listings?sort=price-asc');
  13 |     const addr = await firstRowAddress(page);
  14 |     const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  15 | 
  16 |     await expect(star).toHaveAttribute('aria-pressed', 'false');
  17 |     await star.click();
  18 |     await expect(star).toHaveAttribute('aria-pressed', 'true');
  19 |     await page.waitForTimeout(800);
  20 | 
  21 |     await page.reload();
  22 |     const starAfter = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  23 |     await expect(starAfter, 'favorite should persist after reload').toHaveAttribute('aria-pressed', 'true');
  24 |     await page.screenshot({ path: `${ARTIFACTS}/favorite-on.png`, fullPage: true });
  25 | 
  26 |     await page.goto('/saved');
  27 |     await expect(page.getByRole('link', { name: addr })).toBeVisible();
  28 |     expect(await rowCount(page)).toBe(1);
  29 |     await page.screenshot({ path: `${ARTIFACTS}/desktop-saved-with-item.png`, fullPage: true });
  30 |   });
  31 | 
  32 |   test('favorites-only filter reflects the star', async ({ page }) => {
  33 |     await page.goto('/listings?favorites=1');
  34 |     expect(await rowCount(page)).toBe(1);
  35 |   });
  36 | 
  37 |   test('unfavorite removes it from /saved', async ({ page }) => {
  38 |     await page.goto('/saved');
  39 |     const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  40 |     await star.click();
  41 |     await page.waitForTimeout(900);
  42 |     await page.reload();
  43 |     await expect(page.getByText('Nothing saved yet')).toBeVisible();
  44 |     await page.screenshot({ path: `${ARTIFACTS}/saved-empty-state.png`, fullPage: true });
  45 |   });
  46 | 
  47 |   test('optimistic toggle reverts when the request fails', async ({ page }) => {
  48 |     await page.goto('/listings?sort=price-asc');
  49 |     // Redirect the favorite POST to a listing id that does not exist -> API returns 404.
  50 |     await page.route('**/api/listings/*/favorite', (route) =>
  51 |       route.continue({ url: new URL('/api/listings/bogus-listing-id/favorite', page.url()).toString() }),
  52 |     );
  53 |     const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  54 |     await expect(star).toHaveAttribute('aria-pressed', 'false');
  55 |     await star.click();
  56 |     // optimistic flip
  57 |     await expect(star).toHaveAttribute('aria-pressed', 'true');
  58 |     // must revert once the 404 lands
  59 |     await expect(star, 'optimistic star should revert on a failed POST').toHaveAttribute('aria-pressed', 'false', {
  60 |       timeout: 5000,
  61 |     });
  62 |     await page.screenshot({ path: `${ARTIFACTS}/favorite-failure-revert.png`, fullPage: true });
  63 |   });
  64 | 
  65 |   test('a failed favorite tells the user something went wrong', async ({ page }) => {
  66 |     await page.goto('/listings?sort=price-asc');
  67 |     await page.route('**/api/listings/*/favorite', (route) => route.fulfill({ status: 500, body: '{"ok":false}' }));
  68 |     const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
  69 |     await star.click();
  70 |     await page.waitForTimeout(1500);
  71 |     // innerText, not textContent: textContent picks up the RSC payload and gives false positives.
  72 |     const visible = await page.evaluate(() => document.body.innerText);
  73 |     await page.screenshot({ path: `${ARTIFACTS}/BUG-favorite-silent-failure.png`, fullPage: true });
  74 |     expect(visible, 'a failed favorite should surface an error message to the user').toMatch(
  75 |       /fail|error|could not|try again/i,
  76 |     );
  77 |   });
  78 | 
  79 |   test('POST to a bogus listing id returns 404 and does not create a row', async ({ request }) => {
  80 |     const res = await request.post('/api/listings/bogus-listing-id/favorite');
  81 |     expect(res.status()).toBe(404);
  82 |     const json = await res.json();
  83 |     expect(json.ok).toBe(false);
  84 |   });
  85 | });
  86 | 
```