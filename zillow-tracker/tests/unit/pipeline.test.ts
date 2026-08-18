import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { MockProvider } from '@/lib/providers/mock';
import { pollArea, type AreaSpec } from '@/lib/ingest/pipeline';

/**
 * End-to-end against a real SQLite file: provider -> geofilter -> upsert -> diff ->
 * events -> absence. This is the test that would actually catch a regression in how the
 * pieces fit together, as opposed to how each behaves alone.
 */

let dir: string;
let db: PrismaClient;
const AREA_ID = 'area-test';

const area: AreaSpec = {
  id: AREA_ID,
  name: 'Boulder',
  query: { kind: 'postalCodes', codes: ['80301', '80302', '80303', '80304'] },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: url },
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });
  await db.area.create({ data: { id: AREA_ID, name: 'Boulder', kind: 'POSTAL_CODES', postalCodes: JSON.stringify(area.query) } });
});

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const eventTypes = async (runId: string) =>
  (await db.listingEvent.findMany({ where: { pollRunId: runId } })).map((e) => e.type);

describe('pipeline — run 1 (baseline)', () => {
  it('ingests every listing and calls them all new', async () => {
    const provider = new MockProvider(0);
    const result = await pollArea(db, provider, area);

    expect(result.status).toBe('SUCCESS');
    expect(result.listingsSeen).toBe(8);
    expect(result.listingsNew).toBe(8);
    expect(await db.listing.count()).toBe(8);
  });

  it('emits NEW_LISTING for each, plus the pre-attached open houses', async () => {
    const run = await db.pollRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    const types = await eventTypes(run.id);
    expect(types.filter((t) => t === 'NEW_LISTING')).toHaveLength(8);
    expect(types.filter((t) => t === 'OPEN_HOUSE_ADDED')).toHaveLength(2);
  });

  it('stores open houses as queryable rows', async () => {
    expect(await db.openHouse.count()).toBe(2);
  });

  it('writes one snapshot per listing', async () => {
    expect(await db.listingSnapshot.count()).toBe(8);
  });
});

describe('pipeline — re-poll with no changes', () => {
  it('writes no new snapshots or events (the contentHash gate)', async () => {
    const snapshotsBefore = await db.listingSnapshot.count();
    const eventsBefore = await db.listingEvent.count();

    const provider = new MockProvider(0);
    const result = await pollArea(db, provider, area);

    expect(result.listingsNew).toBe(0);
    expect(result.eventsCreated).toBe(0);
    expect(await db.listingSnapshot.count()).toBe(snapshotsBefore);
    expect(await db.listingEvent.count()).toBe(eventsBefore);
  });

  it('still advances lastSeenAt', async () => {
    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2001' } });
    expect(l.lastSeenAt.getTime()).toBeGreaterThanOrEqual(l.firstSeenAt.getTime());
  });
});

