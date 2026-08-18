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

export function buildWhere(f: ListingFilterInput): Prisma.ListingWhereInput {
  const where: Prisma.ListingWhereInput = {};

  if (!f.includeRemoved) where.removedAt = null;
  if (f.minPrice != null || f.maxPrice != null) {
    where.listPrice = {
      ...(f.minPrice != null ? { gte: f.minPrice } : {}),
      ...(f.maxPrice != null ? { lte: f.maxPrice } : {}),
    };
  }
  if (f.minBeds != null) where.beds = { gte: f.minBeds };
  if (f.minBaths != null) where.bathsTotal = { gte: f.minBaths };
  if (f.status?.length) where.status = { in: f.status };
  if (f.propertyType?.length) where.propertyType = { in: f.propertyType };
  if (f.areaId) where.areas = { some: { areaId: f.areaId } };
  if (f.favoritesOnly) where.saved = { is: { favorite: true } };
  if (f.openHouseOnly) {
    where.openHouses = { some: { cancelledAt: null, startsAt: { gte: new Date() } } };
  }
  if (f.q) {
    // SQLite has no case-insensitive mode in Prisma, so we match as stored. Addresses
    // are title-case in practice, and this is a personal tool, not a search engine.
    where.OR = [
      { addressLine1: { contains: f.q } },
      { city: { contains: f.q } },
      { postalCode: { contains: f.q } },
    ];
  }

  return where;
}

function buildOrderBy(sort: ListingFilterInput['sort']): Prisma.ListingOrderByWithRelationInput[] {
  switch (sort) {
    case 'price-asc': return [{ listPrice: 'asc' }];
    case 'price-desc': return [{ listPrice: 'desc' }];
    case 'recently-changed': return [{ lastChangedAt: 'desc' }];
    case 'newest':
    default: return [{ firstSeenAt: 'desc' }];
  }
}

export async function findListings(f: ListingFilterInput, take = 200) {
  return prisma.listing.findMany({
    where: buildWhere(f),
    orderBy: buildOrderBy(f.sort),
    take,
    include: {
      saved: true,
      openHouses: {
        where: { cancelledAt: null, startsAt: { gte: new Date() } },
        orderBy: { startsAt: 'asc' },
      },
      events: {
        where: { type: 'PRICE_CHANGE' },
        orderBy: { occurredAt: 'desc' },
        take: 1,
      },
    },
  });
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
    where: { cancelledAt: null, startsAt: { gte: new Date(), lte: until }, listing: { removedAt: null } },
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
    prisma.openHouse.count({ where: { cancelledAt: null, startsAt: { gte: new Date() } } }),
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
    create: { listingId, addressKey: listing.addressKey, favorite: true, ...payload },
    update: payload,
  });
}
