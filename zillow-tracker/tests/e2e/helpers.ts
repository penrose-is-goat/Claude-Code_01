import type { Page, ConsoleMessage } from '@playwright/test';

export const ARTIFACTS = '.playwright-artifacts';

export const PAGES = [
  { path: '/', name: 'home' },
  { path: '/listings', name: 'listings' },
  { path: '/open-houses', name: 'open-houses' },
  { path: '/saved', name: 'saved' },
  { path: '/areas', name: 'areas' },
  { path: '/settings', name: 'settings' },
];

export interface Collected {
  console: { type: string; text: string; location: string }[];
  pageErrors: string[];
  failedRequests: string[];
}

/** Attaches listeners for console output, uncaught exceptions and failed requests. */
export function collect(page: Page): Collected {
  const out: Collected = { console: [], pageErrors: [], failedRequests: [] };
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const loc = m.location();
      out.console.push({ type: m.type(), text: m.text(), location: `${loc.url}:${loc.lineNumber}` });
    }
  });
  page.on('pageerror', (e) => out.pageErrors.push(e.message));
  page.on('requestfailed', (r) => out.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`));
  return out;
}

/** Errors we do not control (e.g. hotlinked photos from a fake CDN). */
export function isExternalAssetNoise(text: string): boolean {
  return /Failed to load resource|net::ERR_|ERR_NAME_NOT_RESOLVED|the server responded with a status of 4|the server responded with a status of 5/i.test(
    text,
  );
}

/** Number of data rows in the first (or nth) table on the page. */
export async function rowCount(page: Page, nth = 0): Promise<number> {
  const tables = page.locator('table');
  if ((await tables.count()) === 0) return 0;
  return tables.nth(nth).locator('tbody tr').count();
}

/** Does the document scroll sideways? */
export async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const offenders: { tag: string; cls: string; id: string; right: number; text: string }[] = [];
    const vw = d.clientWidth;
    document.querySelectorAll<HTMLElement>('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > vw + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          cls: typeof el.className === 'string' ? el.className : '',
          id: el.id,
          right: Math.round(r.right),
          text: (el.textContent ?? '').trim().slice(0, 60),
        });
      }
    });
    return {
      scrollWidth: d.scrollWidth,
      clientWidth: d.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflows: d.scrollWidth > d.clientWidth + 1,
      offenders: offenders.slice(0, 12),
    };
  });
}

function srgb(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function contrast(fg: [number, number, number], bg: [number, number, number]): number {
  const l = (c: [number, number, number]) => 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
  const a = l(fg);
  const b = l(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Walks visible text nodes and computes effective contrast against the nearest opaque ancestor bg. */
export async function textContrastReport(page: Page) {
  return page.evaluate(() => {
    function toRgb(s: string): [number, number, number] | null {
      const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) return null;
      if (m[4] !== undefined && Number(m[4]) === 0) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    function bgOf(el: Element): [number, number, number] {
      let cur: Element | null = el;
      while (cur) {
        const c = toRgb(getComputedStyle(cur).backgroundColor);
        if (c) return c;
        cur = cur.parentElement;
      }
      return [255, 255, 255];
    }
    function lum(c: [number, number, number]) {
      const f = (x: number) => {
        const v = x / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    const results: { text: string; fg: string; bg: string; ratio: number; tag: string; size: number }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const txt = (node.textContent ?? '').trim();
      if (!txt) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const fg = toRgb(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const a = lum(fg);
      const b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      results.push({
        text: txt.slice(0, 50),
        fg: cs.color,
        bg: `rgb(${bg.join(', ')})`,
        ratio: Math.round(ratio * 100) / 100,
        tag: el.tagName.toLowerCase(),
        size: parseFloat(cs.fontSize),
      });
    }
    return results;
  });
}

/**
 * Ground truth read straight from the app's SQLite DB, so the expectations follow the
 * data instead of a hardcoded snapshot (the mock provider mutates it on every poll).
 */
export interface Row {
  id: string;
  addr: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  status: string;
  type: string;
}

export async function loadListings(): Promise<Row[]> {
  const { prisma } = await import('../../src/lib/db/client');
  const rows = await prisma.listing.findMany({
    where: { removedAt: null },
    select: { id: true, addressLine1: true, listPrice: true, beds: true, bathsTotal: true, status: true, propertyType: true },
  });
  return rows.map((r) => ({
    id: r.id,
    addr: r.addressLine1,
    price: r.listPrice,
    beds: r.beds,
    baths: r.bathsTotal,
    status: r.status,
    type: r.propertyType,
  }));
}

/** Test-owned state: wipes favourites/notes so favourite + notes specs start from a known point. */
export async function clearSavedListings(): Promise<void> {
  const { prisma } = await import('../../src/lib/db/client');
  await prisma.savedListing.deleteMany({});
}
