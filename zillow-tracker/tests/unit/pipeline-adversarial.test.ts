import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { pollArea, type AreaSpec } from '@/lib/ingest/pipeline';
import type { NormalizedListing, NormalizedOpenHouse } from '@/lib/providers/normalized';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '@/lib/providers/types';

/**
 * Adversarial pipeline probes against a real SQLite file.
 *
 * Each `BUG:` test asserts the behaviour a correct pipeline would have and fails today.
 */

let dir: string;
let db: PrismaClient;

const AREA_A = 'adv-area-a';
const AREA_B = 'adv-area-b';

const areaA: AreaSpec = { id: AREA_A, name: 'A', query: { kind: 'postalCodes', codes: ['80302'] } };
const areaB: AreaSpec = { id: AREA_B, name: 'B', query: { kind: 'postalCodes', codes: ['80302'] } };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-adv-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: url }, cwd: process.cwd(), stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  await db.area.create({ data: { id: AREA_A, name: 'A', kind: 'POSTAL_CODES', postalCodes: JSON.stringify(['80302']) } });
  await db.area.create({ data: { id: AREA_B, name: 'B', kind: 'POSTAL_CODES', postalCodes: JSON.stringify(['80302']) } });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

/** Wipe listing-side state between scenarios; areas stay. */
beforeEach(async () => {
  await db.listingEvent.deleteMany();
  await db.listingSnapshot.deleteMany();
  await db.openHouse.deleteMany();
  await db.listingArea.deleteMany();
  await db.savedListing.deleteMany();
  await db.listing.deleteMany();
  await db.pollRun.deleteMany();
});

let seq = 0;
function mk(over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'mock',
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

const POISON = Symbol.for('poison');

class TestProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'mock' as const;
  readonly displayName = 'Test';
  readonly capabilities: ProviderCapabilities = {
    supportsOpenHouses: true, supportsPolygonQuery: true, supportsRadiusQuery: true,
    supportsPostalCodeQuery: true, supportsPhotos: true, supportsPriceHistory: false,
    rateLimit: null,
  };
  constructor(public batch: NormalizedListing[]) {}
  async healthCheck(): Promise<HealthCheckResult> { return { ok: true, message: 'ok' }; }
  async fetchPage(_o: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    return { raw: this.batch, requestsUsed: 1 };
  }
  normalize(raw: NormalizedListing): NormalizedListing {
    if ((raw as any)[POISON]) throw new Error('unparseable row');
    return { ...raw, photos: [...raw.photos], openHouses: [...raw.openHouses] };
  }
}

const oh = (over: Partial<NormalizedOpenHouse> = {}): NormalizedOpenHouse => ({
  startsAt: new Date(Date.now() + 3 * 864e5),
  endsAt: new Date(Date.now() + 3 * 864e5 + 2 * 36e5),
  timezone: 'America/Denver', appointmentOnly: false, virtual: false, ...over,
});

const eventsFor = async (sourceListingId: string) => {
  const l = await db.listing.findFirstOrThrow({ where: { sourceListingId } });
  return (await db.listingEvent.findMany({ where: { listingId: l.id }, orderBy: { occurredAt: 'asc' } }))
    .map((e) => e.type);
};

