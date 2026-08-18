import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { buildWhere, matchesQuery } from '@/lib/db/queries';

/**
 * buildWhere() executed against a real SQLite database, because the interesting
 * questions here are all about what SQLite actually does with the generated SQL.
 */

let dir: string;
let db: PrismaClient;

const row = (over: Record<string, unknown>) => ({
  providerId: 'mock', sourceListingId: String(Math.random()), sourceKey: String(Math.random()),
  addressKey: 'k', addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302',
  status: 'ACTIVE', propertyType: 'SINGLE_FAMILY', listPrice: 800000,
  contentHash: 'h', raw: '{}', photos: '[]', ...over,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ztracker-q-'));
  const url = `file:${join(dir, 'test.db')}`;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: url }, cwd: process.cwd(), stdio: 'pipe',
  });
  db = new PrismaClient({ datasources: { db: { url } } });

  await db.listing.create({ data: row({ sourceKey: 'a', addressLine1: '1420 Pine St', city: 'Boulder' }) });
  await db.listing.create({ data: row({ sourceKey: 'b', addressLine1: '77 Elm Ave', city: 'Louisville', postalCode: '80027' }) });
  await db.listing.create({ data: row({ sourceKey: 'c', addressLine1: '9 Maple Ct', city: 'Boulder', listPrice: null }) });
  await db.listing.create({ data: row({ sourceKey: 'd', addressLine1: '50% Grade Rd', city: 'Nederland', postalCode: '80466' }) });

  const withOh = await db.listing.create({ data: row({ sourceKey: 'e', addressLine1: '3 Open House Way', city: 'Boulder' }) });
  // An open house that is happening RIGHT NOW: started an hour ago, ends in an hour.
  await db.openHouse.create({
    data: {
      listingId: withOh.id,
      startsAt: new Date(Date.now() - 36e5),
      endsAt: new Date(Date.now() + 36e5),
      timezone: 'America/Denver',
    },
  });
}, 120_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

// Mirrors the authoritative two-stage path in findListings: buildWhere is a PREFILTER
// when `q` is set (SQLite LIKE wildcards cannot be escaped through Prisma), and
// matchesQuery is what enforces a literal match.
const find = async (f: Parameters<typeof buildWhere>[0]) => {
  const rows = await db.listing.findMany({ where: buildWhere(f) });
  const narrowed = f.q ? rows.filter((r) => matchesQuery(r, f.q!)) : rows;
  return narrowed.map((l) => l.addressLine1).sort();
};

// ---------------------------------------------------------------------------
// Q1 — the `q` search.
// ---------------------------------------------------------------------------
describe('Q1 free-text search against real SQLite', () => {
  it('OK (the source comment is wrong): lowercase input DOES match title-case data', async () => {
    // queries.ts says "SQLite has no case-insensitive mode in Prisma, so we match as
    // stored". In practice SQLite's LIKE is ASCII-case-insensitive by default, so
    // `contains` already matches either way. The comment describes a defect that isn't
    // there — worth correcting so nobody "fixes" it into a real one.
    expect(await find({ q: 'pine' })).toEqual(['1420 Pine St']);
    expect(await find({ q: 'BOULDER' })).toHaveLength(3); // the three Boulder rows
  });

  it('BUG: the search string is interpolated into LIKE without escaping wildcards', async () => {
    // A user typing "%" (or a house number like "50%") gets every listing back, and a
    // literal "%" can never be searched for.
    expect(await find({ q: '%' })).toEqual(['50% Grade Rd']);
  });

  it('BUG: "_" is a single-character wildcard too', async () => {
    expect(await find({ q: '_' })).toEqual([]);
  });

  it('OK: an unmatched term returns nothing, and ZIP search works', async () => {
    expect(await find({ q: 'nowhere' })).toEqual([]);
    expect(await find({ q: '80027' })).toEqual(['77 Elm Ave']);
  });
});

// ---------------------------------------------------------------------------
// Q2 — open-house filters exclude open houses that are in progress.
// ---------------------------------------------------------------------------
describe('Q2 an open house happening right now is invisible', () => {
  it('BUG: openHouseOnly uses startsAt >= now, so a 12–3pm open house vanishes at 12:01', async () => {
    // Same predicate is used by findListings' `include`, by getUpcomingOpenHouses and by
    // getStats().upcomingOpenHouses, so at exactly the moment the user is deciding
    // whether to drive over, the app says there is no open house.
    expect(await find({ openHouseOnly: true })).toEqual(['3 Open House Way']);
  });
});

// ---------------------------------------------------------------------------
// Q3 — price filters and NULL.
// ---------------------------------------------------------------------------
describe('Q3 price filters', () => {
  it('BUG(quiet): a listing with no price disappears as soon as any price bound is set', async () => {
    // SQL NULL comparisons are never true, so "under $1M" silently hides every
    // price-on-request listing rather than showing it with an unknown price.
    const all = await find({});
    expect(all).toContain('9 Maple Ct');
    expect(await find({ maxPrice: 1_000_000 })).toContain('9 Maple Ct');
  });

  it('OK: bounds are inclusive and combine correctly', async () => {
    // 4 priced rows at exactly 800000, plus the one row with no published price, which
    // is now deliberately retained rather than silently filtered out.
    const found = await find({ minPrice: 800000, maxPrice: 800000 });
    expect(found).toHaveLength(5);
    expect(found).toContain('9 Maple Ct');
  });

  it('OK: removedAt filtering is on by default and can be opted out of', async () => {
    await db.listing.updateMany({ where: { sourceKey: 'b' }, data: { removedAt: new Date() } });
    expect(await find({})).not.toContain('77 Elm Ave');
    expect(await find({ includeRemoved: true })).toContain('77 Elm Ave');
    await db.listing.updateMany({ where: { sourceKey: 'b' }, data: { removedAt: null } });
  });
});
