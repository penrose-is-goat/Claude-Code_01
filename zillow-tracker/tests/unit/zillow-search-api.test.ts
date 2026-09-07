import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserBrowserSession } from '../../src/lib/providers/zillow/userBrowser';
import { extractResults, querySearchApi } from '../../src/lib/providers/zillow/searchApi';

/**
 * Querying the search API from inside an already-loaded page.
 *
 * The server below is deliberately strict in the way the real one is: it REFUSES any
 * request that does not carry the session cookie the page was given and an origin
 * matching the page. That is what makes this a real test of the mechanism rather than of
 * a fetch call — a request issued from outside the page fails it, and only one issued by
 * the page's own JavaScript passes.
 *
 * A real Chrome, a real CDP attachment, a real page load and a real same-origin XHR.
 * Nothing is mocked except that the endpoint is local rather than Zillow's.
 */

const PORT = 9224;
const SESSION_COOKIE = 'session=cleared-by-a-human';

const ROWS = [
  { zpid: '333', detailUrl: '/homedetails/4-Api-Ln-Anytown-XX-00000/333_zpid/',
    hdpData: { homeInfo: { zpid: 333, streetAddress: '4 Api Ln', city: 'Anytown', state: 'XX',
      zipcode: '00000', price: 899000, bedrooms: 5, bathrooms: 4, livingArea: 3100,
      homeType: 'SINGLE_FAMILY', homeStatus: 'FOR_SALE', latitude: 3.5, longitude: -4.5 } } },
  { zpid: '444', detailUrl: '/homedetails/5-Api-Ln-Anytown-XX-00000/444_zpid/',
    hdpData: { homeInfo: { zpid: 444, streetAddress: '5 Api Ln', city: 'Anytown', state: 'XX',
      zipcode: '00000', price: 640000, bedrooms: 3, bathrooms: 2, livingArea: 1700,
      homeType: 'CONDO', homeStatus: 'FOR_SALE', latitude: 3.6, longitude: -4.6 } } },
];

function chromePath(): string | null {
  return [process.env.CHROMIUM_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium']
    .filter(Boolean).find((p) => existsSync(p as string)) as string ?? null;
}

const chrome = chromePath();
let proc: ChildProcess | null = null;
let server: Server | null = null;
let base = '';
let rejected: string[] = [];

async function boot(): Promise<boolean> {
  if (!chrome) return false;

  server = createServer((req, res) => {
    if (req.url?.startsWith('/async-create-search-page-state')) {
      // The strictness that makes this test meaningful.
      const cookie = req.headers.cookie ?? '';
      const origin = req.headers.origin ?? '';
      if (!cookie.includes('cleared-by-a-human')) {
        rejected.push('missing session cookie');
        res.writeHead(403); res.end('blocked'); return;
      }
      if (!origin || !origin.startsWith(base)) {
        rejected.push(`bad origin: ${origin || '(none)'}`);
        res.writeHead(403); res.end('blocked'); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        cat1: { searchResults: { mapResults: ROWS, listResults: [ROWS[0]] },
                searchList: { totalResultCount: 812, totalPages: 21 } },
      }));
      return;
    }

    // The page itself: sets the session cookie, as a cleared challenge would.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `${SESSION_COOKIE}; Path=/` });
    res.end('<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>');
  });

  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  proc = spawn(chrome, [
    `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'zt-api-'))}`,
    '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const ready = await boot();

afterAll(() => { server?.close(); proc?.kill(); });

describe.skipIf(!ready)('search API, queried from inside the page', () => {
  const STATE = {
    isMapVisible: true, isListVisible: true,
    mapBounds: { north: 39.1, east: -76.9, south: 38.9, west: -77.1 },
    pagination: { currentPage: 1 },
  };

  it('returns structured listings with coordinates and a total', async () => {
    const session = new UserBrowserSession({ port: PORT, timeoutMs: 20_000 });
    try {
      rejected = [];
      const page = await session.openPage(`${base}/silver-spring-md/`);
      // The host check is covered by the next test; here the local server IS the site.
      const result = await querySearchApi(page, STATE, { expectHost: /^127\.0\.0\.1$/ });

      expect(rejected).toEqual([]);           // the page's own request was accepted
      expect(result.status).toBe(200);
      expect(result.results).toHaveLength(2); // mapResults + listResults, deduped by zpid
      expect(result.total).toBe(812);         // Zillow's own count for the whole market
      expect(result.totalPages).toBe(21);
    } finally {
      await session.close();
    }
  }, 90_000);

  it('refuses to query from a page that is not on zillow.com', async () => {
    const session = new UserBrowserSession({ port: PORT, timeoutMs: 20_000 });
    try {
      const page = await session.openPage(`${base}/somewhere-else/`);
      await expect(querySearchApi(page, STATE)).rejects.toThrow(/not zillow\.com/i);
    } finally {
      await session.close();
    }
  }, 90_000);
});

describe('extractResults', () => {
  it('merges map and list results, deduplicated by zpid', () => {
    const body = JSON.stringify({ cat1: { searchResults: {
      mapResults: [{ zpid: '1' }, { zpid: '2' }], listResults: [{ zpid: '2' }, { zpid: '3' }],
    } } });
    expect(extractResults(body).results).toHaveLength(3);
  });

  it('drops rows with no zpid rather than counting them', () => {
    const body = JSON.stringify({ cat1: { searchResults: { mapResults: [{ zpid: '1' }, { noId: true }] } } });
    expect(extractResults(body).results).toHaveLength(1);
  });

  it('degrades to no results on an unrecognized shape, never to wrong results', () => {
    expect(extractResults('not json').results).toEqual([]);
    expect(extractResults('{}').results).toEqual([]);
    expect(extractResults(JSON.stringify({ cat1: { searchResults: {} } })).results).toEqual([]);
  });

  it('reads the market total when present and stays silent when not', () => {
    expect(extractResults(JSON.stringify({
      cat1: { searchResults: { mapResults: [] }, searchList: { totalResultCount: 774 } },
    })).total).toBe(774);
    expect(extractResults('{}').total).toBeUndefined();
  });
});
