import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchWithUserBrowser, howToEnable, userBrowserAvailable } from '../../src/lib/providers/zillow/userBrowser';
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
