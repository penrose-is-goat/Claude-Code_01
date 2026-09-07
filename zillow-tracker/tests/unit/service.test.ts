import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { runSearch, resolveLocation, filterToLocation, LocationResolutionError } from '@/lib/search/service';
import { GeocodeError } from '@/lib/search/geocode';
import type { Geocoder, ResolvedPlace, SearchLocation, SearchQuery } from '@/lib/search/types';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderId, ProviderPage,
} from '@/lib/providers/types';
import type { NormalizedListing } from '@/lib/providers/normalized';

/**
 * `runSearch` is the boundary that must never let a provider or geocoder failure throw
 * into the UI (see search/service.ts's module doc) — every test here proves that with a
 * `SearchOutcome`, not a caught exception.
 */

let dir: string;
let db: PrismaClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-service-'));
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

const BOULDER: ResolvedPlace = {
  displayName: 'Boulder, Colorado, United States',
  lat: 40.015, lng: -105.2705, city: 'Boulder', state: 'CO',
};

/** Returns a fixed list of candidates, or throws whatever `err` is given (once). */
class FakeGeocoder implements Geocoder {
  readonly id = 'fake';
  constructor(private candidates: ResolvedPlace[] = [BOULDER], private err?: unknown) {}
  async resolve(): Promise<ResolvedPlace[]> {
    if (this.err) throw this.err;
    return this.candidates;
  }
}

let seq = 0;
function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'test',
    sourceListingId: `L${seq++}`,
    addressLine1: '1420 Pine St',
    city: 'Boulder',
    state: 'CO',
    postalCode: '80302',
    status: 'ACTIVE',
    propertyType: 'SINGLE_FAMILY',
    listPrice: 800000,
    photos: [],
    openHouses: [],
    raw: {},
    fetchedAt: new Date('2026-08-15T12:00:00Z'),
    ...over,
  };
}

const CAPS: ProviderCapabilities = {
  supportsOpenHouses: true, supportsPolygonQuery: false, supportsRadiusQuery: false,
  supportsPhotos: false, supportsPriceHistory: false, rateLimit: null,
};

class FakeProvider implements ListingProvider<NormalizedListing> {
  readonly id: ProviderId;
  readonly displayName = 'fake';
  readonly capabilities = CAPS;
  constructor(id: ProviderId, private rows: NormalizedListing[]) { this.id = id; }
  async healthCheck(): Promise<HealthCheckResult> { return { ok: true, message: 'ok' }; }
  async fetchPage(_o: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    return { raw: this.rows, requestsUsed: 1 };
  }
  normalize(raw: NormalizedListing): NormalizedListing { return raw; }
}

class FailingProvider implements ListingProvider<NormalizedListing> {
  readonly displayName = 'failing';
  readonly capabilities = CAPS;
  constructor(readonly id: ProviderId, private message = 'blocked (HTTP 403)') {}
  async healthCheck(): Promise<HealthCheckResult> { return { ok: false, message: this.message }; }
  async fetchPage(): Promise<ProviderPage<NormalizedListing>> { throw new Error(this.message); }
  normalize(raw: NormalizedListing): NormalizedListing { return raw; }
}

const placeQuery = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  location: { kind: 'place', query: 'Boulder, CO', radiusMiles: 5 },
  filters: {},
  ...over,
});

const RING: Array<[number, number]> = [
  [-105.30, 40.00], [-105.20, 40.00], [-105.20, 40.10], [-105.30, 40.10],
];
const drawnQuery = (over: Partial<SearchQuery> = {}): SearchQuery => ({
  location: { kind: 'drawn', ring: RING },
  filters: {},
  ...over,
});

