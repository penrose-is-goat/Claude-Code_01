import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { SnapshotProvider } from '@/lib/providers/snapshot';
import { pollArea, type AreaSpec } from '@/lib/ingest/pipeline';
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
const AREA_ID = 'area-boulder';

const area: AreaSpec = {
  id: AREA_ID,
  name: 'Boulder',
  query: { kind: 'postalCodes', codes: ['80302', '80303', '80304'] },
};

/** Replays an explicit set of observations, so a test controls exactly what the source reports. */
class Replay implements ListingProvider<NormalizedListing> {
  readonly id = 'snapshot' as const;
  readonly displayName = 'replay';
  readonly capabilities = {
    supportsOpenHouses: false, supportsPolygonQuery: false, supportsRadiusQuery: false,
    supportsPostalCodeQuery: true, supportsPhotos: false, supportsPriceHistory: false,
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
  await db.area.create({
    data: { id: AREA_ID, name: 'Boulder', kind: 'POSTAL_CODES', postalCodes: JSON.stringify(['80302', '80303', '80304']) },
  });

  const { raw } = await new SnapshotProvider().fetchPage({ area: area.query });
  real = raw;
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('ingesting the real captured snapshot', () => {
  it('loads every captured listing', async () => {
    const result = await pollArea(db, new SnapshotProvider(), area);
    expect(result.status).toBe('SUCCESS');
    expect(result.listingsSeen).toBe(16);
    expect(result.listingsNew).toBe(16);
    expect(await db.listing.count()).toBe(16);
  });

  it('keeps the real prices intact, including the one with no published price', async () => {
    const priced = await db.listing.findMany({ where: { listPrice: { not: null } } });
    expect(priced).toHaveLength(15);

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

  it('does not invent open houses', async () => {
    expect(await db.openHouse.count()).toBe(0);
  });

  it('announces each listing exactly once', async () => {
    const events = await db.listingEvent.findMany({ where: { type: 'NEW_LISTING' } });
    expect(events).toHaveLength(16);
  });
});

describe('re-polling identical data', () => {
  it('produces no events at all — the false-positive guard that matters most', async () => {
    const before = await db.listingEvent.count();
    const result = await pollArea(db, new SnapshotProvider(), area);

    expect(result.listingsNew).toBe(0);
    expect(result.eventsCreated).toBe(0);
    expect(result.delisted).toBe(0);
    expect(await db.listingEvent.count()).toBe(before);
  });

  it('writes no extra snapshots (the contentHash gate)', async () => {
    const before = await db.listingSnapshot.count();
    await pollArea(db, new SnapshotProvider(), area);
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
    const result = await pollArea(db, new Replay(observedWith(target, { listPrice: 749000 })), area);
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
    await pollArea(db, new Replay(observedWith(target, { status: 'PENDING' })), area);
    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    expect(listing.status).toBe('PENDING');

    await pollArea(db, new Replay(observedWith(target, { status: 'ACTIVE' })), area);
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

    const first = await pollArea(db, new Replay(without), area);
    expect(first.delisted).toBe(0);

    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    const link = await db.listingArea.findFirstOrThrow({ where: { listingId: listing.id, areaId: AREA_ID } });
    expect(link.missedRunCount).toBe(1);
    expect(listing.removedAt).toBeNull();

    const second = await pollArea(db, new Replay(without), area);
    expect(second.delisted).toBe(1);

    const gone = await db.listing.findFirstOrThrow({ where: { sourceListingId: target } });
    expect(gone.removedAt).not.toBeNull();
  });
});

describe('area filtering against real ZIP codes', () => {
  it('narrows to a single real ZIP', async () => {
    const narrow: AreaSpec = { id: AREA_ID, name: '80304 only', query: { kind: 'postalCodes', codes: ['80304'] } };
    const result = await pollArea(db, new SnapshotProvider(), narrow);
    expect(result.listingsSeen).toBe(8);
  });

  it('gives every real address a distinct identity key', async () => {
    const listings = await db.listing.findMany();
    expect(new Set(listings.map((l) => l.addressKey)).size).toBe(listings.length);
  });
});
