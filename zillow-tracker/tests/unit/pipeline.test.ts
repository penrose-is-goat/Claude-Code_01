import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { SnapshotProvider } from '@/lib/providers/snapshot';
import { pollSearch, type SearchSpec } from '@/lib/ingest/pipeline';
import type { NormalizedListing } from '@/lib/providers/normalized';
import type { FetchOptions, ListingProvider, ProviderPage } from '@/lib/providers/types';

/**
 * End-to-end against a real SQLite file, using the REAL captured Boulder snapshot in
 * data/snapshots/ — actual addresses, prices and specs from public listing pages, not
 * invented rows.
 *
 * Where a test needs a second observation of the same home (to exercise change
 * detection), it says so explicitly and states what it is varying. That is the pipeline's
 * contract under test — "given these two observations, what does it record" — not a claim
 * that the second observation was captured.
 */

let dir: string;
let db: PrismaClient;
const SEARCH_ID = 'search-boulder';

// A cityRadius query, standing in for what a real "Boulder, CO within 5mi" search
// resolves to. It does NOT actually narrow this suite's data — see "area filtering"
// below for why — but it is what a real place search produces, so tests exercise the
// same AreaQuery shape production code does rather than an arbitrary placeholder.
const area: SearchSpec = {
  id: SEARCH_ID,
  name: 'Boulder, CO · 5mi',
  query: { kind: 'cityRadius', city: 'Boulder', state: 'CO', centerLat: 40.015, centerLng: -105.2705, radiusMiles: 5 },
};

/** Replays an explicit set of observations, so a test controls exactly what the source reports. */
class Replay implements ListingProvider<NormalizedListing> {
  readonly id = 'snapshot' as const;
  readonly displayName = 'replay';
  readonly capabilities = {
    supportsOpenHouses: false, supportsPolygonQuery: false, supportsRadiusQuery: false,
    supportsPhotos: false, supportsPriceHistory: false,
    rateLimit: null,
  };
  constructor(private rows: NormalizedListing[]) {}
  async healthCheck() { return { ok: true, message: 'replay' }; }
  async fetchPage(_o: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    return { raw: this.rows, requestsUsed: 0 };
  }
  normalize(raw: NormalizedListing) { return raw; }
}

let real: NormalizedListing[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: url }, cwd: process.cwd(), stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  await db.savedSearch.create({
    data: {
      id: SEARCH_ID, name: area.name,
      query: JSON.stringify({ location: { kind: 'place', query: 'Boulder, CO', radiusMiles: 5 }, filters: {} }),
    },
  });

  // The provider returns every real capture; nothing here narrows it further. Real
  // captured listings carry no coordinates (Zillow's search pages never publish them —
  // see snapshot/index.ts), so under the documented "cannot test it, keep it" policy a
  // geometric area query, whatever its shape, keeps every one of them. `real` is
  // therefore simply everything on disk, not a ZIP- or radius-filtered subset of it.
  const { raw } = await new SnapshotProvider().fetchPage({ area: area.query });
  real = raw;
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingesting the real captured snapshot', () => {
  // Counts are derived from the captures on disk rather than hardcoded, so adding a new
  // capture does not falsify a test that is still describing correct behaviour.
  it('loads every captured listing', async () => {
    const result = await pollSearch(db, new SnapshotProvider(), area);
    expect(result.status).toBe('SUCCESS');
    expect(real.length).toBeGreaterThan(0);
    expect(result.listingsSeen).toBe(real.length);
    expect(result.listingsNew).toBe(real.length);
    expect(await db.listing.count()).toBe(real.length);
  });

  it('keeps the real prices intact, including the one with no published price', async () => {
    const expectedPriced = real.filter((l) => l.listPrice != null).length;
    const priced = await db.listing.findMany({ where: { listPrice: { not: null } } });
    expect(priced).toHaveLength(expectedPriced);

    const cheapest = await db.listing.findFirstOrThrow({ where: { listPrice: 249000 } });
    expect(cheapest.addressLine1).toBe('3000 Colorado Ave Unit H231');

    // 950 34th St really was listed without a visible price. It must survive ingestion
    // rather than being dropped or defaulted to zero.
    const noPrice = await db.listing.findFirstOrThrow({ where: { addressLine1: '950 34th St' } });
    expect(noPrice.listPrice).toBeNull();
    expect(noPrice.beds).toBe(5);
  });

  it('does not invent coordinates the source never published', async () => {
    const withCoords = await db.listing.count({ where: { NOT: { lat: null } } });
    expect(withCoords).toBe(0);
  });

  it('carries the real open-house windows captured from Zillow', async () => {
    const expected = real.reduce((n, l) => n + l.openHouses.length, 0);
    expect(expected).toBeGreaterThan(0);
    expect(await db.openHouse.count()).toBe(expected);

    // A specific one, to prove the local-time conversion lands on the right instant:
    // 1343 Alpine Avenue is open Sat 9am–1pm Boulder time.
    const alpine = await db.listing.findFirst({ where: { addressLine1: '1343 Alpine Avenue' } });
    if (alpine) {
      const oh = await db.openHouse.findFirstOrThrow({ where: { listingId: alpine.id } });
      const hour = Number(oh.startsAt.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Denver' }));
      expect(hour).toBe(9);
    }
  });

  it('deep-links every listing back to Zillow rather than replacing it', async () => {
    const listings = await db.listing.findMany();
    expect(listings.every((l) => l.listingUrl?.startsWith('https://www.zillow.com/'))).toBe(true);
  });

  it('announces each listing exactly once', async () => {
    const events = await db.listingEvent.findMany({ where: { type: 'NEW_LISTING' } });
    expect(events).toHaveLength(real.length);
  });
});

