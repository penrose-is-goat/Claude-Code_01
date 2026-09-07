import { describe, expect, it, vi } from 'vitest';
import { splitCircle, splitSearch, type Circle } from '../../src/lib/address-index/split';
import { RentCastAddressIndex, circleFor } from '../../src/lib/address-index';

/**
 * The split logic is tested against its own contract rather than a live API: the whole
 * point of it is behaviour at the per-query cap, which a real endpoint would only
 * exhibit for markets large enough to be slow and expensive to probe repeatedly. The
 * fake below stands in for the NETWORK, not for the data — it models a documented rule
 * ("at most 500 records per response") and the assertions are about how the recursion
 * responds to it.
 */

const BOULDER: Circle = { lat: 40.015, lng: -105.27, radiusMiles: 8 };

describe('splitCircle', () => {
  it('produces four children that cover the parent', () => {
    const kids = splitCircle(BOULDER);
    expect(kids).toHaveLength(4);

    // Each child must reach the parent's edge, or the corners fall through the gap.
    for (const k of kids) {
      const dLatMi = (k.lat - BOULDER.lat) * 69;
      const dLngMi = (k.lng - BOULDER.lng) * 69 * Math.cos((BOULDER.lat * Math.PI) / 180);
      const centreOffset = Math.hypot(dLatMi, dLngMi);
      expect(centreOffset + k.radiusMiles).toBeGreaterThanOrEqual(BOULDER.radiusMiles - 1e-6);
    }
  });

  it('shrinks the radius but keeps children overlapping, never abutting', () => {
    const kids = splitCircle(BOULDER);
    for (const k of kids) expect(k.radiusMiles).toBeLessThan(BOULDER.radiusMiles);
    // Four circles of radius 0.707r centred at ±r/2 necessarily overlap at the middle.
    expect(kids[0].radiusMiles).toBeCloseTo((8 * Math.SQRT2) / 2, 6);
  });

  it('widens longitude offsets at high latitude so children do not separate', () => {
    const equator = splitCircle({ lat: 0, lng: 0, radiusMiles: 10 });
    const arctic = splitCircle({ lat: 70, lng: 0, radiusMiles: 10 });
    expect(Math.abs(arctic[0].lng)).toBeGreaterThan(Math.abs(equator[0].lng));
  });
});

describe('splitSearch', () => {
  /** Returns `count` synthetic rows, capped, so the cap behaviour can be driven. */
  const rows = (n: number, prefix: string): Array<{ id: string }> =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));

  it('does not split when the answer comes back under the cap', async () => {
    const fetch = vi.fn(async () => rows(120, 'a'));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 3, maxRequests: 50,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.items).toHaveLength(120);
    expect(r.truncated).toEqual([]);
  });

  it('splits when the answer is exactly the cap, because that means "unknown, at least"', async () => {
    let call = 0;
    const fetch = vi.fn(async () => (++call === 1 ? rows(500, 'root') : rows(10, `c${call}`)));

    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 2, maxRequests: 50,
    });

    expect(fetch).toHaveBeenCalledTimes(5); // root + 4 children
    expect(r.maxLevelReached).toBe(1);
    expect(r.truncated).toEqual([]);
  });

  it('recurses until every piece is under the cap', async () => {
    // Radii by level: 8 -> 5.66 -> 4.0. The threshold sits at 4.5 rather than 4 on
    // purpose: 8*(root2/2)^2 lands on 4.0000000000000009, so a threshold of exactly 4
    // tests floating-point noise instead of the recursion.
    const fetch = vi.fn(async (c: Circle) => (c.radiusMiles > 4.5 ? rows(500, `r${c.radiusMiles}`) : rows(3, `${c.lat}`)));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 3, maxRequests: 100,
    });
    expect(r.maxLevelReached).toBe(2);
    expect(r.truncated).toEqual([]);
  });

  it('reports areas it could not finish rather than passing them off as complete', async () => {
    const fetch = vi.fn(async () => rows(500, 'always-full'));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 1, maxRequests: 50,
    });
    // Root splits once; all four children still saturate and cannot go deeper.
    expect(r.truncated).toHaveLength(4);
  });

  it('stops at the request ceiling and reports the unexplored remainder', async () => {
    const fetch = vi.fn(async () => rows(500, 'full'));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 10, maxRequests: 3,
    });
    expect(r.requests).toBe(3);
    expect(r.truncated.length).toBeGreaterThan(0);
  });

  it('collapses the overlap between children instead of double-counting it', async () => {
    let call = 0;
    // Every child returns the same three homes — the seam overlap, exaggerated.
    const fetch = vi.fn(async () => (++call === 1 ? rows(500, 'root') : rows(3, 'shared')));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 1, maxRequests: 50,
    });
    expect(r.items.filter((i) => i.id.startsWith('shared'))).toHaveLength(3);
  });

  it('never splits when maxLevel is 0', async () => {
    const fetch = vi.fn(async () => rows(500, 'full'));
    const r = await splitSearch(BOULDER, {
      fetch, keyOf: (x: { id: string }) => x.id, cap: 500, maxLevel: 0, maxRequests: 50,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r.truncated).toHaveLength(1);
  });
});

