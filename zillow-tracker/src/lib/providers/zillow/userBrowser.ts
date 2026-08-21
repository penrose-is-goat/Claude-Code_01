import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Using the browser the person already has open.
 *
 * A headless Chromium was refused by Zillow with HTTP 403 — measured, from a real
 * residential connection, not guessed. That settles the question: Zillow can tell a
 * launched automation browser from a person's browser, and it declines the first one.
 *
 * So stop trying to look like a real browser and use the real browser. Chrome exposes a
 * DevTools endpoint when started with `--remote-debugging-port`; connecting to it drives
 * the browser already running on the desktop — its profile, its cookies, its history, its
 * TLS fingerprint, its window. There is nothing to detect, because there is nothing
 * pretending. If Zillow serves that browser when a person clicks a link, it serves it
 * here, since to Zillow the two are the same browser doing the same thing.
 *
 * This is also why it is honest. The pages fetched are pages the user can already open
 * by hand; the app just reads them instead of asking the user to. No credential is
 * borrowed that the user has not already given their own browser, nothing is bypassed
 * that a person clicking would not also pass, and no request is made that the user could
 * not have made themselves.
 */

/** Where Chrome listens when started with --remote-debugging-port. */
const DEFAULT_CDP_PORT = 9222;

export class UserBrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserBrowserUnavailableError';
  }
}

export interface UserBrowserOptions {
  port?: number;
  /** Milliseconds to wait for a page to finish. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** How to start Chrome so the app can attach to it. Shown whenever attaching fails. */
export function howToEnable(port = DEFAULT_CDP_PORT): string {
  return [
    'Start Chrome with its debugging port open, then try again.',
    '',
    'Windows — close Chrome completely first, then run:',
    `  & "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe" --remote-debugging-port=${port}`,
    '',
    'macOS:',
    `  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=${port}`,
    '',
    'Linux:',
    `  google-chrome --remote-debugging-port=${port}`,
    '',
    'Chrome will look and behave exactly as usual. The app attaches to that window,',
    'reads the pages you could open yourself, and never types or clicks anything.',
  ].join('\n');
}

/**
 * Attaches to a Chrome already running with its debugging port open.
 *
 * Deliberately does NOT launch one. A browser this code started is an automation
 * browser again, with the fingerprint that got refused; the whole value here is that the
 * browser was started by the person, for their own use.
 */
export async function connectToUserBrowser(opts: UserBrowserOptions = {}): Promise<Browser> {
  const port = opts.port ?? Number(process.env.CHROME_CDP_PORT ?? DEFAULT_CDP_PORT);

  let chromium: typeof import('playwright')['chromium'];
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new UserBrowserUnavailableError('Playwright is not installed. Run: npm install');
  }

  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
  } catch (err) {
    throw new UserBrowserUnavailableError(
      `No Chrome is listening on 127.0.0.1:${port}.\n\n${howToEnable(port)}\n\n` +
      `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

export interface RenderedPage {
  html: string;
  status: number;
  finalUrl: string;
}

/**
 * Opens a URL in the user's browser and returns what rendered.
 *
 * Uses a new tab in their existing context so their session applies, and closes it
 * afterwards so their browser is left as it was found. The tab is opened in the
 * background; nothing steals focus.
 */
export async function fetchWithUserBrowser(
  url: string,
  opts: UserBrowserOptions = {},
): Promise<RenderedPage> {
  const timeout = opts.timeoutMs ?? 45_000;
  const browser = await connectToUserBrowser(opts);

  // connectOverCDP hands back the browser's existing contexts. Using the first one is
  // what makes this the user's session rather than a blank incognito profile — a fresh
  // context would throw away the very thing that makes this work.
  const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());

  let page: Page | null = null;
  try {
    page = await context.newPage();
    opts.signal?.addEventListener('abort', () => void page?.close().catch(() => {}), { once: true });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const status = response?.status() ?? 0;

    // Listing data is written during hydration, after DOMContentLoaded. Waiting for the
    // data itself rather than a fixed sleep means slow pages still work, and a page that
    // never produces it falls through to the timeout and is reported — instead of
    // returning an empty shell that parses as zero listings.
    await page
      .waitForFunction(
        () =>
          document.querySelector('script#__NEXT_DATA__') !== null ||
          document.querySelector('[data-testid="search-page-list-container"]') !== null ||
          document.querySelector('[id^="zpid_"]') !== null,
        undefined,
        { timeout: Math.min(timeout, 25_000) },
      )
      .catch(() => {
        /* The parser and the block detector decide what this page is. */
      });

    return { html: await page.content(), status, finalUrl: page.url() };
  } finally {
    // Leave their browser as we found it.
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Whether a user browser is attachable right now, and how to fix it if not. */
export async function userBrowserAvailable(
  opts: UserBrowserOptions = {},
): Promise<{ ok: boolean; message: string }> {
  try {
    const browser = await connectToUserBrowser(opts);
    const version = browser.version();
    const contexts = browser.contexts().length;
    await browser.close().catch(() => {});
    return { ok: true, message: `Attached to your Chrome ${version} (${contexts} profile(s))` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
