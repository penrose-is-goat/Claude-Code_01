import type { ListingFilters } from '../providers/types';
import type { NormalizedListing } from '../providers/normalized';

/**
 * The search contract.
 *
 * This app has NO built-in area. Nothing is seeded, nothing is hardcoded, and the
 * dashboard shows no listings until the user has described somewhere to look. A search
 * is always something the user typed or drew.
 *
 * ZIP codes are deliberately absent from this interface. The user chose "city + radius"
 * and "draw on a map"; ZIPs are an implementation detail of one upstream source at most,
 * never something the product asks a person to supply.
 */

/** Where to look. */
export type SearchLocation =
  /** Free text the user typed: "Boulder, CO", "Wicker Park, Chicago", "123 Main St, Austin". */
  | { kind: 'place'; query: string; radiusMiles: number }
  /** A shape the user drew on the map. [lng, lat] pairs, GeoJSON order. */
  | { kind: 'drawn'; ring: Array<[number, number]>; label?: string };

export interface SearchQuery {
  location: SearchLocation;
  filters: ListingFilters;
  /** Only homes with an upcoming open house. */
  openHouseOnly?: boolean;
}

/** What a geocoder returns for a typed place. */
export interface ResolvedPlace {
  /** What to show the user: "Boulder, Colorado, United States". */
  displayName: string;
  lat: number;
  lng: number;
  /** Best-effort components, used to build an upstream query. */
  city?: string;
  state?: string;
  /** Bounding box, when the geocoder supplies one: [minLat, maxLat, minLng, maxLng]. */
  boundingBox?: [number, number, number, number];
}

export interface Geocoder {
  readonly id: string;
  /** Returns candidates, most confident first. Empty array means "no match", not an error. */
  resolve(query: string, signal?: AbortSignal): Promise<ResolvedPlace[]>;
}

export interface SearchOutcome {
  listings: NormalizedListing[];
  /** Where we decided to look, echoed back so the UI can confirm it to the user. */
  resolved?: ResolvedPlace;
  /** Per-provider outcome, so a failure is visible rather than silently empty. */
  providers: Array<{
    providerId: string;
    ok: boolean;
    count: number;
    message?: string;
  }>;
  /** True when every provider failed — the UI must say so, not show "no results". */
  allProvidersFailed: boolean;
}

/** A search the user chose to keep and track over time. */
export interface SavedSearchInput {
  name: string;
  query: SearchQuery;
  /** Poll cadence; null means manual refresh only. */
  cron?: string | null;
  notifyOnNew?: boolean;
  notifyOnPriceDrop?: boolean;
  notifyOnOpenHouse?: boolean;
}