describe('circleFor', () => {
  it('uses a resolved centre and radius directly', () => {
    expect(circleFor({ kind: 'cityRadius', city: 'X', state: 'CO', centerLat: 40, centerLng: -105, radiusMiles: 5 }))
      .toEqual({ lat: 40, lng: -105, radiusMiles: 5 });
  });

  it('returns null when a place was never resolved to coordinates', () => {
    expect(circleFor({ kind: 'cityRadius', city: 'X', state: 'CO', radiusMiles: 5 })).toBeNull();
  });

  it('circumscribes a drawn shape rather than inscribing it', () => {
    const c = circleFor({ kind: 'bbox', minLat: 39.9, maxLat: 40.1, minLng: -105.4, maxLng: -105.1 })!;
    const halfHeightMi = ((40.1 - 39.9) * 69) / 2;
    // Must exceed half the box height, or the corners of the drawn area go unfetched.
    expect(c.radiusMiles).toBeGreaterThan(halfHeightMi);
  });
});

describe('RentCastAddressIndex', () => {
  const record = {
    id: '5500-Baseline-Rd,-Boulder,-CO-80303',
    formattedAddress: '5500 Baseline Rd, Boulder, CO 80303',
    addressLine1: '5500 Baseline Rd',
    city: 'Boulder', state: 'co', zipCode: '80303',
    latitude: 39.9998, longitude: -105.2312,
    // Fields it must ignore: nothing here may ever reach the user.
    price: 1250000, status: 'Active', bedrooms: 4, propertyType: 'Single Family',
  };

  function indexWith(body: unknown, seen: string[] = []) {
    return new RentCastAddressIndex({
      apiKey: 'k',
      maxSplitLevel: 0,
      fetchImpl: (async (url: URL) => {
        seen.push(url.toString());
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
  }

  const AREA = {
    kind: 'cityRadius' as const, city: 'Boulder', state: 'CO',
    centerLat: 40.015, centerLng: -105.27, radiusMiles: 5,
  };

  it('returns addresses only — no price, status or property facts', async () => {
    const { seeds } = await indexWith([record]).addresses(AREA);
    expect(seeds).toEqual([{
      addressLine1: '5500 Baseline Rd',
      city: 'Boulder',
      state: 'CO',
      postalCode: '80303',
      lat: 39.9998,
      lng: -105.2312,
    }]);
    // The guarantee this whole design rests on, asserted directly.
    const keys = Object.keys(seeds[0]);
    for (const forbidden of ['price', 'status', 'bedrooms', 'propertyType', 'listPrice']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('drops a record with no usable address instead of inventing one', async () => {
    const { seeds } = await indexWith([{ city: 'Boulder', state: 'CO', price: 900000 }]).addresses(AREA);
    expect(seeds).toEqual([]);
  });

  it('asks only for active listings on the sale endpoint', async () => {
    const seen: string[] = [];
    await indexWith([], seen).addresses(AREA);
    expect(seen[0]).toContain('/listings/sale');
    expect(seen[0]).toContain('status=Active');
  });

  it('says how to enable itself rather than returning nothing', async () => {
    const idx = new RentCastAddressIndex({ apiKey: '' });
    expect(idx.isConfigured()).toBe(false);
    await expect(idx.addresses(AREA)).rejects.toThrow(/RENTCAST_API_KEY/);
  });

  it('names the quota when the plan runs out', async () => {
    const idx = new RentCastAddressIndex({
      apiKey: 'k', maxSplitLevel: 0,
      fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
    });
    await expect(idx.addresses(AREA)).rejects.toThrow(/quota|rate limit/i);
  });
});