// ---------------------------------------------------------------------------
// P1 — no transaction around upsertListing. The row's contentHash is written
// BEFORE the snapshot and the events, so a crash in between loses the events
// forever: the next run sees a matching hash and takes the fast path.
// ---------------------------------------------------------------------------
describe('P1 a crash mid-upsert permanently swallows the events', () => {
  it('a crash mid-upsert rolls back, so the price drop survives to the retry', async () => {
    const l = mk({ sourceListingId: 'crash-1', listPrice: 800000 });
    await pollArea(db, new TestProvider([l]), areaA);

    const dropped = { ...l, listPrice: 700000 };
    let armed = true;

    // Fault injection now targets the TRANSACTION, because that is where the writes
    // live. The listing row and its events are committed together or not at all.
    const flaky = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === '$transaction' && armed) {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              armed = false;
              const sabotaged = new Proxy(tx as object, {
                get(t, k, r) {
                  if (k === 'listingSnapshot') {
                    return { create: async () => { throw new Error('disk full'); } };
                  }
                  return Reflect.get(t, k, r);
                },
              });
              return fn(sabotaged);
            });
        }
        return Reflect.get(target, prop, recv);
      },
    }) as PrismaClient;

    const failed = await pollArea(flaky, new TestProvider([dropped]), areaA);
    expect(failed.status).toBe('FAILED');

    // The row must NOT carry the new price, because the event that explains it was
    // never written. Advancing one without the other is what made the drop unrecoverable:
    // the contentHash fast path would match forever after.
    const mid = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'crash-1' } });
    expect(mid.listPrice).toBe(800000);

    // Retry on a healthy client — the user still gets told.
    await pollArea(db, new TestProvider([dropped]), areaA);
    expect(await eventsFor('crash-1')).toContain('PRICE_CHANGE');
    const after = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'crash-1' } });
    expect(after.listPrice).toBe(700000);
  });
});

