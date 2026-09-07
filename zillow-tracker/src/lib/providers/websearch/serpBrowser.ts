import type { Browser, BrowserContext, Page } from 'playwright';
import type { SearchBackend, SearchBackendOptions } from './backends';
import { SearchBackendError } from './backends';
import type { SearchResult } from './parse';

/**
 * Searching the web with the user's own browser — no key, no account, no signup.
 *
 * The other backends in this project all require the user to register with a search
 * provider. That has been the wrong answer since the beginning: the whole point of this
 * app is to read Zillow the way a person reads Zillow, and a person does not have a
 * Mojeek key. A person opens a browser, types a query, reads the results.
 *
 * This does that. It attaches to the Chrome window `npm run browser` already opened
 * for the Zillow transport (via CDP), navigates to a search engine, and reads the
 * organic results out of the rendered page. That browser is a real browser, on the
 * user's own connection, with the user's own cookies — so a search engine sees an
 * ordinary human visit, not an automation client.
 *
 * The parser is deliberately structural-and-forgiving: two search engines are supported
 * (Bing and DuckDuckGo, both with stable indexed-results markup), the first that
 * answers wins, and unrecognized markup degrades to no results rather than to wrong
 * results. A search engine renaming a CSS class shows up as "no results" — the caller
 * knows to try the other engine — never as a listing that is not actually there.
 */

export interface SerpBrowserOptions {
  /** The DevTools port the user's Chrome is listening on (from `npm run browser`). */
  port?: number;
  /** How long to wait for the results page to render. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Force one engine; otherwise the first that answers is used. */
  engine?: 'bing' | 'duckduckgo';
}

const DEFAULT_PORT = 9222;

export class SerpBrowserBackend implements SearchBackend {
  readonly id = 'serp-browser';
  readonly displayName = 'Your browser (no key)';
  readonly setupHint =
    'Run `npm run browser` in a second terminal — the app will drive that Chrome to a search engine. ' +
    'No key, no signup.';

  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly forcedEngine: 'bing' | 'duckduckgo' | undefined;

  constructor(opts: SerpBrowserOptions = {}) {
    this.port = opts.port ?? Number(process.env.CHROME_CDP_PORT ?? DEFAULT_PORT);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.forcedEngine = opts.engine;
  }

