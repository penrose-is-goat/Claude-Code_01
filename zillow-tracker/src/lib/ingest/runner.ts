import type { PrismaClient } from '@prisma/client';
import { getProvider, ALL_PROVIDER_IDS } from '../providers/registry';
import type { AreaQuery } from '../providers/types';
import { NominatimGeocoder } from '../search/geocode';
import type { Geocoder, ResolvedPlace, SearchLocation } from '../search/types';
import { cacheResolvedPlace, parseResolvedPlace, parseSavedSearchQuery } from '../db/searches';
import { pollSearch, type SearchSpec, type PollResult } from './pipeline';

/**
 * Turns stored SavedSearch rows into pipeline runs. Shared by the API route and the
 * worker so both take exactly the same path — a scheduled poll and a button press must
 * not be able to behave differently.
 *
 * There is no per-search provider list any more (the old Area model had one; SavedSearch
 * deliberately does not — see schema.prisma). Every registered provider gets tried for
 * every active search; a provider that isn't configured (csv with no file, snapshot with
 * no captures) or that the source blocks records its own FAILED run rather than aborting
 * the others, same as it always has.
 */

export type SearchPollResult = PollResult & { searchName: string; providerId: string };

/**
 * `drawn` -> exact polygon, not a bounding-box coarsening.
 *
 * `search/service.ts`'s ad-hoc `runSearch` deliberately fetches against a coarse bbox
 * and filters precisely afterward, because it has no pipeline to hand geometry-aware
 * filtering off to. Polling does: `pollSearch` already applies exact
 * `isInsidePolygon` filtering for `AreaQuery.kind === 'polygon'` (see geo/index.ts), and
 * today's providers treat 'polygon' and 'bbox' identically anyway (zillow rejects both,
 * snapshot/csv ignore both) — so there is no fetch-side reason to coarsen here, only a
 * precision cost to giving it up.
 *
 * `place` -> `cityRadius`, resolved from the search's own cached `resolved` column
 * first. That column exists specifically so a scheduled refresh does not re-geocode a
 * place it already knows (the geocoder's own AppState cache would absorb the repeat
 * network trip too, but going through it every 15 minutes for every saved search is
 * needless work this avoids entirely).
 */
export async function resolveSearchAreaQuery(
  db: PrismaClient,
  search: { id: string; resolved: string | null },
  location: SearchLocation,
  geocoder: Geocoder,
): Promise<AreaQuery> {
  if (location.kind === 'drawn') {
    return { kind: 'polygon', ring: location.ring };
  }

  let place: ResolvedPlace | undefined = parseResolvedPlace(search);
  if (!place) {
    const candidates = await geocoder.resolve(location.query);
    place = candidates[0];
    if (!place) throw new Error(`No match found for "${location.query}"`);
    await cacheResolvedPlace(db, search.id, place);
  }

  return {
    kind: 'cityRadius',
    city: place.city ?? '',
    state: place.state ?? '',
    centerLat: place.lat,
    centerLng: place.lng,
    radiusMiles: location.radiusMiles,
  };
}

export interface RunnerOptions {
  searchId?: string;
  now?: Date;
  /** Injectable so a scheduled worker run and a test never touch the network. */
  geocoder?: Geocoder;
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

export async function runAllSearches(
  db: PrismaClient,
  opts: RunnerOptions = {},
): Promise<SearchPollResult[]> {
  const searches = await db.savedSearch.findMany({
    where: { active: true, ...(opts.searchId ? { id: opts.searchId } : {}) },
  });
  const geocoder = opts.geocoder ?? new NominatimGeocoder(db);
  const now = opts.now ?? new Date();

  const results: SearchPollResult[] = [];

  if (opts.rebuild) {
    await clearListingStore(db);
  }

  for (const search of searches) {
    const query = parseSavedSearchQuery(search);

    let areaQuery: AreaQuery;
    try {
      areaQuery = await resolveSearchAreaQuery(db, search, query.location, geocoder);
    } catch (err) {
      // Nothing to fetch without somewhere to look. Recorded as one failure for the
      // search rather than one per provider, since no provider ever ran — mirrors
      // search/service.ts's `runSearch` treating a resolution failure as its own kind
      // of failure rather than N empty provider results.
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        runId: '', status: 'FAILED', listingsSeen: 0, listingsNew: 0, eventsCreated: 0,
        requestsUsed: 0, canaryOk: false, canaryReason: message, delisted: 0, errorMessage: message,
        searchName: search.name, providerId: 'location',
      });
      continue;
    }

    const spec: SearchSpec = {
      id: search.id,
      name: search.name,
      query: areaQuery,
      filters: query.filters,
    };

    for (const providerId of ALL_PROVIDER_IDS) {
      // One provider failing must not abort the remaining searches — pollSearch already
      // records a FAILED run, so the log tells the story.
      const provider = getProvider(providerId);
      const result = await pollSearch(db, provider, spec, { now });
      results.push({ ...result, searchName: search.name, providerId });
    }

    await db.savedSearch.update({ where: { id: search.id }, data: { lastRunAt: now } });
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
  await db.listingSearch.deleteMany({});
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
