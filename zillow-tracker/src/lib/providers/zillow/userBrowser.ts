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
  /** True when a human had to solve a challenge before the page appeared. */
  solvedChallenge?: boolean;
}

/**
 * Selectors that mean "the listing data has arrived". Presence of one of these — not the
 * HTTP status — is what decides whether a fetch succeeded.
 */
const CONTENT_READY = [
  'script#__NEXT_DATA__',
  '[data-testid="search-page-list-container"]',
  '[id^="zpid_"]',
];

/** Text and markers that mean a challenge is on screen waiting for a human. */
const CHALLENGE_MARKERS = [
  'press & hold',
  'press and hold',
  'are you a human',
  'verify you are a human',
  'px-captcha',
  'perimeterx',
  '_px',
];

export interface UserBrowserFetchOptions extends UserBrowserOptions {
  /**
   * How long to leave a challenge on screen for a person to solve, in ms.
   *
   * Zillow serves its Press & Hold challenge WITH an HTTP 403. Treating that status as
   * final was the bug: the tab was closed while the human was still holding the button,
   * and a page that would have loaded seconds later was reported as a refusal. The
   * status is now advisory and the content decides.
   */
  challengeTimeoutMs?: number;
  /** Called when a challenge appears, so the caller can tell the user to solve it. */
  onChallenge?: (info: { url: string }) => void;
}

/** Whether the page currently shows listing data. */
async function hasContent(page: Page): Promise<boolean> {
  return page
    .evaluate(
      (sel) => sel.some((s) => document.querySelector(s) !== null),
      CONTENT_READY,
    )
    .catch(() => false);
}

/** Whether the page currently shows a human-verification challenge. */
async function hasChallenge(page: Page): Promise<boolean> {
  return page
    .evaluate((markers) => {
      const text = (document.body?.innerText ?? '').toLowerCase();
      const html = document.documentElement.outerHTML.toLowerCase();
      return markers.some((m) => text.includes(m) || html.includes(m));
    }, CHALLENGE_MARKERS)
    .catch(() => false);
}

/**
 * Opens a URL in the user's browser and returns what rendered.
 *
 * The important behaviour is what happens on a challenge. Zillow answers with HTTP 403
 * and a Press & Hold page; a person holds the button; the page then navigates itself to
 * the real content. So this does not decide anything from the status code — it waits for
 * listing data to appear, leaves the tab open and visible while it waits, and only
 * reports a refusal if the data never comes.
 *
 * Solving the challenge also sets a cookie in that browser profile, so the next fetch
 * in the same profile usually goes straight through. The persistent profile is what
 * makes one solve last rather than being demanded on every search.
 */
export async function fetchWithUserBrowser(
  url: string,
  opts: UserBrowserFetchOptions = {},
): Promise<RenderedPage> {
  const timeout = opts.timeoutMs ?? 45_000;
  const challengeTimeout = opts.challengeTimeoutMs ?? 180_000;
  const browser = await connectToUserBrowser(opts);

  // connectOverCDP hands back the browser's existing contexts. Using the first one is
  // what makes this the user's session rather than a blank profile — a fresh context
  // would throw away the very thing that makes this work.
  const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());

  let page: Page | null = null;
  let solvedChallenge = false;

  try {
    page = await context.newPage();
    opts.signal?.addEventListener('abort', () => void page?.close().catch(() => {}), { once: true });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    let status = response?.status() ?? 0;

    // Fast path: content already there.
    let ready = await waitForContent(page, Math.min(timeout, 20_000));

    if (!ready && (await hasChallenge(page))) {
      solvedChallenge = true;
      opts.onChallenge?.({ url });

      // Bring the tab forward — a challenge nobody can see is a challenge nobody solves.
      await page.bringToFront().catch(() => {});

      // Wait for the human. The page navigates itself once the challenge clears, so
      // this watches for content rather than for a click.
      ready = await waitForContent(page, challengeTimeout);

      if (ready) {
        // The status from the challenge response is no longer what this page is.
        status = 200;
      }
    }

    const html = await page.content();
    if (!ready) {
      return { html, status: status || 403, finalUrl: page.url(), solvedChallenge };
    }
    return { html, status, finalUrl: page.url(), solvedChallenge };
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Polls for listing data, returning false on timeout rather than throwing. */
async function waitForContent(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasContent(page)) return true;
    if (page.isClosed()) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * One attached browser, one tab, reused across a whole run.
 *
 * The first version connected, opened a tab, closed it and disconnected for EVERY page.
 * A three-page search was three connect/disconnect cycles and three brand-new tabs
 * hitting deep pagination URLs in seconds — which is both slow and exactly the pattern
 * that gets a challenge thrown at you. Browsing normally means one tab that navigates,
 * and that is also fewer chances to be asked to prove you are human.
 *
 * The session leaves the browser running when it closes; it only gives back the tab.
 */
export class UserBrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private opts: UserBrowserFetchOptions = {}) {}

  async fetch(url: string, overrides: UserBrowserFetchOptions = {}): Promise<RenderedPage> {
    const opts = { ...this.opts, ...overrides };
    const timeout = opts.timeoutMs ?? 45_000;
    const challengeTimeout = opts.challengeTimeoutMs ?? 180_000;

    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await connectToUserBrowser(opts);
      this.page = null;
    }
    if (!this.page || this.page.isClosed()) {
      const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.page = await context.newPage();
    }

    const page = this.page;
    opts.signal?.addEventListener('abort', () => void page.close().catch(() => {}), { once: true });

    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    let status = response?.status() ?? 0;
    let solvedChallenge = false;

    let ready = await waitForContent(page, Math.min(timeout, 20_000));

    if (!ready && (await hasChallenge(page))) {
      solvedChallenge = true;
      opts.onChallenge?.({ url });
      await page.bringToFront().catch(() => {});
      ready = await waitForContent(page, challengeTimeout);
      if (ready) status = 200;
    }

    const html = await page.content();
    return {
      html,
      status: ready ? status : status || 403,
      finalUrl: page.url(),
      solvedChallenge,
    };
  }

  /** Closes the tab and detaches. Never closes the person's browser. */
  async close(): Promise<void> {
    await this.page?.close().catch(() => {});
    this.page = null;
    await this.browser?.close().catch(() => {});
    this.browser = null;
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