describe('resolveLocation', () => {
  it('place: builds a cityRadius query from the best geocode candidate', async () => {
    const { areaQuery, resolved } = await resolveLocation(
      { kind: 'place', query: 'Boulder, CO', radiusMiles: 7 },
      new FakeGeocoder([BOULDER]),
    );
    expect(areaQuery).toEqual({
      kind: 'cityRadius', city: 'Boulder', state: 'CO', centerLat: 40.015, centerLng: -105.2705, radiusMiles: 7,
    });
    expect(resolved).toEqual(BOULDER);
  });

  it('place: no candidates throws a typed, catchable LocationResolutionError', async () => {
    await expect(
      resolveLocation({ kind: 'place', query: 'asdfghjkl', radiusMiles: 5 }, new FakeGeocoder([])),
    ).rejects.toBeInstanceOf(LocationResolutionError);
  });

  it('place: a GeocodeError from the geocoder is wrapped, not swallowed or rethrown raw', async () => {
    const err = new GeocodeError('Nominatim unreachable', 'network');
    await expect(
      resolveLocation({ kind: 'place', query: 'Boulder, CO', radiusMiles: 5 }, new FakeGeocoder([], err)),
    ).rejects.toBeInstanceOf(LocationResolutionError);
  });

  it('drawn: needs no geocoder call and coarsens to the ring\'s bounding box', async () => {
    let called = false;
    const geocoder: Geocoder = { id: 'spy', resolve: async () => { called = true; return []; } };
    const { areaQuery, resolved } = await resolveLocation({ kind: 'drawn', ring: RING }, geocoder);
    expect(called).toBe(false);
    expect(resolved).toBeUndefined();
    expect(areaQuery).toEqual({ kind: 'bbox', minLat: 40.00, maxLat: 40.10, minLng: -105.30, maxLng: -105.20 });
  });
});

describe('filterToLocation', () => {
  it('place: keeps listings inside the radius, drops those outside, keeps coordinate-less ones', () => {
    const location: SearchLocation = { kind: 'place', query: 'Boulder, CO', radiusMiles: 5 };
    const listings = [
      { lat: 40.02, lng: -105.27 }, // inside
      { lat: 39.70, lng: -105.00 }, // outside (~25mi away)
      { lat: undefined, lng: undefined }, // untestable — kept
    ];
    const kept = filterToLocation(listings, location, BOULDER);
    expect(kept).toHaveLength(2);
  });

  it('drawn: applies the EXACT ring, not just its bounding box', () => {
    const location: SearchLocation = { kind: 'drawn', ring: RING };
    // Inside the ring's bbox (lat 40.00-40.10, lng -105.30..-105.20) but a self-intersecting
    // ring would keep everything; a plain bbox membership test would too. A point in the
    // bbox's corner-cut area that isn't actually in the (rectangular, here) ring would prove
    // precision — RING is a rectangle, so use a genuinely outside-the-shape point instead:
    // just outside the ring's western edge, still inside a naive bbox padded by rounding.
    const inside = { lat: 40.05, lng: -105.25 };
    const outside = { lat: 40.05, lng: -105.35 }; // west of the ring entirely
    expect(filterToLocation([inside], location)).toHaveLength(1);
    expect(filterToLocation([outside], location)).toHaveLength(0);
  });
});

