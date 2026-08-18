import type { Prisma } from '@prisma/client';
import { prisma } from './client';

/**
 * All reads go through here so pages never build their own Prisma queries. Keeps the
 * SQLite-vs-Postgres decision reversible and gives one place to tune indexes.
 */

export interface ListingFilterInput {
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  status?: string[];
  propertyType?: string[];
  areaId?: string;
  openHouseOnly?: boolean;
  favoritesOnly?: boolean;
  includeRemoved?: boolean;
  sort?: 'newest' | 'price-asc' | 'price-desc' | 'recently-changed' | 'open-house';
}

/**
 * Strips LIKE wildcards for the DATABASE pass only.
 *
 * Prisma's `contains` cannot emit an ESCAPE clause on SQLite, so a backslash escape is
 * matched literally and does nothing. Removing the metacharacters yields a deliberate
 * superset — "50%" queries rows containing "50" — which `matchesQuery` below then
 * narrows to an exact, literal substring match.
 */
export function likePrefilter(input: string): string {
  return input.replace(/[%_]/g, '');
}

/** The precise, literal, case-insensitive match. This is the authoritative one. */
export function matchesQuery(
  listing: { addressLine1: string; city: string; postalCode: string },
  q: string,
): boolean {
  const needle = q.toLowerCase();
  return (
    listing.addressLine1.toLowerCase().includes(needle) ||
    listing.city.toLowerCase().includes(needle) ||
    listing.postalCode.toLowerCase().includes(needle)
  );
}

/**
 * Builds the SQL predicate.
 *
 * IMPORTANT: when `f.q` is set this is a PREFILTER, not the final answer. SQLite's LIKE
 * treats % and _ as wildcards and Prisma cannot emit an ESCAPE clause for it, so the
 * predicate deliberately widens and `matchesQuery` narrows. Callers that run this
 * predicate directly must apply `matchesQuery` themselves — `findListings` already does.
 */
export function buildWhere(f: ListingFilterInput): Prisma.ListingWhereInput {
  const where: Prisma.ListingWhereInput = {};

  if (!f.includeRemoved) where.removedAt = null;
  if (f.minPrice != null || f.maxPrice != null) {
    // A listing with no published price is kept, matching the geo filter's policy: a
    // home you see and dismiss is cheaper than one you never see. "Coming soon" and
    // auction listings routinely arrive without a price, and they are exactly the ones
    // worth noticing early.
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          {
            listPrice: {
              ...(f.minPrice != null ? { gte: f.minPrice } : {}),
              ...(f.maxPrice != null ? { lte: f.maxPrice } : {}),
            },
          },
          { listPrice: null },
        ],
      },
    ];
  }
  if (f.minBeds != null) where.beds = { gte: f.minBeds };
  if (f.minBaths != null) where.bathsTotal = { gte: f.minBaths };
  if (f.status?.length) where.status = { in: f.status };
  if (f.propertyType?.length) where.propertyType = { in: f.propertyType };
  // absentSince must be honoured here, not just recorded. Marking a per-area absence is
  // pointless if the area's own view keeps showing the listing anyway.
  if (f.areaId) where.areas = { some: { areaId: f.areaId, absentSince: null } };
  if (f.favoritesOnly) where.saved = { is: { favorite: true } };
  if (f.openHouseOnly) {
    // endsAt, not startsAt: a 12–3pm open house vanished from every view at 12:01,
    // precisely when you are deciding whether to go.
    where.openHouses = { some: { cancelledAt: null, endsAt: { gte: new Date() } } };
  }
  if (f.q) {
    // SQLite's LIKE is ASCII case-insensitive by default, so "pine" does match
    // "1420 Pine St" — no mode: 'insensitive' needed (and Prisma does not support it on
    // SQLite anyway).
    //
    // Prisma parameterizes the value but does NOT escape LIKE metacharacters, so a bare
    // "%" matched every listing and a literal "%" in an address was unsearchable.
    const prefilter = likePrefilter(f.q);
    if (prefilter) {
      where.OR = [
        { addressLine1: { contains: prefilter } },
        { city: { contains: prefilter } },
        { postalCode: { contains: prefilter } },
      ];
    }
  }

  return where;
}

function buildOrderBy(sort: ListingFilterInput['sort']): Prisma.ListingOrderByWithRelationInput[] {
  switch (sort) {
    case 'price-asc': return [{ listPrice: 'asc' }];
    case 'price-desc': return [{ listPrice: 'desc' }];
    case 'recently-changed': return [{ lastChangedAt: 'desc' }];
    // Listings without an upcoming open house sort last rather than being dropped.
    case 'open-house': return [{ lastChangedAt: 'desc' }];
    case 'newest':
    default: return [{ firstSeenAt: 'desc' }];
  }
}

