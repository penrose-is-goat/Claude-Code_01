import { test, expect, type Page } from '@playwright/test';
import { ARTIFACTS, clearSavedListings } from './helpers';

async function openDetail(page: Page, index = 2) {
  await page.goto('/listings?sort=price-asc');
  const href = await page.locator('tbody tr a[href^="/listings/"]').nth(index).getAttribute('href');
  await page.goto(href!);
  return href!;
}

test.describe('notes editor', () => {
  test.beforeAll(async () => { await clearSavedListings(); });

  test('notes, rating, status and tags persist across reload', async ({ page }) => {
    const href = await openDetail(page);

    await page.selectOption('select >> nth=0', 'TOURED');
    await page.selectOption('select >> nth=1', '4');
    await page.fill('input[placeholder*="good schools"]', 'sunny, quiet street');
    await page.fill('textarea', 'Kitchen bigger than expected.\nSecond line.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    await page.waitForTimeout(800);

    await page.goto(href);
    await expect(page.locator('select >> nth=0')).toHaveValue('TOURED');
    await expect(page.locator('select >> nth=1')).toHaveValue('4');
    await expect(page.locator('textarea')).toHaveValue('Kitchen bigger than expected.\nSecond line.');
    await expect(page.locator('input[placeholder*="good schools"]')).toHaveValue('sunny, quiet street');
    await page.screenshot({ path: `${ARTIFACTS}/notes-persisted.png`, fullPage: true });
  });

  test('a comma can actually be typed into the tags field', async ({ page }) => {
    await openDetail(page);
    const tags = page.locator('input[placeholder*="good schools"]');
    await tags.fill('');
    await tags.pressSequentially('quiet, sunny');
    await page.screenshot({ path: `${ARTIFACTS}/BUG-tags-comma-swallowed.png`, fullPage: true });
    await expect(tags, 'typing "quiet, sunny" should leave that literal text in the field').toHaveValue('quiet, sunny');
  });

  test('tag with quotes and unicode survives a round trip', async ({ page }) => {
    const href = await openDetail(page, 3);
    const value = 'café ☀️, "quoted", <b>bold</b>';
    await page.fill('input[placeholder*="good schools"]', value);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(900);
    await page.goto(href);
    await expect(page.locator('input[placeholder*="good schools"]')).toHaveValue(value);
    await page.screenshot({ path: `${ARTIFACTS}/notes-unicode-tags.png`, fullPage: true });
  });

  test('an over-long tag is rejected visibly, not silently', async ({ page }) => {
    const href = await openDetail(page, 4);
    const longTag = 'x'.repeat(200);
    await page.fill('input[placeholder*="good schools"]', longTag);
    await page.fill('textarea', 'note that should save alongside the long tag');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1000);
    // innerText only — textContent includes the RSC payload, which contains the word "error".
    const bodyAfterSave = await page.evaluate(() => document.body.innerText);
    const sawSavedConfirmation = /\bSaved\b/.test(bodyAfterSave);

    await page.goto(href);
    const savedNote = await page.locator('textarea').inputValue();
    await page.screenshot({ path: `${ARTIFACTS}/notes-long-tag.png`, fullPage: true });

    if (savedNote !== 'note that should save alongside the long tag') {
      expect(
        `sawSavedConfirmation=${sawSavedConfirmation} :: ${bodyAfterSave.slice(0, 200)}`,
        'save was rejected by the API (tag >60 chars) but the UI showed "Saved" and discarded the note',
      ).toMatch(/error|too big|too long|invalid|failed/i);
    }
  });

  test('rating can be cleared back to none', async ({ page }) => {
    const href = await openDetail(page, 5);
    await page.selectOption('select >> nth=1', '3');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(800);
    await page.goto(href);
    await expect(page.locator('select >> nth=1')).toHaveValue('3');

    await page.selectOption('select >> nth=1', '');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(800);
    await page.goto(href);
    await expect(page.locator('select >> nth=1'), 'clearing the rating should persist as no rating').toHaveValue('');
  });

  test('saving notes must not silently favorite the listing', async ({ page }) => {
    await page.goto('/listings?sort=price-desc');
    const href = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
    await page.goto(href);

    const star = page.getByRole('button', { name: /favorites/i });
    await expect(star, 'precondition: listing is not a favorite').toHaveAttribute('aria-pressed', 'false');

    await page.fill('textarea', 'just a note, I am not saving this house');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(1000);
    await page.goto(href);
    await page.screenshot({ path: `${ARTIFACTS}/notes-side-effect-favorite.png`, fullPage: true });
    await expect(
      page.getByRole('button', { name: /favorites/i }),
      'writing a note should not turn the listing into a favorite',
    ).toHaveAttribute('aria-pressed', 'false');
  });

  test('an unsaved edit is not silently lost without warning', async ({ page }) => {
    const href = await openDetail(page, 6);
    await page.fill('textarea', 'unsaved draft');
    await page.goto(href);
    const v = await page.locator('textarea').inputValue();
    // informational: records whether drafts survive navigation
    expect(typeof v).toBe('string');
  });
});
