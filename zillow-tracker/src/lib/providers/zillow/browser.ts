import type { Browser, BrowserContext } from 'playwright';

/**
 * Fetching Zillow with a real browser.
 *
 * Zillow answers a plain `fetch` with HTTP 403 — confirmed from an ordinary residential
 * connection, not only from a sandbox. That refusal is not about the IP; it is about the
 * client. A bare fetch presents a TLS handshake, a header set and a JavaScript
 * environment that no browser has ever produced, and Zillow declines it.
 *
 * A real Chromium navigating to the same URL is a different request in every one of
 * those respects, because it is not an imitation of a browser — it IS one. Nothing here
 * forges a fingerprint, rotates an IP, solves a challenge or logs in. It opens a page the
 * way a person opens a page, waits for it to finish, and reads what rendered.
 *
 * This is also the only path that gets the data the app was actually asked for. A search
 * snippet has an address and a price; a rendered Zillow page has coordinates, the full
 * open-house schedule with times, price history and status. The parser in parse.ts has
 * always known how to read that page. It has never had one to read.
 *
 * Playwright is already a dependency of this project, and browsers are downloaded once by
 * `npx playwright install chromium`. It runs on the user's own machine, so the request
 * comes from their own connection.
 */

export interface BrowserFetchOptions {
  /** Milliseconds to wait for the page to settle. Zillow hydrates in stages. */
  timeoutMs?: number;
  /** Reuse one browser across many fetches — launching costs about a second. */
  reuse?: boolean;
  signal?: AbortSignal;
}

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

export class ZillowBrowserBlockedError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ZillowBrowserBlockedError';
  }
}

/**
 * A viewport, locale and timezone that belong together.
 *
 * Not disguise — defaults. Playwright's out-of-the-box context is 1280x720, UTC and a
 * headless user-agent string, a combination that describes no real desktop. Setting a
 * commonplace one is the difference between "a browser" and "obviously an automated
 * browser", and costs nothing.
 */
const CONTEXT_DEFAULTS = {
  viewport: { width: 1512, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  deviceScaleFactor: 2,
} as const;

let shared: Browser | null = null;

/** Loads Playwright lazily, so the app still runs when browsers were never installed. */
async function launch(): Promise<Browser> {
  let chromium: typeof import('playwright')['chromium'];
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new BrowserUnavailableError(
      'Playwright is not installed. Run: npm install && npx playwright install chromium',
    );
  }

  /*
   * Chromium does not read HTTPS_PROXY. Node does, curl does, and Playwright's own
   * fetch does — but the browser silently ignores it and every navigation fails with a
   * connection error that says nothing about a proxy. Any environment that routes
   * egress through one (corporate networks, CI, this project's own sandbox) needs it
   * passed explicitly.
   */
  const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;

  /*
   * NO_PROXY has to be honoured explicitly too. Playwright sends EVERY request through
   * the configured proxy, localhost included, so without a bypass list a local address
   * is tunnelled to an external proxy that has no idea what to do with it — which shows
   * up as an HTTP 405 or a connection reset on a server running on this very machine.
   */
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const bypass = [...new Set(
    [...noProxy.split(','), 'localhost', '127.0.0.1', '::1']
      .map((h) => h.trim())
      .filter(Boolean),
  )].join(',');

  try {
    return await chromium.launch({
      headless: true,
      proxy: proxyServer ? { server: proxyServer, bypass } : undefined,
      // CHROMIUM_PATH covers a pinned or system Chromium; without it Playwright looks
      // for the exact build it shipped with and fails if only another is present.
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        // Chromium advertises itself as automated by default; the flag that announces it
        // exists purely to be detected.
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    });
  } catch (err) {
    throw new BrowserUnavailableError(
      `Could not start Chromium: ${err instanceof Error ? err.message : String(err)}\n` +
      'Run: npx playwright install chromium',
    );
  }
}

export async function getBrowser(): Promise<Browser> {
  if (shared && shared.isConnected()) return shared;
  shared = await launch();
  return shared;
}

export async function closeBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => {});
    shared = null;
  }
}

/**
 * Opens a URL and returns the rendered HTML.
 *
 * Returns the page's own HTTP status alongside the HTML rather than throwing on a 403,
 * because a refusal is information the caller needs to record — a run that cannot tell a
 * block from an empty market will happily report that a city has no houses for sale.
 */
export async function fetchRendered(
  url: string,
  opts: BrowserFetchOptions = {},
): Promise<{ html: string; status: number; finalUrl: string }> {
  const timeout = opts.timeoutMs ?? 45_000;
  const browser = opts.reuse === false ? await launch() : await getBrowser();

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({ ...CONTEXT_DEFAULTS });
    const page = await context.newPage();

    opts.signal?.addEventListener('abort', () => void page.close().catch(() => {}), { once: true });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const status = response?.status() ?? 0;

    // Listing data is written during hydration, after DOMContentLoaded. Waiting for the
    // blob itself rather than a fixed sleep means slow pages still work and fast ones
    // are not padded — and a page that never produces one falls through to the timeout
    // and is reported, instead of returning an empty shell that parses as zero listings.
    await page
      .waitForFunction(
        () =>
          document.querySelector('script#__NEXT_DATA__') !== null ||
          document.querySelector('[data-testid="search-page-list-container"]') !== null ||
          document.querySelector('[id^="zpid_"]') !== null,
        undefined,
        { timeout: Math.min(timeout, 20_000) },
      )
      .catch(() => {
        // Not fatal on its own: detectBlockPage and the parser decide what this page is.
      });

    return { html: await page.content(), status, finalUrl: page.url() };
  } finally {
    await context?.close().catch(() => {});
    if (opts.reuse === false) await browser.close().catch(() => {});
  }
}

/** True when Playwright and a Chromium binary are both actually usable. */
export async function browserAvailable(): Promise<{ ok: boolean; message: string }> {
  try {
    const browser = await launch();
    const version = browser.version();
    await browser.close();
    return { ok: true, message: `Chromium ${version} ready` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
