import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { browserAvailable, closeBrowser, fetchRendered } from '../../src/lib/providers/zillow/browser';
import { parseSearchPage } from '../../src/lib/providers/zillow/parse';

/**
 * The browser transport, tested against a real Chromium and a real HTTP server.
 *
 * Nothing here is mocked: Chromium actually launches, actually navigates over TCP, and
 * the HTML it returns is actually fed to the production parser. The only thing this
 * cannot exercise is Zillow's own anti-bot response, which no test anywhere can decide
 * — that is what `npm run verify-zillow` is for.
 *
 * The served page hydrates AFTER load, exactly as Zillow does: the listing blob is
 * appended by a timer rather than present in the initial HTML. A fetcher that reads the
 * document too early gets an empty shell that parses to zero listings and looks
 * identical to "no houses for sale here", so the delay is the point of the fixture.
 */

const HYDRATE_DELAY_MS = 700;

const PAGE = `<!doctype html><html><head><title>Silver Spring MD Real Estate</title></head>
<body><div id="grid-search-results">loading</div>
<script>
setTimeout(function () {
  var s = document.createElement('script');
  s.id = '__NEXT_DATA__';
  s.type = 'application/json';
  s.textContent = JSON.stringify({ props: { pageProps: { searchPageState: { cat1: { searchResults: { mapResults: [
    { zpid: "37034952", detailUrl: "/homedetails/9200-Sligo-Creek-Pkwy-Silver-Spring-MD-20901/37034952_zpid/",
      hdpData: { homeInfo: { zpid: 37034952, streetAddress: "9200 Sligo Creek Pkwy", city: "Silver Spring",
        state: "MD", zipcode: "20901", price: 625000, bedrooms: 4, bathrooms: 3, livingArea: 2120,
        homeType: "SINGLE_FAMILY", homeStatus: "FOR_SALE", latitude: 38.9897, longitude: -77.0128 } } },
    { zpid: "37039999", detailUrl: "/homedetails/500-Fenton-St-Silver-Spring-MD-20910/37039999_zpid/",
      hdpData: { homeInfo: { zpid: 37039999, streetAddress: "500 Fenton St", city: "Silver Spring",
        state: "MD", zipcode: "20910", price: 410000, bedrooms: 2, bathrooms: 2, livingArea: 1100,
        homeType: "CONDO", homeStatus: "FOR_SALE", latitude: 38.9955, longitude: -77.0261 } } }
  ] } } } } } });
  document.body.appendChild(s);
}, ${HYDRATE_DELAY_MS});
</script></body></html>`;

let server: Server | null = null;
let base = '';

async function serve(): Promise<string> {
  if (base) return base;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return base;
}

afterAll(async () => {
  server?.close();
  await closeBrowser();
});

const available = await browserAvailable();

describe.skipIf(!available.ok)('Zillow browser transport', () => {
  it('launches a real Chromium', () => {
    expect(available.message).toMatch(/Chromium/);
  });

  it('waits for hydration instead of reading an empty shell', async () => {
    const { html, status } = await fetchRendered(`${await serve()}/silver-spring-md/`, { timeoutMs: 20_000 });
    expect(status).toBe(200);
    // The blob does not exist at DOMContentLoaded; only a fetcher that waits sees it.
    expect(html).toContain('__NEXT_DATA__');
  }, 60_000);

  it('feeds the production parser a page it can read, coordinates included', async () => {
    const { html } = await fetchRendered(`${await serve()}/silver-spring-md/`, { timeoutMs: 20_000 });
    const { listings } = parseSearchPage(html, {
      timezone: 'America/New_York',
      fetchedAt: new Date('2026-08-21T21:00:00Z'),
    });

    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({
      sourceListingId: '37034952',
      addressLine1: '9200 Sligo Creek Pkwy',
      city: 'Silver Spring',
      state: 'MD',
      listPrice: 625000,
      // Coordinates are the thing a search snippet can never supply, and the reason
      // this transport is worth the extra second it costs to start.
      lat: 38.9897,
      lng: -77.0128,
    });
  }, 60_000);

  it('bypasses the proxy for local addresses', async () => {
    // Playwright routes every request through a configured proxy, localhost included.
    // Without an explicit bypass this exact request came back HTTP 405 from the proxy —
    // for a server running on this same machine.
    const { status } = await fetchRendered(`${await serve()}/`, { timeoutMs: 20_000 });
    expect(status).toBe(200);
  }, 60_000);
});

describe.skipIf(available.ok)('Zillow browser transport (Chromium not installed)', () => {
  it('reports how to install it rather than failing obscurely', () => {
    expect(available.message).toMatch(/playwright install|Could not start Chromium/i);
  });
});
