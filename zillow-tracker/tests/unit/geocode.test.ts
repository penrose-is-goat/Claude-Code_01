import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { GeocodeError, NominatimGeocoder, abbreviateState } from '@/lib/search/geocode';

/**
 * This sandbox's egress proxy 403s nominatim.openstreetmap.org (see CLAUDE.md) — every
 * test here runs against an injected `fetchImpl`, never a real request, and asserts the
 * geocoder degrades correctly when that fetch behaves like the sandbox: unreachable.
 */

let dir: string;
let db: PrismaClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-geocode-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: url }, cwd: process.cwd(), stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.appState.deleteMany();
});

/** A realistic Nominatim `format=json&addressdetails=1` response body for "Boulder, CO". */
const BOULDER_RESULT = [
  {
    display_name: 'Boulder, Boulder County, Colorado, United States',
    lat: '40.0149856',
    lon: '-105.2705456',
    boundingbox: ['39.9542298', '40.0913933', '-105.3013361', '-105.1781515'],
    address: { city: 'Boulder', county: 'Boulder County', state: 'Colorado', 'ISO3166-2-lvl4': 'US-CO' },
  },
];

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  let calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('NominatimGeocoder — happy path', () => {
  it('parses a result into a ResolvedPlace, without swapping lat/lng', async () => {
    const { fn } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    const [place] = await geocoder.resolve('Boulder, CO');
    expect(place.displayName).toBe('Boulder, Boulder County, Colorado, United States');
    expect(place.lat).toBeCloseTo(40.0149856, 5);
    expect(place.lng).toBeCloseTo(-105.2705456, 5);
    expect(place.city).toBe('Boulder');
    // ISO3166-2-lvl4 ("US-CO") is preferred over the spelled-out state name, because
    // zillow/index.ts's buildSearchUrl needs the two-letter form ("boulder-co").
    expect(place.state).toBe('CO');
    expect(place.boundingBox).toEqual([39.9542298, 40.0913933, -105.3013361, -105.1781515]);
  });

  it('sends a descriptive User-Agent and the expected query params', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });
    await geocoder.resolve('Boulder, CO');

    const [call] = calls();
    const url = new URL(call.url);
    expect(url.searchParams.get('q')).toBe('Boulder, CO');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('addressdetails')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('5');
    const ua = (call.init?.headers as Record<string, string>)['User-Agent'];
    expect(ua).toMatch(/zillow-tracker/);
    // Nominatim's policy wants a real contact, but this app has no standing consent to
    // send the user's own email to a third party — confirm it never leaks in here.
    expect(ua).not.toMatch(/@/);
  });

  it('an empty or whitespace-only query short-circuits without any request', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });
    expect(await geocoder.resolve('   ')).toEqual([]);
    expect(calls()).toHaveLength(0);
  });

  it('a result missing lat/lon/display_name is dropped rather than producing NaN', async () => {
    const { fn } = fakeFetch(() => jsonResponse([{ display_name: 'Nowhere' }, ...BOULDER_RESULT]));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });
    const places = await geocoder.resolve('Boulder, CO');
    expect(places).toHaveLength(1);
    expect(Number.isFinite(places[0].lat)).toBe(true);
  });
});

describe('NominatimGeocoder — caching', () => {
  it('caches under geocode:<lowercased query> and never re-fetches on a hit', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await geocoder.resolve('Boulder, CO');
    await geocoder.resolve('BOULDER, co'); // same place, different case
    expect(calls()).toHaveLength(1);

    const row = await db.appState.findUnique({ where: { key: 'geocode:boulder, co' } });
    expect(row).not.toBeNull();
  });

  it('caches a zero-result lookup too, so a repeated typo does not re-spend the request budget', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse([]));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    expect(await geocoder.resolve('asdfghjkl')).toEqual([]);
    expect(await geocoder.resolve('asdfghjkl')).toEqual([]);
    expect(calls()).toHaveLength(1);
  });

  it('a cache hit costs nothing — it is not throttled by the rate limit', async () => {
    const { fn } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 10_000 });
    await geocoder.resolve('Boulder, CO');

    const start = Date.now();
    await geocoder.resolve('Boulder, CO');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('a corrupted cache entry degrades to a re-fetch instead of poisoning the query forever', async () => {
    await db.appState.create({ data: { key: 'geocode:boulder, co', value: 'not json{{{' } });
    const { fn, calls } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    const places = await geocoder.resolve('Boulder, CO');
    expect(places).toHaveLength(1);
    expect(calls()).toHaveLength(1);
  });
});

describe('NominatimGeocoder — rate limiting', () => {
  it('spaces consecutive network requests at least minIntervalMs apart', async () => {
    const { fn } = fakeFetch(() => jsonResponse(BOULDER_RESULT));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 120 });

    const start = Date.now();
    await geocoder.resolve('Boulder, CO'); // cache miss #1 — no wait
    await geocoder.resolve('Denver, CO'); // cache miss #2 (different query) — must wait
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(115); // small slack for scheduler jitter
  });
});

describe('NominatimGeocoder — degrades without throwing into the UI', () => {
  it('a network failure throws a typed, catchable GeocodeError', async () => {
    const { fn } = fakeFetch(() => { throw new TypeError('fetch failed'); });
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await expect(geocoder.resolve('Boulder, CO')).rejects.toBeInstanceOf(GeocodeError);
    await expect(geocoder.resolve('Boulder, CO')).rejects.toMatchObject({ kind: 'network' });
  });

  it('a non-2xx response throws a typed GeocodeError, not a generic one', async () => {
    const { fn } = fakeFetch(() => new Response('rate limited', { status: 429 }));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await expect(geocoder.resolve('Boulder, CO')).rejects.toMatchObject({ kind: 'http' });
  });

  it('an unparseable body throws a typed GeocodeError', async () => {
    const { fn } = fakeFetch(() => new Response('<html>not json</html>', { status: 200 }));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await expect(geocoder.resolve('Boulder, CO')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('a well-formed but non-array body throws a typed GeocodeError rather than crashing downstream', async () => {
    const { fn } = fakeFetch(() => jsonResponse({ error: 'Unable to geocode' }));
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await expect(geocoder.resolve('Boulder, CO')).rejects.toMatchObject({ kind: 'parse' });
  });

  it('a failed lookup is NOT cached — a transient outage should not poison future searches', async () => {
    let attempt = 0;
    const { fn } = fakeFetch(() => {
      attempt++;
      if (attempt === 1) return new Response('down', { status: 503 });
      return jsonResponse(BOULDER_RESULT);
    });
    const geocoder = new NominatimGeocoder(db, { fetchImpl: fn, minIntervalMs: 0 });

    await expect(geocoder.resolve('Boulder, CO')).rejects.toBeInstanceOf(GeocodeError);
    const places = await geocoder.resolve('Boulder, CO');
    expect(places).toHaveLength(1);
  });
});

describe('abbreviateState', () => {
  it('prefers the ISO3166-2-lvl4 code when present', () => {
    expect(abbreviateState('US-CO', 'Colorado')).toBe('CO');
  });

  it('falls back to a name lookup', () => {
    expect(abbreviateState(undefined, 'Colorado')).toBe('CO');
    expect(abbreviateState(undefined, 'New Hampshire')).toBe('NH');
  });

  it('passes an unrecognized or international name through unchanged', () => {
    expect(abbreviateState(undefined, 'Ontario')).toBe('Ontario');
  });

  it('returns undefined when nothing is available', () => {
    expect(abbreviateState(undefined, undefined)).toBeUndefined();
  });
});