// ---------------------------------------------------------------------------
// P2 — pollArea hardcodes RunContext.status: 'SUCCESS' even when rows failed to
// normalize, so absence.ts's "never evict on a PARTIAL run" rule is bypassed by
// the one caller it exists for.
// ---------------------------------------------------------------------------
describe('P2 a PARTIAL run still evicts listings', () => {
  it('BUG: rows that failed to PARSE are delisted as if they had left the market', async () => {
    const good = Array.from({ length: 8 }, (_, i) => mk({ sourceListingId: `p2-good-${i}` }));
    const iffy = Array.from({ length: 2 }, (_, i) => mk({ sourceListingId: `p2-iffy-${i}` }));
    await pollArea(db, new TestProvider([...good, ...iffy]), areaA);

    // From now on the provider emits those 2 rows in a shape normalize() rejects.
    const poisoned = iffy.map((l) => ({ ...l, [POISON]: true })) as NormalizedListing[];
    const r2 = await pollArea(db, new TestProvider([...good, ...poisoned]), areaA);
    const r3 = await pollArea(db, new TestProvider([...good, ...poisoned]), areaA);

    expect(r2.status).toBe('PARTIAL');
    expect(r3.status).toBe('PARTIAL');
    // absence.ts: "if (run.status !== 'SUCCESS') return false" — a PARTIAL run must not
    // be allowed to conclude anything is gone. pollArea never tells it the run is partial.
    expect(r2.delisted + r3.delisted).toBe(0);
    expect(await db.listing.count({ where: { removedAt: { not: null } } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P3 — missedRunCount/removedAt live on the Listing row, but absence is decided
// per area. Two areas holding the same listing fight over one counter.
// ---------------------------------------------------------------------------
describe('P3 absence is decided per area but stored per listing', () => {
  it('area B stops showing a listing it can no longer see, even while area A still can', async () => {
    const shared = mk({ sourceListingId: 'p3-shared' });
    const bOnly = Array.from({ length: 5 }, (_, i) => mk({ sourceListingId: `p3-b-${i}` }));

    await pollArea(db, new TestProvider([shared, ...bOnly]), areaA);
    await pollArea(db, new TestProvider([shared, ...bOnly]), areaB);

    for (let i = 0; i < 3; i++) {
      await pollArea(db, new TestProvider([shared, ...bOnly]), areaA);
      await pollArea(db, new TestProvider([...bOnly]), areaB);
    }

    // Absence is now recorded per AREA, so A's polls no longer reset B's counter.
    const linkB = await db.listingArea.findFirstOrThrow({
      where: { areaId: AREA_B, listing: { sourceListingId: 'p3-shared' } },
    });
    expect(linkB.absentSince).not.toBeNull();

    // ...and area B's own view honours it.
    const visibleInB = await db.listing.findMany({
      where: { areas: { some: { areaId: AREA_B, absentSince: null } } },
    });
    expect(visibleInB.map((l) => l.sourceListingId)).not.toContain('p3-shared');

    // Area A still sees it, so it is NOT globally delisted — that would hide a listing
    // that one of your areas can still legitimately offer you.
    const linkA = await db.listingArea.findFirstOrThrow({
      where: { areaId: AREA_A, listing: { sourceListingId: 'p3-shared' } },
    });
    expect(linkA.absentSince).toBeNull();
    const listing = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'p3-shared' } });
    expect(listing.removedAt).toBeNull();
  });

  it('BUG: when area B polls more often than area A it delists a listing A sees as ACTIVE', async () => {
    const shared = mk({ sourceListingId: 'p3b-shared' });
    const bOnly = Array.from({ length: 5 }, (_, i) => mk({ sourceListingId: `p3b-b-${i}` }));

    await pollArea(db, new TestProvider([shared, ...bOnly]), areaA);
    await pollArea(db, new TestProvider([shared, ...bOnly]), areaB);

    // Areas carry their own pollCron. B runs twice inside one of A's intervals.
    await pollArea(db, new TestProvider([...bOnly]), areaB);
    await pollArea(db, new TestProvider([...bOnly]), areaB);

    const row = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'p3b-shared' } });
    // missedRunCount and removedAt live on the Listing row, not on ListingArea, so area
    // B's verdict removes the listing from area A's view too — and from favourites lists,
    // the open-house page and the default query, all of which filter removedAt: null.
    expect(row.removedAt).toBeNull();
    expect(await eventsFor('p3b-shared')).not.toContain('DELISTED');

    // ...and the next poll of area A silently un-removes it, leaving an unretracted
    // "No longer listed" entry in the event feed and the Excel history sheet.
    await pollArea(db, new TestProvider([shared, ...bOnly]), areaA);
    const after = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'p3b-shared' } });
    expect(after.removedAt).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// P4 — a delisted listing that comes back with unchanged content produces no
// event at all, because the contentHash fast path runs before anything else.
// ---------------------------------------------------------------------------
describe('P4 resurrection is silent', () => {
  it('BUG: a DELISTED listing that returns unchanged emits nothing and just reappears', async () => {
    const others = Array.from({ length: 9 }, (_, i) => mk({ sourceListingId: `p4-o-${i}` }));
    const target = mk({ sourceListingId: 'p4-target' });

    await pollArea(db, new TestProvider([target, ...others]), areaA);
    await pollArea(db, new TestProvider([...others]), areaA);
    await pollArea(db, new TestProvider([...others]), areaA);
    expect(await eventsFor('p4-target')).toContain('DELISTED');

    // It comes back a day later, same price, same everything.
    await pollArea(db, new TestProvider([target, ...others]), areaA);
    const row = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'p4-target' } });
    expect(row.removedAt).toBeNull(); // it is silently un-removed...

    const evts = await eventsFor('p4-target');
    // ...but the feed never says so. A home that left and came back is precisely the
    // signal this app exists to catch, and the user is told nothing.
    expect(evts.filter((t) => t !== 'NEW_LISTING' && t !== 'DELISTED').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P5 — cancelled open houses stay in the prior state forever.
// ---------------------------------------------------------------------------
describe('P5 open-house cancellation repeats', () => {
  it('BUG: OPEN_HOUSE_CANCELLED is re-emitted on every later change to the listing', async () => {
    const withOh = mk({ sourceListingId: 'p5', openHouses: [oh()] });
    await pollArea(db, new TestProvider([withOh]), areaA);

    const noOh = { ...withOh, openHouses: [] };
    await pollArea(db, new TestProvider([noOh]), areaA);
    expect(await eventsFor('p5')).toContain('OPEN_HOUSE_CANCELLED');

    // Any later change re-runs the diff, and upsertListing's `prior` is built from
    // `include: { openHouses: true }` — which still contains the cancelled row.
    await pollArea(db, new TestProvider([{ ...noOh, listPrice: 750000 }]), areaA);
    await pollArea(db, new TestProvider([{ ...noOh, listPrice: 740000 }]), areaA);

    const cancels = (await eventsFor('p5')).filter((t) => t === 'OPEN_HOUSE_CANCELLED');
    expect(cancels).toHaveLength(1);
  });

  it('BUG: an open house that is reinstated produces no OPEN_HOUSE_ADDED', async () => {
    const o = oh();
    const withOh = mk({ sourceListingId: 'p5b', openHouses: [o] });
    await pollArea(db, new TestProvider([withOh]), areaA);
    await pollArea(db, new TestProvider([{ ...withOh, openHouses: [] }]), areaA);
    await pollArea(db, new TestProvider([withOh]), areaA);

    const stored = await db.openHouse.findFirstOrThrow({});
    expect(stored.cancelledAt).toBeNull(); // correctly un-cancelled in the DB
    const added = (await eventsFor('p5b')).filter((t) => t === 'OPEN_HOUSE_ADDED');
    expect(added).toHaveLength(2); // announced once when first seen, once when reinstated
  });
});

// ---------------------------------------------------------------------------
// P6 — syncOpenHouses' update branch omits timezone and note.
// ---------------------------------------------------------------------------
describe('P6 open-house timezone is write-once', () => {
  it('BUG: a corrected timezone never reaches the row, even on the slow path', async () => {
    const o = oh({ timezone: 'America/Denver' });
    const l = mk({ sourceListingId: 'p6', openHouses: [o] });
    await pollArea(db, new TestProvider([l]), areaA);

    // Provider corrects the zone AND drops the price, so the contentHash definitely moves
    // and the full update path runs.
    await pollArea(db, new TestProvider([
      { ...l, listPrice: 700000, openHouses: [{ ...o, timezone: 'America/New_York' }] },
    ]), areaA);

    const stored = await db.openHouse.findFirstOrThrow({});
    expect(stored.timezone).toBe('America/New_York');
  });
});

// ---------------------------------------------------------------------------
// P7 — the same write-once problem for the listing's own columns.
// ---------------------------------------------------------------------------
describe('P7 address and coordinates are write-once', () => {
  it('BUG: a corrected address/geocode is never persisted (contentHash ignores them)', async () => {
    const l = mk({ sourceListingId: 'p7', addressLine1: '1420 Pne St', lat: 0, lng: 0 });
    await pollArea(db, new TestProvider([l]), areaA);

    await pollArea(db, new TestProvider([
      { ...l, addressLine1: '1420 Pine St', lat: 40.019, lng: -105.27 },
    ]), areaA);

    const row = await db.listing.findFirstOrThrow({ where: { sourceListingId: 'p7' } });
    expect(row.addressLine1).toBe('1420 Pine St');
    expect(row.lat).toBeCloseTo(40.019, 3);
  });
});

// ---------------------------------------------------------------------------
// P8 — query volume.
// ---------------------------------------------------------------------------
describe('P8 per-listing round trips', () => {
  it('measures the N+1 shape of a steady-state poll', async () => {
    const batch = Array.from({ length: 40 }, (_, i) => mk({ sourceListingId: `p8-${i}` }));
    await pollArea(db, new TestProvider(batch), areaA);

    let queries = 0;
    const counting = new PrismaClient({
      datasources: { db: { url: `file:${join(dir, 'test.db')}` } },
      log: [{ emit: 'event', level: 'query' }],
    });
    (counting as any).$on('query', () => { queries++; });
    await pollArea(counting, new TestProvider(batch), areaA);
    await counting.$disconnect();

    console.log(`steady-state poll of 40 unchanged listings issued ${queries} SQL statements`);
    // Nothing changed; a set-based implementation needs a handful of statements.
    expect(queries).toBeLessThan(40);
  });
});
