import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UserBrowserSession, fetchWithUserBrowser, howToEnable, userBrowserAvailable,
} from '../../src/lib/providers/zillow/userBrowser';
import { fetchAll } from '../../src/lib/providers/types';
import { parseSearchPage } from '../../src/lib/providers/zillow/parse';

/**
 * Attaching to a browser this code did not launch.
 *
 * A launched headless Chromium was refused by Zillow with HTTP 403, from a real
 * residential connection. That is measured, and it is why this transport exists: a
 * browser the person started for their own use is not distinguishable from that person
 * browsing, because it is that person browsing.
 *
 * The test starts a separate Chrome process with a DevTools port — standing in for "a
 * browser the user already has open" — and then attaches to it exactly as production
 * does. Nothing is mocked: a real second process, a real CDP connection over TCP, a real
 * page load, and the production parser reading the result.
 */

const PORT = 9223; // Not the default, so a developer's own browser is never touched.

const PAGE = `<!doctype html><html><head><title>Real Estate</title></head><body>
<div id="grid-search-results">loading</div><script>
setTimeout(function () {
  var s = document.createElement('script'); s.id = '__NEXT_DATA__'; s.type = 'application/json';
  s.textContent = JSON.stringify({ props: { pageProps: { searchPageState: { cat1: { searchResults: { mapResults: [
    { zpid: "111", detailUrl: "/homedetails/1-Test-St-Anytown-XX-00000/111_zpid/", hdpData: { homeInfo: {
      zpid: 111, streetAddress: "1 Test St", city: "Anytown", state: "XX", zipcode: "00000",
      price: 500000, bedrooms: 3, bathrooms: 2, livingArea: 1500,
      homeType: "SINGLE_FAMILY", homeStatus: "FOR_SALE", latitude: 10.5, longitude: -20.25 } } }
  ] } } } } } });
  document.body.appendChild(s);
}, 600);</script></body></html>`;

function chromePath(): string | null {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const chrome = chromePath();
let proc: ChildProcess | null = null;
let server: Server | null = null;
let base = '';

async function boot(): Promise<boolean> {
  if (!chrome) return false;

  proc = spawn(chrome, [
    `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'zt-cdp-'))}`,
    '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu',
  ], { stdio: 'ignore' });

  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const ready = await boot();

afterAll(() => {
  server?.close();
  proc?.kill();
});

describe.skipIf(!ready)('attaching to a browser we did not launch', () => {
  it('attaches over the DevTools port', async () => {
    const avail = await userBrowserAvailable({ port: PORT });
    expect(avail.ok, avail.message).toBe(true);
    expect(avail.message).toMatch(/Attached to your Chrome/);
  }, 30_000);

  it('reads a page through that browser and parses it, coordinates included', async () => {
    const { html, status } = await fetchWithUserBrowser(`${base}/search/`, { port: PORT, timeoutMs: 20_000 });
    expect(status).toBe(200);
    // Waited for hydration rather than grabbing the empty shell.
    expect(html).toContain('__NEXT_DATA__');

    const { listings } = parseSearchPage(html, { timezone: 'UTC', fetchedAt: new Date() });
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({
      addressLine1: '1 Test St', listPrice: 500000, lat: 10.5, lng: -20.25,
    });
  }, 60_000);

  it('leaves the browser running afterwards', async () => {
    // The app must not close a window the person is using.
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    expect(res.ok).toBe(true);
  }, 30_000);
});

describe('when no browser is listening', () => {
  it('explains how to start one instead of failing obscurely', async () => {
    // A port nothing is on.
    const avail = await userBrowserAvailable({ port: 9399 });
    expect(avail.ok).toBe(false);
    expect(avail.message).toMatch(/No Chrome is listening/);
    expect(avail.message).toMatch(/--remote-debugging-port/);
  }, 30_000);

  it('gives per-platform instructions', () => {
    const help = howToEnable(9222);
    expect(help).toMatch(/Windows/);
    expect(help).toMatch(/macOS/);
    expect(help).toMatch(/Linux/);
    expect(help).toMatch(/never types or clicks/);
  });
});

/**
 * The challenge flow, which is what actually broke in the field.
 *
 * Zillow serves its Press & Hold challenge WITH HTTP 403. The first version treated
 * that status as final, threw, and closed the tab — while the person was still holding
 * the button. They watched the real results flash up in their own browser and the app
 * reported a refusal. So the status is advisory and the presence of listing data is what
 * decides.
 *
 * The server below reproduces that exactly: 403 plus a challenge page on the first
 * request, then real content once "solved". Nothing is mocked — a real Chrome, a real
 * navigation, and the production fetcher.
 */
describe.skipIf(!ready)('a challenge that resolves into content', () => {
  const CHALLENGE = `<!doctype html><html><body>
    <div id="px-captcha">Press &amp; Hold to confirm you are a human</div>
    <script>
      // Stands in for the person holding the button. The delay must exceed the initial
      // content wait below, or the fetcher takes its fast path and the challenge branch
      // — the one that actually broke in the field — is never exercised.
      setTimeout(function () {
        var s = document.createElement('script');
        s.id = '__NEXT_DATA__'; s.type = 'application/json';
        s.textContent = JSON.stringify({ props: { pageProps: { searchPageState: { cat1: { searchResults: {
          mapResults: [{ zpid: "222", detailUrl: "/homedetails/9-Solved-Rd-Anytown-XX-00000/222_zpid/",
            hdpData: { homeInfo: { zpid: 222, streetAddress: "9 Solved Rd", city: "Anytown", state: "XX",
              zipcode: "00000", price: 750000, bedrooms: 4, bathrooms: 3, livingArea: 2000,
              homeType: "SINGLE_FAMILY", homeStatus: "FOR_SALE", latitude: 1.5, longitude: -2.5 } } }]
        } } } } } });
        document.getElementById('px-captcha').remove();
        document.body.appendChild(s);
      }, 5000);
    </script></body></html>`;

  let challengeServer: Server | null = null;
  let challengeBase = '';

  it('waits for the human instead of reporting the 403 as final', async () => {
    challengeServer = createServer((_req, res) => {
      // The exact shape Zillow uses: a refusal status carrying a solvable challenge.
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(CHALLENGE);
    });
    await new Promise<void>((r) => challengeServer!.listen(0, '127.0.0.1', r));
    const addr = challengeServer!.address();
    challengeBase = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

    const notified: string[] = [];
    const result = await fetchWithUserBrowser(`${challengeBase}/search/`, {
      port: PORT,
      timeoutMs: 2_500,
      challengeTimeoutMs: 40_000,
      onChallenge: ({ url }) => notified.push(url),
    });

    // The old behaviour: threw on 403 and closed the tab. The new behaviour:
    expect(result.solvedChallenge).toBe(true);
    expect(result.status).toBe(200);
    expect(notified).toHaveLength(1);

    const { listings } = parseSearchPage(result.html, { timezone: 'UTC', fetchedAt: new Date() });
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ addressLine1: '9 Solved Rd', listPrice: 750000, lat: 1.5 });

    challengeServer.close();
  }, 90_000);

  it('reports a refusal when the challenge never resolves', async () => {
    const stuck = createServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><body><div id="px-captcha">Press &amp; Hold</div></body></html>');
    });
    await new Promise<void>((r) => stuck.listen(0, '127.0.0.1', r));
    const addr = stuck.address();
    const base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';

    const result = await fetchWithUserBrowser(`${base}/search/`, {
      port: PORT, timeoutMs: 4_000, challengeTimeoutMs: 4_000,
    });

    // Never getting content is still a 403 — the point is that it is reported after
    // waiting, not instead of waiting.
    expect(result.status).toBe(403);
    stuck.close();
  }, 60_000);
});