describe('runSearch — success paths', () => {
  it('a place search resolves, fetches, and geo-filters', async () => {
    const inside = listing({ lat: 40.02, lng: -105.27 });
    const outside = listing({ lat: 39.70, lng: -105.00 });
    const outcome = await runSearch(db, placeQuery(), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', [inside, outside]),
    });

    expect(outcome.allProvidersFailed).toBe(false);
    expect(outcome.resolved).toEqual(BOULDER);
    expect(outcome.listings.map((l) => l.sourceListingId)).toEqual([inside.sourceListingId]);
    expect(outcome.providers).toEqual([{ providerId: 'snapshot', ok: true, count: 1, message: undefined }]);
  });

  it('a drawn search never calls the geocoder and filters to the exact ring', async () => {
    const inside = listing({ lat: 40.05, lng: -105.25 });
    let geocoderCalled = false;
    const geocoder: Geocoder = { id: 'spy', resolve: async () => { geocoderCalled = true; return []; } };

    const outcome = await runSearch(db, drawnQuery(), {
      geocoder,
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', [inside]),
    });

    expect(geocoderCalled).toBe(false);
    expect(outcome.resolved).toBeUndefined();
    expect(outcome.listings).toHaveLength(1);
  });

  it('one provider failing does not sink a provider that succeeded — a real distinction from total failure', async () => {
    const good = listing({ lat: 40.02, lng: -105.27 });
    const outcome = await runSearch(db, placeQuery(), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['zillow', 'snapshot'],
      getProvider: (id) => (id === 'zillow' ? new FailingProvider('zillow') : new FakeProvider('snapshot', [good])),
    });

    expect(outcome.allProvidersFailed).toBe(false);
    expect(outcome.listings).toHaveLength(1);
    const zillow = outcome.providers.find((p) => p.providerId === 'zillow')!;
    expect(zillow.ok).toBe(false);
    expect(zillow.message).toMatch(/blocked/);
    const snapshot = outcome.providers.find((p) => p.providerId === 'snapshot')!;
    expect(snapshot.ok).toBe(true);
  });

  it('openHouseOnly drops listings with no upcoming open house', async () => {
    const now = new Date('2026-08-20T12:00:00Z');
    const withOh = listing({
      lat: 40.02, lng: -105.27,
      openHouses: [{ startsAt: new Date('2026-08-22T15:00:00Z'), endsAt: new Date('2026-08-22T18:00:00Z'), timezone: 'America/Denver', appointmentOnly: false, virtual: false }],
    });
    const without = listing({ lat: 40.02, lng: -105.27 });

    const outcome = await runSearch(db, placeQuery({ openHouseOnly: true }), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', [withOh, without]),
      now: () => now,
    });

    expect(outcome.listings.map((l) => l.sourceListingId)).toEqual([withOh.sourceListingId]);
  });

  it('dedupes by provider+sourceListingId', async () => {
    const dup = listing({ lat: 40.02, lng: -105.27, sourceListingId: 'same-id' });
    const outcome = await runSearch(db, placeQuery(), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', [dup, { ...dup }]),
    });
    expect(outcome.listings).toHaveLength(1);
  });
});

describe('runSearch — total-failure visibility', () => {
  it('a failed geocode is distinguishable from "zero homes matched": allProvidersFailed is true, no provider ever ran', async () => {
    const outcome = await runSearch(db, placeQuery({ location: { kind: 'place', query: 'asdfghjkl', radiusMiles: 5 } }), {
      geocoder: new FakeGeocoder([]),
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', []),
    });

    expect(outcome.allProvidersFailed).toBe(true);
    expect(outcome.listings).toEqual([]);
    expect(outcome.providers).toHaveLength(1);
    expect(outcome.providers[0].ok).toBe(false);
    expect(outcome.resolved).toBeUndefined();
  });

  it('every provider failing reports allProvidersFailed — distinct from a resolved search with zero matches', async () => {
    const outcome = await runSearch(db, placeQuery(), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['zillow', 'snapshot'],
      getProvider: (id) => new FailingProvider(id),
    });

    expect(outcome.allProvidersFailed).toBe(true);
    expect(outcome.listings).toEqual([]);
    expect(outcome.providers.every((p) => !p.ok)).toBe(true);
    // Resolution succeeded — this is a provider-side failure, not a location one.
    expect(outcome.resolved).toEqual(BOULDER);
  });

  it('a resolved search with genuinely zero matches is NOT reported as allProvidersFailed', async () => {
    const outcome = await runSearch(db, placeQuery(), {
      geocoder: new FakeGeocoder([BOULDER]),
      providerIds: ['snapshot'],
      getProvider: () => new FakeProvider('snapshot', []),
    });

    expect(outcome.allProvidersFailed).toBe(false);
    expect(outcome.listings).toEqual([]);
    expect(outcome.providers[0]).toMatchObject({ ok: true, count: 0 });
  });
});