  /**
   * Reports itself configured whenever a browser exists at the port. The check is
   * deferred to `search()` rather than probed synchronously — probing here would open
   * TCP on every startup, which is exactly the kind of quiet background traffic a
   * user's firewall complained about last time.
   */
  isConfigured(): boolean {
    return true;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    const browser = await this.attach();
    // Reuse the existing context (the user's real profile with its real cookies).
    // A fresh context here throws away the very thing that makes this look human.
    const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    opts.signal?.addEventListener('abort', () => void page.close().catch(() => {}), { once: true });

    try {
      const engines: Array<'bing' | 'duckduckgo'> = this.forcedEngine
        ? [this.forcedEngine]
        : ['bing', 'duckduckgo'];

      const errors: string[] = [];
      for (const engine of engines) {
        try {
          const results = await this.searchOne(page, engine, query, opts);
          if (results.length > 0) return results;
          errors.push(`${engine}: 0 results`);
        } catch (err) {
          errors.push(`${engine}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Every engine either failed or returned nothing. A genuine zero-result query is
      // rare for a Zillow site: query — much more often this is a rate limit or a class
      // rename, so the caller gets an actionable message rather than an empty answer.
      throw new SearchBackendError(
        `No search engine returned results through the browser.\n  ${errors.join('\n  ')}`,
      );
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  private async searchOne(
    page: Page,
    engine: 'bing' | 'duckduckgo',
    query: string,
    opts: SearchBackendOptions,
  ): Promise<SearchResult[]> {
    const url = buildSearchUrl(engine, query, opts);
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.timeoutMs,
    });

    // Wait for organic results to render — different engines paint different markers.
    // A page that never produces the marker falls through the timeout and is treated as
    // "no results from this engine", so the caller can try the other one.
    await page
      .waitForFunction(
        (sel) => sel.some((s) => document.querySelector(s) !== null),
        RESULT_MARKERS[engine],
        { timeout: Math.min(this.timeoutMs, 12_000) },
      )
      .catch(() => undefined);

    const status = response?.status() ?? 0;
    if (status >= 400) {
      throw new SearchBackendError(`${engine} returned HTTP ${status}`, status);
    }

    const raw = await page.evaluate((sel) => {
      const out: Array<{ url: string; title: string; description?: string }> = [];
      for (const sel_ of sel.itemSelectors) {
        for (const item of document.querySelectorAll(sel_)) {
          const a = item.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
          if (!a) continue;
          const url = a.href;
          const title = a.innerText.trim();
          if (!url || !title) continue;

          // Description candidates, in order of likelihood: any element the engine
          // marks as a snippet, otherwise the item's own text with the title removed.
          let description: string | undefined;
          for (const s of sel.snippetSelectors) {
            const el = item.querySelector(s);
            if (el && (el as HTMLElement).innerText) {
              description = (el as HTMLElement).innerText.trim();
              break;
            }
          }
          out.push({ url, title, ...(description ? { description } : {}) });
        }
        if (out.length > 0) break;
      }
      return out;
    }, SELECTORS[engine]);

    // DuckDuckGo wraps outbound links in a redirect; unwrap so downstream sees the
    // actual zillow.com URL. Missing this yields a page of duckduckgo.com URLs and
    // zero recognizable Zillow pages — the exact "looks like no results" trap the
    // parser must never present as truth.
    return raw.map(({ url, title, description }) => ({
      url: unwrapRedirect(url),
      title,
      description,
    })).filter((r) => r.url.length > 0);
  }

  private async attach(): Promise<Browser> {
    let chromium: typeof import('playwright')['chromium'];
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new SearchBackendError(
        'Playwright is not installed. Run `npm install` in the project.',
      );
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`, { timeout: 5_000 });
    } catch (err) {
      throw new SearchBackendError(
        `No browser is listening on 127.0.0.1:${this.port}. Run \`npm run browser\` in a second ` +
          `terminal and try again. (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

/**
 * Selectors per engine — kept in one place so a class rename is one line to fix.
 * Multiple item selectors in order of preference: if the first yields nothing, the
 * next is tried, because search engines quietly A/B-test result markup.
 */
const SELECTORS: Record<'bing' | 'duckduckgo', { itemSelectors: string[]; snippetSelectors: string[] }> = {
  bing: {
    itemSelectors: ['#b_results > li.b_algo', 'ol#b_results > li.b_algo'],
    snippetSelectors: ['.b_caption p', 'p.b_lineclamp3', 'p'],
  },
  duckduckgo: {
    itemSelectors: ['.result:not(.result--ad)', 'div[data-testid="result"]'],
    snippetSelectors: ['.result__snippet', '[data-result="snippet"]'],
  },
};

/** Selectors that mean "organic results have rendered" — used to gate the read. */
const RESULT_MARKERS: Record<'bing' | 'duckduckgo', string[]> = {
  bing: ['#b_results li.b_algo', 'ol#b_results'],
  duckduckgo: ['.result:not(.result--ad)', 'div[data-testid="result"]'],
};

export function buildSearchUrl(
  engine: 'bing' | 'duckduckgo',
  query: string,
  opts: SearchBackendOptions,
): string {
  const q = encodeURIComponent(query);
  const first = opts.offset ? Math.max(1, opts.offset + 1) : 1;
  switch (engine) {
    case 'bing':
      // `first` is 1-based; each Bing page is ten results.
      return `https://www.bing.com/search?q=${q}&first=${first}`;
    case 'duckduckgo':
      // DuckDuckGo's HTML endpoint returns the same markup a browser renders.
      return `https://duckduckgo.com/?q=${q}&s=${opts.offset ?? 0}`;
  }
}

/**
 * DuckDuckGo wraps outbound links as `//duckduckgo.com/l/?uddg=<encoded-url>&rut=...`
 * so it can log the click. The real Zillow URL is the `uddg` parameter.
 */
export function unwrapRedirect(rawUrl: string): string {
  if (!rawUrl) return '';
  const url = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
  try {
    const parsed = new URL(url, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return url;
  } catch {
    return url;
  }
}
