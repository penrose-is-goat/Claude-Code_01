import { describe, expect, it, vi } from 'vitest';
import {
  decodeEntities, detectBlockPage, parseDuckDuckGoHtml, parseMojeekHtml, stripTags, unwrapRedirect,
} from '../../src/lib/providers/websearch/html';
import { DuckDuckGoBackend, FallbackBackend, MojeekBackend } from '../../src/lib/providers/websearch/backends';
import type { SearchBackend } from '../../src/lib/providers/websearch/backends';

/**
 * The HTML shapes below follow `deedy5/ddgs`, a maintained scraper that runs against
 * these live endpoints — result blocks are `<div class="...body...">` with the title in
 * an `<h2>`, and Mojeek returns `<li>` items with the snippet in `<p class="s">`.
 *
 * They are structural specimens, not captures: this environment's egress policy blocks
 * both engines, so no live page could be saved here. `npm run verify-search` makes one
 * real request from a machine that can reach them and prints what it actually got, which
 * is what turns these from plausible into confirmed.
 */

const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://www.zillow.com/homedetails/9200-Sligo-Creek-Pkwy-Silver-Spring-MD-20901/37034952_zpid/">
        9200 Sligo Creek Pkwy, Silver Spring, MD 20901 | MLS #MDMC2199999 | Zillow
      </a>
    </h2>
    <a class="result__snippet" href="https://www.zillow.com/homedetails/9200-Sligo-Creek-Pkwy-Silver-Spring-MD-20901/37034952_zpid/">
      Zillow has 41 photos of this <b>$625,000</b> 4 beds, 3 baths, 2,120 Square Feet single family home
      located at 9200 Sligo Creek Pkwy, Silver Spring, MD 20901 built in 1952. MLS #MDMC2199999.
    </a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.zillow.com%2Fhomedetails%2F1-Elm-St-Silver-Spring-MD-20910%2F11111_zpid%2F&amp;rut=abc">
        1 Elm St, Silver Spring, MD 20910 | Zillow
      </a>
    </h2>
  </div>
</div>
<div class="result results_links result--ad">
  <div class="links_main result__body">
    <h2><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bingv7aa">Sponsored result</a></h2>
  </div>