describe('pipeline — run 2 (the interesting one)', () => {
  let runId: string;

  it('picks up the two new listings', async () => {
    const provider = new MockProvider(1);
    const result = await pollArea(db, provider, area);
    runId = result.runId;

    expect(result.listingsSeen).toBe(10);
    expect(result.listingsNew).toBe(2);
    expect(await db.listing.count()).toBe(10);
  });

  it('detects exactly the three price drops and one increase', async () => {
    const priceEvents = await db.listingEvent.findMany({ where: { pollRunId: runId, type: 'PRICE_CHANGE' } });
    expect(priceEvents).toHaveLength(4);

    const drops = priceEvents.filter((e) => (e.deltaAbs ?? 0) < 0);
    const rises = priceEvents.filter((e) => (e.deltaAbs ?? 0) > 0);
    expect(drops).toHaveLength(3);
    expect(rises).toHaveLength(1);
  });

  it('records the price delta accurately', async () => {
    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2001' } });
    const evt = await db.listingEvent.findFirstOrThrow({
      where: { listingId: l.id, type: 'PRICE_CHANGE', pollRunId: runId },
    });
    expect(evt.deltaAbs).toBe(849000 - 875000);
    expect(l.listPrice).toBe(849000);
  });

  it('detects the status change to pending', async () => {
    const statusEvents = await db.listingEvent.findMany({ where: { pollRunId: runId, type: 'STATUS_CHANGE' } });
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].newValue).toBe('PENDING');
  });

  it('detects the newly announced open houses', async () => {
    const added = await db.listingEvent.findMany({ where: { pollRunId: runId, type: 'OPEN_HOUSE_ADDED' } });
    // 2004 gains one, 2007 gains one, and new listing 2010 arrives with one.
    expect(added).toHaveLength(3);
  });

  it('detects added photos', async () => {
    const photos = await db.listingEvent.findMany({ where: { pollRunId: runId, type: 'PHOTOS_ADDED' } });
    expect(photos).toHaveLength(1);
  });

  it('appends snapshots only for listings that actually changed', async () => {
    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2001' } });
    expect(await db.listingSnapshot.count({ where: { listingId: l.id } })).toBe(2);
  });
});

describe('pipeline — run 3 (endings)', () => {
  let runId: string;

  it('completes successfully', async () => {
    const provider = new MockProvider(2);
    const result = await pollArea(db, provider, area);
    runId = result.runId;
    expect(result.status).toBe('SUCCESS');
    expect(result.listingsSeen).toBe(9); // 2007 is absent
  });

  it('detects back-on-market — the highest-value signal in the app', async () => {
    const back = await db.listingEvent.findMany({ where: { pollRunId: runId, type: 'BACK_ON_MARKET' } });
    expect(back).toHaveLength(1);

    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2003' } });
    expect(l.status).toBe('ACTIVE');
  });

  it('detects the sale', async () => {
    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2001' } });
    expect(l.status).toBe('SOLD');
  });

  it('cancels the open house that disappeared', async () => {
    const cancelled = await db.openHouse.findMany({ where: { cancelledAt: { not: null } } });
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT delist the absent listing on its first miss', async () => {
    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2007' } });
    expect(l.missedRunCount).toBe(1);
    expect(l.removedAt).toBeNull();
  });

  it('delists it on the second consecutive miss', async () => {
    const provider = new MockProvider(2);
    const result = await pollArea(db, provider, area);
    expect(result.delisted).toBe(1);

    const l = await db.listing.findFirstOrThrow({ where: { sourceListingId: '2007' } });
    expect(l.missedRunCount).toBe(2);
    expect(l.removedAt).not.toBeNull();

    const evt = await db.listingEvent.findFirst({ where: { listingId: l.id, type: 'DELISTED' } });
    expect(evt).not.toBeNull();
  });
});

describe('pipeline — cross-cutting guarantees', () => {
  it('gives every listing a stable addressKey for cross-provider identity', async () => {
    const listings = await db.listing.findMany();
    expect(listings.every((l) => l.addressKey.length === 40)).toBe(true);
    expect(new Set(listings.map((l) => l.addressKey)).size).toBe(listings.length);
  });

  it('links every listing to the area', async () => {
    expect(await db.listingArea.count({ where: { areaId: AREA_ID } })).toBe(await db.listing.count());
  });

  it('records a PollRun for every poll, with a canary verdict', async () => {
    const runs = await db.pollRun.findMany();
    expect(runs.length).toBeGreaterThanOrEqual(5);
    expect(runs.every((r) => r.finishedAt !== null)).toBe(true);
  });

  it('excludes out-of-area listings entirely', async () => {
    const narrow: AreaSpec = { id: AREA_ID, name: 'Just 80302', query: { kind: 'postalCodes', codes: ['80302'] } };
    const result = await pollArea(db, new MockProvider(0), narrow);
    expect(result.listingsSeen).toBe(3);
  });
});