export async function findListings(f: ListingFilterInput, take = 200) {
  const rows = await prisma.listing.findMany({
    where: buildWhere(f),
    orderBy: buildOrderBy(f.sort),
    take,
    include: {
      saved: true,
      openHouses: {
        where: { cancelledAt: null, endsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
      },
      events: {
        where: { type: 'PRICE_CHANGE' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      },
    },
  });

  // The SQL pass is a superset when the query contains LIKE metacharacters; this is
  // where "%"-as-a-literal actually gets enforced.
  return f.q ? rows.filter((r) => matchesQuery(r, f.q!)) : rows;
}

export type ListingWithRelations = Awaited<ReturnType<typeof findListings>>[number];

export async function getListing(id: string) {
  return prisma.listing.findUnique({
    where: { id },
    include: {
      saved: true,
      areas: { include: { area: true } },
      openHouses: { orderBy: { startsAt: 'asc' } },
      events: { orderBy: { occurredAt: 'desc' } },
      snapshots: { orderBy: { capturedAt: 'asc' } },
    },
  });
}

export async function getUpcomingOpenHouses(daysAhead = 14) {
  const until = new Date(Date.now() + daysAhead * 864e5);
  return prisma.openHouse.findMany({
    where: { cancelledAt: null, endsAt: { gte: new Date() }, startsAt: { lte: until }, listing: { removedAt: null } },
    orderBy: { startsAt: 'asc' },
    include: { listing: { include: { saved: true } } },
  });
}

export async function getRecentEvents(limit = 100) {
  return prisma.listingEvent.findMany({
    orderBy: { occurredAt: 'desc' },
    take: limit,
    include: { listing: { include: { saved: true } } },
  });
}

/** Powers the "new since last visit" badge. */
export async function getUnseenEventCount(): Promise<number> {
  return prisma.listingEvent.count({ where: { seenAt: null } });
}

export async function markAllEventsSeen(): Promise<number> {
  const r = await prisma.listingEvent.updateMany({
    where: { seenAt: null },
    data: { seenAt: new Date() },
  });
  return r.count;
}

export async function getStats() {
  const [total, active, favorites, upcomingOpenHouses, unseen, lastRun] = await Promise.all([
    prisma.listing.count({ where: { removedAt: null } }),
    prisma.listing.count({ where: { removedAt: null, status: 'ACTIVE' } }),
    prisma.savedListing.count({ where: { favorite: true } }),
    prisma.openHouse.count({ where: { cancelledAt: null, endsAt: { gte: new Date() } } }),
    getUnseenEventCount(),
    prisma.pollRun.findFirst({ orderBy: { startedAt: 'desc' } }),
  ]);
  return { total, active, favorites, upcomingOpenHouses, unseen, lastRun };
}

export async function getPriceDrops(days = 30) {
  const since = new Date(Date.now() - days * 864e5);
  return prisma.listingEvent.findMany({
    where: { type: 'PRICE_CHANGE', deltaAbs: { lt: 0 }, occurredAt: { gte: since } },
    orderBy: { occurredAt: 'desc' },
    include: { listing: { include: { saved: true } } },
  });
}

export async function getAreas() {
  return prisma.area.findMany({ orderBy: { name: 'asc' } });
}

export async function getRuns(limit = 20) {
  return prisma.pollRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit, include: { area: true } });
}

export async function toggleFavorite(listingId: string): Promise<boolean> {
  const listing = await prisma.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { saved: true },
  });

  if (listing.saved) {
    const next = !listing.saved.favorite;
    await prisma.savedListing.update({ where: { listingId }, data: { favorite: next } });
    return next;
  }

  await prisma.savedListing.create({
    data: { listingId, addressKey: listing.addressKey, favorite: true },
  });
  return true;
}

export async function updateSaved(
  listingId: string,
  data: { notes?: string; rating?: number | null; userStatus?: string; tags?: string[] },
) {
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId } });
  const payload = {
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
    ...(data.rating !== undefined ? { rating: data.rating } : {}),
    ...(data.userStatus !== undefined ? { userStatus: data.userStatus } : {}),
    ...(data.tags !== undefined ? { tags: JSON.stringify(data.tags) } : {}),
  };

  return prisma.savedListing.upsert({
    where: { listingId },
    // favorite: false on create. Writing a note is not the same act as starring, and
    // creating the row as a favorite meant the star silently disagreed with /saved —
    // then offered "Add to favorites" for a button that would actually remove it.
    create: { listingId, addressKey: listing.addressKey, favorite: false, ...payload },
    update: payload,
  });
}
