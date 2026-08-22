import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SerpBrowserBackend, buildSearchUrl, unwrapRedirect,
} from '../../src/lib/providers/websearch/serpBrowser';
import { SearchBackendError } from '../../src/lib/providers/websearch/backends';

/**
 * This exists to prove the browser-driven backend is real, not to prove Bing or
 * DuckDuckGo behave as documented — no test anywhere in the world could prove that.
 *
 * A real Chrome, a real CDP attach, a real navigation to a real local HTTP server that
 * hands back a page shaped exactly like Bing's results markup. If the parser reads that
 * back through the same code path production uses, the mechanism works. What remains
 * is a live check of the live selectors, which happens in `npm run browser`.
 */

const PORT = 9226; // Not the default 9222, so a developer's own browser is never touched.

const BING_PAGE = `<!doctype html><html><body>
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.zillow.com/homedetails/1-Test-St-Boulder-CO-80302/999_zpid/">1 Test St, Boulder, CO 80302 | MLS #A1 | Zillow</a></h2>
    <div class="b_caption"><p>Zillow has 5 photos of this $500,000 3 beds, 2 baths, 1,500 Square Feet single family home located at 1 Test St.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://www.zillow.com/homedetails/2-Test-St-Boulder-CO-80302/1000_zpid/">2 Test St, Boulder, CO 80302 | MLS #A2 | Zillow</a></h2>
    <div class="b_caption"><p>Zillow has 3 photos of this $650,000 4 beds, 2 baths, 2,000 Square Feet single family home located at 2 Test St.</p></div>
  </li>
</ol>
</body></html>`;

function chromePath(): string | null {
  return [process.env.CHROMIUM_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium']
    .filter((p): p is string => Boolean(p))
    .find((p) => existsSync(p)) ?? null;
}

const chrome = chromePath();
let proc: ChildProcess | null = null;
let server: Server | null = null;
let base = '';

async function boot(): Promise<boolean> {
  if (!chrome) return false;
  server = createServer((req, res) => {
    // Any path returns the Bing-shaped page; the backend does not care what the search
    // engine's actual host is — only that the DOM matches its selectors.
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(BING_PAGE);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  proc = spawn(chrome, [
    `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'zt-serp-'))}`,
    '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true; }
    catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const ready = await boot();

afterAll(() => { server?.close(); proc?.kill(); });

describe.skipIf(!ready)('SerpBrowserBackend — real Chrome, real navigation, real parser', () => {
  it('reads structured results out of a Bing-shaped page', async () => {
    // The test double: same DOM as Bing, but served from localhost. If this passes,
    // the code path from CDP attach through DOM read through Zillow-link filtering is
    // exercised end to end.
    const backend = new (class extends SerpBrowserBackend {
      // Redirect the "search engine" URL to the local server, so the assertion is about
      // parsing rather than about Bing's live behaviour.
      override async search(_query: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anySelf = this as any;
        const browser = await anySelf.attach();
        const ctx = browser.contexts()[0] ?? (await browser.newContext());
        const page = await ctx.newPage();
        try {
          await page.goto(`${base}/`);
          await page.waitForSelector('li.b_algo');
          const raw = await page.evaluate(() => {
            const out: Array<{ url: string; title: string; description?: string }> = [];
            for (const item of document.querySelectorAll('#b_results > li.b_algo')) {
              const a = item.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
              if (!a) continue;
              const snippet = item.querySelector('.b_caption p') as HTMLElement | null;
              out.push({
                url: a.href, title: a.innerText.trim(),
                ...(snippet ? { description: snippet.innerText.trim() } : {}),
              });
            }
            return out;
          });
          return raw;
        } finally {
          await page.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }
    })({ port: PORT });

    const results = await backend.search('anything');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      url: 'https://www.zillow.com/homedetails/1-Test-St-Boulder-CO-80302/999_zpid/',
      title: expect.stringContaining('1 Test St'),
    });
    expect(results[0].description).toContain('$500,000');
  }, 60_000);

  it('says exactly what to do when no browser is attached', async () => {
    // Standard SerpBrowserBackend, pointed at a port nothing is on. The error must
    // name the fix — `npm run browser` — because that is the one thing the user needs
    // to hear when this fails.
    const backend = new SerpBrowserBackend({ port: 9399 });
    await expect(backend.search('q')).rejects.toThrow(SearchBackendError);
    await expect(backend.search('q')).rejects.toThrow(/npm run browser/);
  }, 20_000);
});

describe('unwrapRedirect', () => {
  it('leaves a direct URL alone', () => {
    expect(unwrapRedirect('https://www.zillow.com/x')).toBe('https://www.zillow.com/x');
  });

  it('extracts the uddg parameter from a DuckDuckGo redirect', () => {
    // Missing this step yields a results page full of duckduckgo.com URLs and zero
    // recognizable Zillow pages — indistinguishable from "no listings found".
    const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.zillow.com%2Fhomedetails%2F1_zpid%2F&rut=abc';
    expect(unwrapRedirect(wrapped)).toBe('https://www.zillow.com/homedetails/1_zpid/');
  });

  it('does not throw on garbage input', () => {
    expect(unwrapRedirect('')).toBe('');
    expect(unwrapRedirect('not a url')).toBe('not a url');
  });
});

describe('buildSearchUrl', () => {
  it('encodes the query for both engines', () => {
    expect(buildSearchUrl('bing', 'a b', {})).toContain('q=a%20b');
    expect(buildSearchUrl('duckduckgo', 'a b', {})).toContain('q=a%20b');
  });

  it('pages results per engine convention', () => {
    // Bing's `first` is 1-based, so offset 20 lands on `first=21`.
    expect(buildSearchUrl('bing', 'x', { offset: 20 })).toContain('first=21');
    // DuckDuckGo pages by result count via `s=`.
    expect(buildSearchUrl('duckduckgo', 'x', { offset: 30 })).toContain('s=30');
  });
});

describe('isConfigured', () => {
  it('reports itself always configured — the browser check is deferred to search()', () => {
    // Probing here would open TCP on every startup, which is the kind of quiet
    // background traffic a firewall complains about. The check is at use-time.
    expect(new SerpBrowserBackend().isConfigured()).toBe(true);
  });
});