describe('re-polling identical data', () => {
  it('produces no events at all — the false-positive guard that matters most', async () => {
    const before = await db.listingEvent.count();
    const result = await pollSearch(db, new SnapshotProvider(), area);

    expect(result.listingsNew).toBe(0);
    expect(result.eventsCreated).toBe(0);
    expect(result.delisted).toBe(0);
    expect(await db.listingEvent.count()).toBe(before);
  });

  it('writes no extra snapshots (the contentHash gate)', async () => {
    const before = await db.listingSnapshot.count();
    await pollSearch(db, new SnapshotProvider(), area);
    expect(await db.listingSnapshot.count()).toBe(before);
  });
});

describe('change detection over two observations of the same real home', () => {
  // Varying ONE field of a real listing and re-observing it is the pipeline's contract:
  // "given these two observations, what do you record". The home is real; the second
  // observation is the scenario being tested.
  const observedWith = (id: string, patch: Partial<NormalizedListing>) =>
    real.map((l) => (l.sourceListingId === id ? { ...l, ...patch } : l));

  it('records a price cut with the correct delta', async () => {
    const target = '80304-4072-crystal-ct'; // really listed at $789,000
    const result = await pollSearch(db, new Replay(observedWith(target, { listPrice: 749000 })), area);
    expect(result.eventsCreated).toBeGreaterThan(0);

    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    const evt = await db.listingEvent.findFirstOrThrow({
      where: { listingId: listing.id, type: 'PRICE_CHANGE' }, orderBy: { occurredAt: 'desc' },
    });
    expect(evt.deltaAbs).toBe(749000 - 789000);
    expect(listing.listPrice).toBe(749000);
  });

  it('records a status change and then a return to market', async () => {
    const target = '80302-39-spring-ln';
    await pollSearch(db, new Replay(observedWith(target, { status: 'PENDING' })), area);
    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    expect(listing.status).toBe('PENDING');

    await pollSearch(db, new Replay(observedWith(target, { status: 'ACTIVE' })), area);
    const back = await db.listingEvent.findFirst({
      where: { listingId: listing.id, type: 'BACK_ON_MARKET' },
    });
    expect(back).not.toBeNull();
  });
});

describe('absence handling when the source returns fewer rows', () => {
  it('needs two consecutive trustworthy runs before calling anything delisted', async () => {
    const target = '80303-181-pawnee-dr';
    const without = real.filter((l) => l.sourceListingId !== target);

    const first = await pollSearch(db, new Replay(without), area);
    expect(first.delisted).toBe(0);

    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    const link = await db.listingSearch.findFirstOrThrow({ where: { listingId: listing.id, searchId: SEARCH_ID } });
    expect(link.missedRunCount).toBe(1);
    expect(listing.removedAt).toBeNull();

    const second = await pollSearch(db, new Replay(without), area);
    expect(second.delisted).toBe(1);

    const gone = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    expect(gone.removedAt).not.toBeNull();
  });
});

describe('area filtering against the real capture', () => {
  // There is no ZIP/postal-code AreaQuery any more (the user chose city+radius or a
  // drawn shape, never a ZIP — see providers/types.ts). Every remaining AreaQuery kind
  // is geometric, and Zillow's real search pages never publish coordinates (confirmed
  // above: "does not invent coordinates"), so a real capture cannot be geometrically
  // narrowed at all — every geometry keeps every listing under the documented
  // "cannot test it, keep it" policy. That is the honest, current behaviour for real
  // data, not a gap: it's the same tradeoff geo.test.ts and geo-adversarial.test.ts
  // exercise directly with synthetic coordinates, observed here end-to-end.
  it('keeps every real listing regardless of which geometry is used, because none carry coordinates', async () => {
    const narrow: SearchSpec = {
      id: SEARCH_ID, name: 'a tiny bbox nowhere near Boulder',
      query: { kind: 'bbox', minLat: 0, maxLat: 0.001, minLng: 0, maxLng: 0.001 },
    };
    const result = await pollSearch(db, new SnapshotProvider(), narrow);
    expect(result.listingsSeen).toBe(real.length);
  });

  it('gives every real address a distinct identity key', async () => {
    const listings = await db.listing.findMany();
    expect(new Set(listings.map((l) => l.addressKey)).size).toBe(listings.length);
  });
});
