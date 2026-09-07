import { test, expect } from '@playwright/test';
import { ARTIFACTS, rowCount, clearSavedListings } from './helpers';

async function firstRowAddress(page: import('@playwright/test').Page) {
  return (await page.locator('tbody tr').first().locator('a[href^="/listings/"]').first().textContent())!.trim();
}

test.describe.serial('favorite toggle', () => {
  test.beforeAll(async () => { await clearSavedListings(); });

  test('star persists across reload and shows on /saved', async ({ page }) => {
    await page.goto('/listings?sort=price-asc');
    const addr = await firstRowAddress(page);
    const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });

    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(800);

    await page.reload();
    const starAfter = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
    await expect(starAfter, 'favorite should persist after reload').toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: `${ARTIFACTS}/favorite-on.png`, fullPage: true });

    await page.goto('/saved');
    await expect(page.getByRole('link', { name: addr })).toBeVisible();
    expect(await rowCount(page)).toBe(1);
    await page.screenshot({ path: `${ARTIFACTS}/desktop-saved-with-item.png`, fullPage: true });
  });

  test('favorites-only filter reflects the star', async ({ page }) => {
    await page.goto('/listings?favorites=1');
    expect(await rowCount(page)).toBe(1);
  });

  test('unfavorite removes it from /saved', async ({ page }) => {
    await page.goto('/saved');
    const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
    await star.click();
    await page.waitForTimeout(900);
    await page.reload();
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS}/saved-empty-state.png`, fullPage: true });
  });

  test('optimistic toggle reverts when the request fails', async ({ page }) => {
    await page.goto('/listings?sort=price-asc');
    // Redirect the favorite POST to a listing id that does not exist -> API returns 404.
    await page.route('**/api/listings/*/favorite', (route) =>
      route.continue({ url: new URL('/api/listings/bogus-listing-id/favorite', page.url()).toString() }),
    );
    const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    // optimistic flip
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    // must revert once the 404 lands
    await expect(star, 'optimistic star should revert on a failed POST').toHaveAttribute('aria-pressed', 'false', {
      timeout: 5000,
    });
    await page.screenshot({ path: `${ARTIFACTS}/favorite-failure-revert.png`, fullPage: true });
  });

  test('a failed favorite tells the user something went wrong', async ({ page }) => {
    await page.goto('/listings?sort=price-asc');
    await page.route('**/api/listings/*/favorite', (route) => route.fulfill({ status: 500, body: '{"ok":false}' }));
    const star = page.locator('tbody tr').first().getByRole('button', { name: /favorites/i });
    await star.click();
    await page.waitForTimeout(1500);
    // innerText, not textContent: textContent picks up the RSC payload and gives false positives.
    const visible = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: `${ARTIFACTS}/BUG-favorite-silent-failure.png`, fullPage: true });
    expect(visible, 'a failed favorite should surface an error message to the user').toMatch(
      /fail|error|could not|try again/i,
    );
  });

  test('POST to a bogus listing id returns 404 and does not create a row', async ({ request }) => {
    const res = await request.post('/api/listings/bogus-listing-id/favorite');
    expect(res.status()).toBe(404);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
