import type { NormalizedListing } from '../providers/normalized';
import type { ListingFilters } from '../providers/types';

/**
 * Filter an already-fetched batch of listings by the user's price/beds/baths/type/open-house
 * knobs, without touching the network.
 *
 * This is the local-apply path. Each provider already filters what it hands back — the
 * user sees the same semantics either way — but going back through the providers to
 * re-filter costs a real fetch (and, on Zillow, another Press & Hold challenge). When the
 * only thing that changed between two searches is a filter, applying it locally is the
 * whole point.
 *
 * Deliberate policy on unpublished fields: a listing whose price the source didn't publish
 * is KEPT under a price bound rather than dropped. Same for beds and baths. Dropping it
 * would hide real homes for the sin of a terse index snippet, which the earlier iteration
 * of this app did and the user was right to reject. Providers already do it this way —
 * `src/lib/providers/websearch/index.ts:135` and `src/lib/providers/snapshot/index.ts:131`.
 * If the two ever diverge, the on-screen count moves depending on whether a fetch ran, and
 * the local-apply promise is broken.
 */
export function applyFilters(
  listings: NormalizedListing[],
  filters: ListingFilters | undefined,
  now: Date = new Date(),
): NormalizedListing[] {
  if (!filters) return listings;

  return listings.filter((l) => {
    if (filters.minPrice != null && l.listPrice != null && l.listPrice < filters.minPrice) return false;
    if (filters.maxPrice != null && l.listPrice != null && l.listPrice > filters.maxPrice) return false;
    if (filters.minBeds != null && l.beds != null && l.beds < filters.minBeds) return false;
    if (filters.minBaths != null && l.bathsTotal != null && l.bathsTotal < filters.minBaths) return false;
    if (filters.propertyTypes?.length && !filters.propertyTypes.includes(l.propertyType)) return false;
    if (filters.openHouseOnly && !hasUpcomingOpenHouse(l, now)) return false;
    return true;
  });
}

function hasUpcomingOpenHouse(l: NormalizedListing, now: Date): boolean {
  return l.openHouses.some((oh) => oh.endsAt.getTime() >= now.getTime());
}

/**
 * Two searches share a fetch result iff their location halves are equivalent — the
 * filters can freely differ. A `place` search matches on the exact typed string and
 * radius; a `drawn` search matches on the point sequence and label. Both are compared
 * verbatim (no normalization): a whitespace-only change to what the user typed is a
 * different intent, and the user will re-run it explicitly anyway.
 */
export function locationFingerprint(location: {
  kind: 'place' | 'drawn';
  query?: string;
  radiusMiles?: number;
  ring?: Array<[number, number]>;
  label?: string;
}): string {
  if (location.kind === 'place') {
    return `place:${location.query ?? ''}:${location.radiusMiles ?? ''}`;
  }
  const ring = (location.ring ?? []).map(([lat, lng]) => `${lat},${lng}`).join(';');
  return `drawn:${location.label ?? ''}:${ring}`;
}
