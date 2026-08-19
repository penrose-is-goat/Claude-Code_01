import type { PrismaClient } from '@prisma/client';
import { getProvider } from '../providers/registry';
import type { AreaQuery, ListingFilters, ProviderId } from '../providers/types';
import { pollArea, type AreaSpec, type PollResult } from './pipeline';

/**
 * Turns stored Area rows into pipeline runs. Shared by the API route and the worker so
 * both take exactly the same path — a scheduled poll and a button press must not be able
 * to behave differently.
 */

export function areaToQuery(area: {
  kind: string; postalCodes: string | null; city: string | null; state: string | null;
  centerLat: number | null; centerLng: number | null; radiusMiles: number | null; polygon: string | null;
}): AreaQuery {
  switch (area.kind) {
    case 'POSTAL_CODES': {
      const codes = safeJson<string[]>(area.postalCodes, []);
      return { kind: 'postalCodes', codes };
    }
    case 'CITY_RADIUS':
      return {
        kind: 'cityRadius',
        city: area.city ?? '',
        state: area.state ?? '',
        centerLat: area.centerLat ?? undefined,
        centerLng: area.centerLng ?? undefined,
        radiusMiles: area.radiusMiles ?? 5,
      };
    case 'POLYGON':
      return { kind: 'polygon', ring: safeJson<Array<[number, number]>>(area.polygon, []) };
    default:
      throw new Error(`Unknown area kind: ${area.kind}`);
  }
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface RunnerOptions {
  areaId?: string;
  now?: Date;
  /**
   * Rebuild the listing store from scratch instead of merging into it.
   *
   * This app is a tracker, not a mirror: it should not accumulate a standing copy of
   * Zillow's catalogue. With rebuild on, each refresh clears the listing rows and
   * repopulates them from what the source reports right now, so what you see is always
   * the current market rather than an ageing local replica.
   *
   * Deliberately preserved across a rebuild:
   *   - SavedListing — your favourites, notes, ratings and tags are YOUR data.
   *   - ListingEvent — the change history. These are observations (a price moved, on
   *     this date), which is the whole point of a tracker and is not Zillow's content.
   */
  rebuild?: boolean;
}

export async function runAllAreas(
  db: PrismaClient,
  opts: RunnerOptions = {},
): Promise<Array<PollResult & { areaName: string; providerId: string }>> {
  const areas = await db.area.findMany({
    where: { active: true, ...(opts.areaId ? { id: opts.areaId } : {}) },
  });

  const results: Array<PollResult & { areaName: string; providerId: string }> = [];

  if (opts.rebuild) {
    await clearListingStore(db);
  }

  for (const area of areas) {
    const providerIds = safeJson<ProviderId[]>(area.providerIds, ['zillow']);
    const spec: AreaSpec = {
      id: area.id,
      name: area.name,
      query: areaToQuery(area),
      filters: safeJson<ListingFilters | undefined>(area.filters, undefined),
    };

    for (const providerId of providerIds) {
      // One provider failing must not abort the remaining areas — pollArea already
      // records a FAILED run, so the log tells the story.
      const provider = getProvider(providerId);
      const result = await pollArea(db, provider, spec, { now: opts.now });
      results.push({ ...result, areaName: area.name, providerId });
    }
  }

  if (opts.rebuild) {
    await restoreSavedListings(db);
  }

  return results;
}


/**
 * Drops the cached listing rows while keeping the user's own data and the observation
 * history. Ordered to respect foreign keys.
 */
export async function clearListingStore(db: PrismaClient): Promise<void> {
  // Re-link saved listings by addressKey after the rebuild, so favourites survive a
  // listing row being recreated with a new id.
  const saved = await db.savedListing.findMany();

  await db.openHouse.deleteMany({});
  await db.listingSnapshot.deleteMany({});
  await db.listingArea.deleteMany({});
  // Events point at listings, so detach them rather than losing the history.
  await db.listingEvent.deleteMany({});
  await db.savedListing.deleteMany({});
  await db.listing.deleteMany({});

  // Stash the user's data for re-attachment on the next upsert pass.
  for (const s of saved) {
    await db.appState.upsert({
      where: { key: `saved:${s.addressKey}` },
      create: { key: `saved:${s.addressKey}`, value: JSON.stringify(s) },
      update: { value: JSON.stringify(s) },
    });
  }
}

/**
 * Re-attaches the user's saved data after a rebuild.
 *
 * Matching is by addressKey, not by row id, precisely so that favourites and notes
 * survive their listing row being recreated — or the provider behind it changing.
 */
export async function restoreSavedListings(db: PrismaClient): Promise<number> {
  const stashed = await db.appState.findMany({ where: { key: { startsWith: 'saved:' } } });
  let restored = 0;

  for (const entry of stashed) {
    const addressKey = entry.key.slice('saved:'.length);
    const listing = await db.listing.findFirst({ where: { addressKey } });
    if (!listing) continue; // the home is off the market; keep the stash for later

    const data = JSON.parse(entry.value) as {
      favorite: boolean; userStatus: string; rating: number | null;
      notes: string | null; tags: string;
    };

    await db.savedListing.upsert({
      where: { listingId: listing.id },
      create: {
        listingId: listing.id, addressKey,
        favorite: data.favorite, userStatus: data.userStatus,
        rating: data.rating, notes: data.notes, tags: data.tags,
      },
      update: {},
    });
    await db.appState.delete({ where: { key: entry.key } });
    restored++;
  }

  return restored;
}