/**
 * Reusing one tab, and keeping what earlier pages returned.
 *
 * These two together are the actual field failure. A real search fetched page 1 of a
 * Zillow result set successfully, was challenged on page 2, and the exception threw away
 * page 1 — so a search that had genuinely found forty homes reported zero, and the
 * person watched their own results flash up in their own browser before the app told
 * them nothing matched.
 */
describe.skipIf(!ready)('one session across several pages', () => {
  it('navigates the same tab instead of opening one per page', async () => {
    const session = new UserBrowserSession({ port: PORT, timeoutMs: 15_000 });
    try {
      const a = await session.fetch(`${base}/page/1/`);
      const b = await session.fetch(`${base}/page/2/`);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Both fetches parsed, from one attached browser and one tab.
      for (const r of [a, b]) {
        expect(parseSearchPage(r.html, { timezone: 'UTC', fetchedAt: new Date() }).listings).toHaveLength(1);
      }
    } finally {
      await session.close();
    }
  }, 90_000);

  it('leaves the browser running after the session closes', async () => {
    const session = new UserBrowserSession({ port: PORT });
    await session.fetch(`${base}/page/1/`);
    await session.close();
    // Closing a session must never close a window the person is using.
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    expect(res.ok).toBe(true);
  }, 60_000);
});

describe('fetchAll keeps what earlier pages returned', () => {
  const capabilities = {
    supportsOpenHouses: true, supportsPolygonQuery: true, supportsRadiusQuery: false,
    supportsPhotos: false, supportsPriceHistory: false,
    rateLimit: { requestsPerRun: 4, minIntervalMs: 0 },
  };

  it('returns page 1 when page 2 is challenged, instead of throwing it away', async () => {
    let call = 0;
    const provider = {
      id: 'zillow' as const, displayName: 'x', capabilities,
      healthCheck: async () => ({ ok: true, message: '' }),
      normalize: (r: { id: string }) => r,
      fetchPage: async () => {
        if (++call === 1) return { raw: [{ id: 'a' }, { id: 'b' }], cursor: '2', requestsUsed: 1 };
        throw new Error('Zillow returned HTTP 403 to your own browser');
      },
    };

    const result = await fetchAll(provider as never, {
      area: { kind: 'cityRadius', city: 'X', state: 'YY', radiusMiles: 5 },
    });

    expect(result.raw).toHaveLength(2);
    expect(result.partial).toMatch(/Stopped after page 1/);
    expect(result.partial).toMatch(/403/);
  });

  it('still throws when the FIRST page fails, because there is nothing to salvage', async () => {
    const provider = {
      id: 'zillow' as const, displayName: 'x', capabilities,
      healthCheck: async () => ({ ok: true, message: '' }),
      normalize: (r: unknown) => r,
      fetchPage: async () => { throw new Error('blocked'); },
    };

    await expect(fetchAll(provider as never, {
      area: { kind: 'cityRadius', city: 'X', state: 'YY', radiusMiles: 5 },
    })).rejects.toThrow(/blocked/);
  });
});
