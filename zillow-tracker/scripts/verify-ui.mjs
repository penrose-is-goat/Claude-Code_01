#!/usr/bin/env node
/**
 * Browser regression checks for the UI defects found in the August audit.
 *
 * Each check corresponds to a specific bug that shipped: the detail page collapsing at
 * phone width, the tags field deleting typed commas, the notes editor claiming "Saved"
 * after a rejected request, a note silently starring a listing, Reset leaving stale form
 * values, and unreadable badge contrast in dark mode.
 *
 * Usage: start the app, then `node scripts/verify-ui.mjs [baseUrl]`
 */
import { chromium } from '@playwright/test';

const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
// Honour a preinstalled browser when the sandbox pins one that Playwright's own
// download would not match.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- 1. detail page at 375px: no horizontal overflow, sidebar below content ---
{
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await page.goto(`${BASE}/listings`, { waitUntil: 'networkidle' });
  const href = await page.locator('a[href^="/listings/"]').first().getAttribute('href');
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });

  const m = await page.evaluate(() => {
    const grid = document.querySelector('.detail-grid');
    return {
      cols: grid ? getComputedStyle(grid).gridTemplateColumns : 'NO GRID',
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      asidePos: getComputedStyle(document.querySelector('.detail-aside')).position,
    };
  });
  check('375px detail: single column', !m.cols.includes(' '), `columns = ${m.cols}`);
  check('375px detail: no horizontal page scroll', m.scrollW <= m.clientW, `scrollW ${m.scrollW} vs clientW ${m.clientW}`);
  check('375px detail: aside not sticky', m.asidePos === 'static', `position ${m.asidePos}`);
  await page.screenshot({ path: '.playwright-artifacts/fixed-375-detail.png', fullPage: true });

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await page.evaluate(() => {
    const g = document.querySelector('.detail-grid');
    return { cols: getComputedStyle(g).gridTemplateColumns, aside: getComputedStyle(document.querySelector('.detail-aside')).position };
  });
  check('1440px detail: two columns restored', wide.cols.split(' ').length === 2, wide.cols);
  check('1440px detail: aside sticky again', wide.aside === 'sticky');
  await page.close();
}

// --- 2. tags field accepts a typed comma ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/listings`, { waitUntil: 'networkidle' });
  const href = await page.locator('a[href^="/listings/"]').first().getAttribute('href');
  await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
  const tags = page.getByPlaceholder('good schools, needs work');
  await tags.click();
  await tags.type('alpha, beta', { delay: 20 });
  const typed = await tags.inputValue();
  check('tags: typed comma survives', typed === 'alpha, beta', `got "${typed}"`);

  // --- 3. an over-long tag must report failure, not claim success ---
  await tags.fill('x'.repeat(70));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1200);
  const status = (await page.locator('[role="status"]').allTextContents()).join(' | ');
  check('notes: rejected save reports the error', /Not saved/i.test(status), `status = "${status}"`);
  await page.screenshot({ path: '.playwright-artifacts/fixed-notes-error.png' });

  // --- 4. a valid save reports success and persists ---
  await tags.fill('good schools, quiet street');
  await page.locator('textarea').fill('Verification note.');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForTimeout(1500);
  const ok = (await page.locator('[role="status"]').allTextContents()).join(' | ');
  check('notes: valid save reports Saved', /Saved/.test(ok) && !/Not saved/.test(ok), `status = "${ok}"`);

  await page.reload({ waitUntil: 'networkidle' });
  const persisted = await page.locator('textarea').inputValue();
  check('notes: persisted after reload', persisted === 'Verification note.', `got "${persisted}"`);

  // --- 5. writing a note must NOT star the listing ---
  const pressed = await page.locator('button[aria-pressed]').first().getAttribute('aria-pressed');
  check('notes do not silently favorite', pressed === 'false', `aria-pressed = ${pressed}`);
  await page.close();
}

// --- 6. Reset clears the form, not just the results ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/listings?status=PENDING`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Reset' }).click();
  await page.waitForURL('**/listings');
  await page.waitForTimeout(400);
  const statusVal = await page.locator('select[name="status"]').inputValue();
  check('Reset clears the form controls', statusVal === '', `status select = "${statusVal}"`);
  await page.close();
}

// --- 7. dark mode contrast on the badge ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const badge = await page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((s) => s.getAttribute('aria-label')?.includes('unseen'));
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor };
  });
  if (badge) {
    const lum = (c) => { const [r,g,b] = c.match(/\d+/g).map(Number).map((v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : ((s+0.055)/1.055)**2.4; }); return 0.2126*r+0.7152*g+0.0722*b; };
    const L1 = lum(badge.color), L2 = lum(badge.bg);
    const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    check('dark mode: badge contrast >= 4.5:1', ratio >= 4.5, `${ratio.toFixed(2)}:1 (${badge.color} on ${badge.bg})`);
  } else {
    check('dark mode: badge present to measure', false, 'badge not found (no unseen events)');
  }
  await page.screenshot({ path: '.playwright-artifacts/fixed-dark-home.png' });
  await page.close();
}

// --- 8. no <button> nested in <a> anywhere ---
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let bad = [];
  for (const path of ['/', '/listings', '/saved', '/open-houses', '/settings']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const n = await page.locator('a button').count();
    if (n > 0) bad.push(`${path}:${n}`);
  }
  check('no button nested inside an anchor', bad.length === 0, bad.join(', '));
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
