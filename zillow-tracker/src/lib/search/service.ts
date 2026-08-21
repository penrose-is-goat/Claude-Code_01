import type { PrismaClient } from '@prisma/client';
import type { NormalizedListing } from '../providers/normalized';
import type { AreaQuery, ListingProvider, ProviderId } from '../providers/types';
import { fetchAll } from '../providers/types';
import { getProvider } from '../providers/registry';
import { ALL_PROVIDER_IDS } from '../providers/registry';
import { boundingBox, isInsidePolygon, isWithinRadius, type LatLng } from '../geo';
import { GeocodeError, NominatimGeocoder } from './geocode';
import type { Geocoder, ResolvedPlace, SearchLocation, SearchOutcome, SearchQuery } from './types';

/**
 * Turns what the user typed or drew into real listings.
 *
 * There is no built-in area. `location.kind === 'place'` means geocode-then-radius;
 * `'drawn'` means fetch a coarse bounding box and filter to the exact hand-drawn shape.
 * Either way a total failure (every provider errored, or the place could not be
 * resolved) must be visible and distinguishable from "resolved fine, zero homes
 * matched" — that is the whole reason `SearchOutcome.providers[]` and
 * `allProvidersFailed` exist, and callers should never have to guess which happened
 * from an empty `listings` array alone.
 */

export interface RunSearchOptions {
  /** Defaults to a NominatimGeocoder against `db`. Inject a fake in tests. */
  geocoder?: Geocoder;
  /** Defaults to every registered provider. Narrow it to test one provider at a time. */
  providerIds?: ProviderId[];
  /** Defaults to the registry. Inject fakes in tests without touching the network. */
  getProvider?: (id: ProviderId) => ListingProvider<any>;
  now?: () => Date;
  signal?: AbortSignal;
}

export async function runSearch(
  db: PrismaClient,
  query: SearchQuery,
  opts: RunSearchOptions = {},
): Promise<SearchOutcome> {
  const geocoder = opts.geocoder ?? new NominatimGeocoder(db);
  const providerIds = opts.providerIds ?? ALL_PROVIDER_IDS;
  const resolveProvider = opts.getProvider ?? getProvider;
  const now = opts.now?.() ?? new Date();

  let areaQuery: AreaQuery;
  let resolved: ResolvedPlace | undefined;

  try {
    const location = await resolveLocation(query.location, geocoder);
    areaQuery = location.areaQuery;
    resolved = location.resolved;
  } catch (err) {
    // Nothing to fetch without somewhere to look — no provider ever ran, which is why
    // this reports as a single failed "step" rather than N provider failures.
    const message = err instanceof Error ? err.message : String(err);
    return {
      listings: [],
      providers: [{ providerId: 'location', ok: false, count: 0, message }],
      allProvidersFailed: true,
    };
  }

  const providers: SearchOutcome['providers'] = [];
  const merged: NormalizedListing[] = [];

  for (const providerId of providerIds) {
    let provider: ListingProvider<any>;
    try {
      provider = resolveProvider(providerId);
    } catch (err) {
      providers.push({ providerId, ok: false, count: 0, message: describeError(err) });
      continue;
    }

    try {
      const { raw } = await fetchAll(provider, {
        area: areaQuery,
        filters: query.filters,
        // Geometry is enough for a geo-aware provider; a search-backed one needs a name.
        // Prefer the geocoder's answer, fall back to what the user typed or labelled.
        placeHint: placeHintFor(query.location, resolved),
        signal: opts.signal,
      });

      const normalized: NormalizedListing[] = [];
      let skipped = 0;
      for (const r of raw) {
        try {
          normalized.push(provider.normalize(r));
        } catch {
          skipped++;
        }
      }

      const filtered = filterToLocation(normalized, query.location, resolved);
      const withOpenHouse = query.openHouseOnly ? filtered.filter((l) => hasUpcomingOpenHouse(l, now)) : filtered;

      merged.push(...withOpenHouse);
      providers.push({
        providerId,
        ok: true,
        count: withOpenHouse.length,
        message: skipped > 0 ? `${skipped} record(s) could not be parsed` : undefined,
      });
    } catch (err) {
      // One provider failing must not sink the others — snapshot/csv routinely succeed
      // when zillow is blocked, and that must still read as a partial success, not a
      // wholesale failure.
      providers.push({ providerId, ok: false, count: 0, message: describeError(err) });
    }
  }

  const allProvidersFailed = providers.length > 0 && providers.every((p) => !p.ok);

  return {
    listings: dedupeBySourceKey(merged),
    resolved,
    providers,
    allProvidersFailed,
  };
}

