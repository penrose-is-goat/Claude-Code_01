# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-notes.spec.ts >> notes editor >> an over-long tag is rejected visibly, not silently
- Location: tests/e2e/04-notes.spec.ts:53:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.getAttribute: Test timeout of 60000ms exceeded.
Call log:
  - waiting for locator('tbody tr a[href^="/listings/"]').nth(4)

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
  2   | import { ARTIFACTS, clearSavedListings } from './helpers';
  3   | 
  4   | async function openDetail(page: Page, index = 2) {
  5   |   await page.goto('/listings?sort=price-asc');
> 6   |   const href = await page.locator('tbody tr a[href^="/listings/"]').nth(index).getAttribute('href');
      |                                                                                ^ Error: locator.getAttribute: Test timeout of 60000ms exceeded.
  7   |   await page.goto(href!);
  8   |   return href!;
  9   | }
  10  | 
  11  | test.describe('notes editor', () => {
  12  |   test.beforeAll(async () => { await clearSavedListings(); });
  13  | 
  14  |   test('notes, rating, status and tags persist across reload', async ({ page }) => {
  15  |     const href = await openDetail(page);
  16  | 
  17  |     await page.selectOption('select >> nth=0', 'TOURED');
  18  |     await page.selectOption('select >> nth=1', '4');
  19  |     await page.fill('input[placeholder*="good schools"]', 'sunny, quiet street');
  20  |     await page.fill('textarea', 'Kitchen bigger than expected.\nSecond line.');
  21  |     await page.getByRole('button', { name: 'Save' }).click();
  22  |     await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  23  |     await page.waitForTimeout(800);
  24  | 
  25  |     await page.goto(href);
  26  |     await expect(page.locator('select >> nth=0')).toHaveValue('TOURED');
  27  |     await expect(page.locator('select >> nth=1')).toHaveValue('4');
  28  |     await expect(page.locator('textarea')).toHaveValue('Kitchen bigger than expected.\nSecond line.');
  29  |     await expect(page.locator('input[placeholder*="good schools"]')).toHaveValue('sunny, quiet street');
  30  |     await page.screenshot({ path: `${ARTIFACTS}/notes-persisted.png`, fullPage: true });
  31  |   });
  32  | 
  33  |   test('a comma can actually be typed into the tags field', async ({ page }) => {
  34  |     await openDetail(page);
  35  |     const tags = page.locator('input[placeholder*="good schools"]');
  36  |     await tags.fill('');
  37  |     await tags.pressSequentially('quiet, sunny');
  38  |     await page.screenshot({ path: `${ARTIFACTS}/BUG-tags-comma-swallowed.png`, fullPage: true });
  39  |     await expect(tags, 'typing "quiet, sunny" should leave that literal text in the field').toHaveValue('quiet, sunny');
  40  |   });
  41  | 
  42  |   test('tag with quotes and unicode survives a round trip', async ({ page }) => {
  43  |     const href = await openDetail(page, 3);
  44  |     const value = 'café ☀️, "quoted", <b>bold</b>';
  45  |     await page.fill('input[placeholder*="good schools"]', value);
  46  |     await page.getByRole('button', { name: 'Save' }).click();
  47  |     await page.waitForTimeout(900);
  48  |     await page.goto(href);
  49  |     await expect(page.locator('input[placeholder*="good schools"]')).toHaveValue(value);
  50  |     await page.screenshot({ path: `${ARTIFACTS}/notes-unicode-tags.png`, fullPage: true });
  51  |   });
  52  | 
  53  |   test('an over-long tag is rejected visibly, not silently', async ({ page }) => {
  54  |     const href = await openDetail(page, 4);
  55  |     const longTag = 'x'.repeat(200);
  56  |     await page.fill('input[placeholder*="good schools"]', longTag);
  57  |     await page.fill('textarea', 'note that should save alongside the long tag');
  58  |     await page.getByRole('button', { name: 'Save' }).click();
  59  |     await page.waitForTimeout(1000);
  60  |     // innerText only — textContent includes the RSC payload, which contains the word "error".
  61  |     const bodyAfterSave = await page.evaluate(() => document.body.innerText);
  62  |     const sawSavedConfirmation = /\bSaved\b/.test(bodyAfterSave);
  63  | 
  64  |     await page.goto(href);
  65  |     const savedNote = await page.locator('textarea').inputValue();
  66  |     await page.screenshot({ path: `${ARTIFACTS}/notes-long-tag.png`, fullPage: true });
  67  | 
  68  |     if (savedNote !== 'note that should save alongside the long tag') {
  69  |       expect(
  70  |         `sawSavedConfirmation=${sawSavedConfirmation} :: ${bodyAfterSave.slice(0, 200)}`,
  71  |         'save was rejected by the API (tag >60 chars) but the UI showed "Saved" and discarded the note',
  72  |       ).toMatch(/error|too big|too long|invalid|failed/i);
  73  |     }
  74  |   });
  75  | 
  76  |   test('rating can be cleared back to none', async ({ page }) => {
  77  |     const href = await openDetail(page, 5);
  78  |     await page.selectOption('select >> nth=1', '3');
  79  |     await page.getByRole('button', { name: 'Save' }).click();
  80  |     await page.waitForTimeout(800);
  81  |     await page.goto(href);
  82  |     await expect(page.locator('select >> nth=1')).toHaveValue('3');
  83  | 
  84  |     await page.selectOption('select >> nth=1', '');
  85  |     await page.getByRole('button', { name: 'Save' }).click();
  86  |     await page.waitForTimeout(800);
  87  |     await page.goto(href);
  88  |     await expect(page.locator('select >> nth=1'), 'clearing the rating should persist as no rating').toHaveValue('');
  89  |   });
  90  | 
  91  |   test('saving notes must not silently favorite the listing', async ({ page }) => {
  92  |     await page.goto('/listings?sort=price-desc');
  93  |     const href = (await page.locator('tbody tr a[href^="/listings/"]').first().getAttribute('href'))!;
  94  |     await page.goto(href);
  95  | 
  96  |     const star = page.getByRole('button', { name: /favorites/i });
  97  |     await expect(star, 'precondition: listing is not a favorite').toHaveAttribute('aria-pressed', 'false');
  98  | 
  99  |     await page.fill('textarea', 'just a note, I am not saving this house');
  100 |     await page.getByRole('button', { name: 'Save' }).click();
  101 |     await page.waitForTimeout(1000);
  102 |     await page.goto(href);
  103 |     await page.screenshot({ path: `${ARTIFACTS}/notes-side-effect-favorite.png`, fullPage: true });
  104 |     await expect(
  105 |       page.getByRole('button', { name: /favorites/i }),
  106 |       'writing a note should not turn the listing into a favorite',
```