</div>`;

describe('parseDuckDuckGoHtml', () => {
  it('pulls the url, title and indexed description out of a result block', () => {
    const [first] = parseDuckDuckGoHtml(DDG_HTML);
    expect(first.url).toBe(
      'https://www.zillow.com/homedetails/9200-Sligo-Creek-Pkwy-Silver-Spring-MD-20901/37034952_zpid/',
    );
    expect(first.title).toBe('9200 Sligo Creek Pkwy, Silver Spring, MD 20901 | MLS #MDMC2199999 | Zillow');
    // The <b> around the matched price must not survive into the parsed text.
    expect(first.description).toContain('$625,000 4 beds, 3 baths, 2,120 Square Feet');
    expect(first.description).not.toContain('<b>');
  });

  it('unwraps the redirect DuckDuckGo puts around outbound links', () => {
    const urls = parseDuckDuckGoHtml(DDG_HTML).map((r) => r.url);
    expect(urls).toContain('https://www.zillow.com/homedetails/1-Elm-St-Silver-Spring-MD-20910/11111_zpid/');
    // Missing this step yields a page of duckduckgo.com links and zero Zillow pages,
    // which looks exactly like "no listings found".
    expect(urls.every((u) => !u.includes('duckduckgo.com'))).toBe(true);
  });

  it('drops sponsored y.js results', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML).map((r) => r.title)).not.toContain('Sponsored result');
  });

  it('keeps a result whose block carries no snippet', () => {
    // The MLS-number signal still classifies it, so losing it would lose a real listing.
    const withoutSnippet = parseDuckDuckGoHtml(DDG_HTML).find((r) => r.url.includes('1-Elm-St'));
    expect(withoutSnippet).toBeDefined();
    expect(withoutSnippet!.description).toBeUndefined();
  });

  it('pairs each title with its own snippet, never a neighbour\'s', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML);
    const elm = results.find((r) => r.url.includes('1-Elm-St'))!;
    expect(elm.description).toBeUndefined();
    expect(results.find((r) => r.url.includes('Sligo'))!.description).toContain('Sligo Creek');
  });

  it('returns nothing rather than garbage for an unrecognized page', () => {
    expect(parseDuckDuckGoHtml('<html><body><p>hello</p></body></html>')).toEqual([]);
    expect(parseDuckDuckGoHtml('')).toEqual([]);
  });
});

describe('parseMojeekHtml', () => {
  const MOJEEK_HTML = `
    <ul class="results-standard results">
      <li>
        <h2><a href="https://www.zillow.com/homedetails/500-Fenton-St-Silver-Spring-MD-20910/22222_zpid/">
          500 Fenton St, Silver Spring, MD 20910 | MLS #MDMC1234 | Zillow</a></h2>
        <p class="s">Zillow has 12 photos of this $410,000 2 beds, 2 baths, 1,100 Square Feet condo home
        located at 500 Fenton St, Silver Spring, MD 20910 built in 2006.</p>
      </li>
    </ul>`;

  it('reads an independent index the same way', () => {
    const [only] = parseMojeekHtml(MOJEEK_HTML);
    expect(only.url).toContain('/homedetails/500-Fenton-St');
    expect(only.title).toContain('500 Fenton St, Silver Spring, MD 20910');
    expect(only.description).toContain('$410,000');
  });

  it('ignores relative in-site links', () => {
    expect(parseMojeekHtml('<ul class="results"><li><h2><a href="/about">About</a></h2></li></ul>')).toEqual([]);
  });
});

describe('detectBlockPage', () => {
  it('names a challenge page instead of letting it read as an empty market', () => {
    // This is the failure that matters: a challenge parses to zero results, which is
    // indistinguishable from "this town has no houses" unless it is called out.
    expect(detectBlockPage('<html><body>Unfortunately, bots use DuckDuckGo too.</body></html>'))
      .toMatch(/anti-bot/i);
    expect(detectBlockPage('<html><body>Please complete the CAPTCHA</body></html>')).toMatch(/captcha/i);
    expect(detectBlockPage('<html><body>Too many requests</body></html>')).toMatch(/rate limited/i);
    expect(detectBlockPage('')).toBe('empty response');
  });

  it('passes a normal results page', () => {
    expect(detectBlockPage(DDG_HTML)).toBeNull();
  });
});

describe('unwrapRedirect and text helpers', () => {
  it('leaves a direct link alone', () => {
    expect(unwrapRedirect('https://www.zillow.com/x')).toBe('https://www.zillow.com/x');
  });

  it('decodes entities in the right order', () => {
    // Ampersand last, or "&amp;lt;" wrongly becomes "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('3 &amp; 4 &quot;x&quot;')).toBe('3 & 4 "x"');
  });

  it('strips markup and collapses whitespace', () => {
    expect(stripTags('<b>$625,000</b>\n   4 beds')).toBe('$625,000 4 beds');
  });
});

describe('the app needs no API key', () => {
  it('reports itself configured with nothing set', () => {
    for (const b of [new DuckDuckGoBackend(), new MojeekBackend()]) {
      expect(b.isConfigured(), b.displayName).toBe(true);
    }
  });

  it('POSTs to the HTML endpoint, because a GET is not what that page accepts', async () => {
    let seen: { url: string; method?: string } | null = null;
    const backend = new DuckDuckGoBackend((async (url: string, init: RequestInit) => {
      seen = { url: String(url), method: init?.method };
      return new Response(DDG_HTML, { status: 200 });
    }) as unknown as typeof fetch);

    const results = await backend.search('site:zillow.com/homedetails "Silver Spring, MD"');
    expect(seen!.method).toBe('POST');
    expect(seen!.url).toBe('https://html.duckduckgo.com/html/');
    expect(results.length).toBeGreaterThan(0);
  });

  it('reports a challenge as an error instead of an empty market', async () => {
    const backend = new DuckDuckGoBackend((async () =>
      new Response('Unfortunately, bots use DuckDuckGo too.', { status: 200 })) as unknown as typeof fetch);
    await expect(backend.search('anything')).rejects.toThrow(/anti-bot/i);
  });
});

describe('FallbackBackend', () => {
  const ok = (name: string, results: number): SearchBackend => ({
    id: name, displayName: name, setupHint: '', isConfigured: () => true,
    search: vi.fn(async () => Array.from({ length: results }, (_, i) => ({ url: `https://x/${name}/${i}`, title: name }))),
  });
  const boom = (name: string): SearchBackend => ({
    id: name, displayName: name, setupHint: '', isConfigured: () => true,
    search: vi.fn(async () => { throw new Error('throttled'); }),
  });

  it('moves to the next engine when the first is throttling', async () => {
    const second = ok('second', 2);
    const results = await new FallbackBackend([boom('first'), second]).search('q');
    expect(results).toHaveLength(2);
  });

  it('names every failure rather than reporting an empty market', async () => {
    await expect(new FallbackBackend([boom('a'), boom('b')]).search('q'))
      .rejects.toThrow(/Every search backend failed[\s\S]*a: throttled[\s\S]*b: throttled/);
  });

  it('treats a genuine zero-result query as zero results, not as failure', async () => {
    await expect(new FallbackBackend([ok('a', 0), ok('b', 0)]).search('q')).resolves.toEqual([]);
  });
});