interface LocationResolution {
  /** Coarse query handed to providers. Never assume a provider actually honours the
   * shape — snapshot/csv ignore it entirely, and even zillow's own `cityRadius` slug is
   * an approximation. `filterToLocation` is what makes the result correct regardless. */
  areaQuery: AreaQuery;
  /** Only set for a resolved `place` location. */
  resolved?: ResolvedPlace;
}

export class LocationResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LocationResolutionError';
  }
}

/**
 * `place` needs geocoding before anything can be fetched; `drawn` needs no network call
 * at all — the ring the user drew already IS the answer, just coarsened for a provider
 * fetch.
 */
export async function resolveLocation(
  location: SearchLocation,
  geocoder: Geocoder,
): Promise<LocationResolution> {
  if (location.kind === 'drawn') {
    // Coarse on purpose: this is what gets handed to a provider's fetch, not the final
    // filter. A future provider that accepts a real bounding-box query benefits from
    // getting one; today's providers either ignore it (snapshot/csv) or reject it
    // outright (zillow) — either way `filterToLocation` below applies the real ring.
    const box = boundingBox(location.ring);
    return { areaQuery: { kind: 'bbox', ...box } };
  }

  let candidates: ResolvedPlace[];
  try {
    candidates = await geocoder.resolve(location.query);
  } catch (err) {
    if (err instanceof GeocodeError) {
      throw new LocationResolutionError(`Could not look up "${location.query}": ${err.message}`, err);
    }
    throw err;
  }

  const best = candidates[0];
  if (!best) {
    throw new LocationResolutionError(`No match found for "${location.query}"`);
  }

  return {
    resolved: best,
    areaQuery: {
      kind: 'cityRadius',
      city: best.city ?? '',
      state: best.state ?? '',
      centerLat: best.lat,
      centerLng: best.lng,
      radiusMiles: location.radiusMiles,
    },
  };
}

/**
 * The precise pass. `areaQuery` above is a coarsened stand-in used only to shape the
 * provider fetch; this is what actually decides membership, using the exact radius or
 * the exact hand-drawn ring rather than its bounding box.
 *
 * A listing with no coordinates can't be tested geometrically. Consistent with
 * `geo/listingMatchesArea`, it is kept rather than dropped — a listing you see and
 * dismiss is cheaper than one you never see.
 */
export function filterToLocation<T extends Pick<NormalizedListing, 'lat' | 'lng'> & { city?: string }>(
  listings: T[],
  location: SearchLocation,
  resolved?: ResolvedPlace,
): T[] {
  const expectedCity = resolved?.city?.trim().toLowerCase();

  return listings.filter((l) => {
    if (l.lat == null || l.lng == null) {
      // "Keep what cannot be placed" is right for a listing that is plausibly here and
      // merely missing coordinates. It is wrong for one that names a different city
      // outright — that is not an unplaceable listing, it is a listing from somewhere
      // else, and keeping it is how a search for one city quietly returns another's.
      if (expectedCity && l.city && l.city.trim().toLowerCase() !== expectedCity) return false;
      return true;
    }
    const p: LatLng = { lat: l.lat, lng: l.lng };

    if (location.kind === 'drawn') {
      return isInsidePolygon(p, location.ring);
    }
    // 'place' with no resolved center (should not happen once resolveLocation has
    // succeeded, but a defensive default of "keep" beats silently returning nothing).
    if (!resolved) return true;
    return isWithinRadius(p, { lat: resolved.lat, lng: resolved.lng }, location.radiusMiles);
  });
}

/**
 * The best available human name for the area being searched.
 *
 * For a typed place this is the geocoder's `City, ST`, which is more reliable than the
 * raw string the user typed. For a drawn shape there is no name unless the user gave the
 * shape one — returning undefined then is correct, and the provider that needs a name
 * says so rather than quietly finding nothing.
 */
export function placeHintFor(location: SearchLocation, resolved?: ResolvedPlace): string | undefined {
  if (location.kind === 'drawn') return location.label?.trim() || undefined;
  if (resolved?.city && resolved.state) return `${resolved.city}, ${resolved.state}`;
  return resolved?.displayName ?? location.query;
}

function hasUpcomingOpenHouse(l: NormalizedListing, now: Date): boolean {
  return l.openHouses.some((oh) => oh.endsAt.getTime() >= now.getTime());
}

/** Providers key listings by their own id; a listing can legitimately appear once per
 * provider that carries it (e.g. zillow AND a CSV export), so identity is per-provider. */
function dedupeBySourceKey(listings: NormalizedListing[]): NormalizedListing[] {
  const byKey = new Map<string, NormalizedListing>();
  for (const l of listings) byKey.set(`${l.providerId}:${l.sourceListingId}`, l);
  return [...byKey.values()];
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
