import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
import { point, polygon as turfPolygon } from '@turf/helpers';
import type { AreaQuery } from '../providers/types';
import type { NormalizedListing } from '../providers/normalized';

/**
 * Query coarse, filter fine.
 *
 * No listing provider accepts a hand-drawn polygon. So the fetch uses the coarsest form
 * the provider understands (a city slug or a ZIP), and the precise shape is applied here
 * in JavaScript. At a handful of areas and a few thousand listings this is microseconds,
 * which is why there is no PostGIS in this project.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON convention is [lng, lat] — the reversal is the classic bug, so it lives here once. */
export function toPosition(p: LatLng): [number, number] {
  return [p.lng, p.lat];
}

export function closeRing(ring: Array<[number, number]>): Array<[number, number]> {
  if (ring.length === 0) return ring;
  const [first] = ring;
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

export function isInsidePolygon(p: LatLng, ring: Array<[number, number]>): boolean {
  if (ring.length < 3) return false;
  return booleanPointInPolygon(point(toPosition(p)), turfPolygon([closeRing(ring)]));
}

export function milesBetween(a: LatLng, b: LatLng): number {
  return distance(point(toPosition(a)), point(toPosition(b)), { units: 'miles' });
}

export function isWithinRadius(p: LatLng, center: LatLng, radiusMiles: number): boolean {
  return milesBetween(p, center) <= radiusMiles;
}

export function boundingBox(ring: Array<[number, number]>): {
  minLat: number; minLng: number; maxLat: number; maxLng: number;
} {
  const lngs = ring.map((r) => r[0]);
  const lats = ring.map((r) => r[1]);
  return {
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
  };
}

/**
 * Does this listing actually belong to this area?
 *
 * A listing with no coordinates can't be tested geometrically. Rather than drop it, we
 * fall back to the ZIP code where we have one, and otherwise keep it — a listing you
 * see and dismiss is a much cheaper mistake than one you never see at all.
 */
export function listingMatchesArea(
  listing: Pick<NormalizedListing, 'lat' | 'lng' | 'postalCode'>,
  area: AreaQuery,
): boolean {
  const hasCoords = listing.lat != null && listing.lng != null;
  const p: LatLng | null = hasCoords ? { lat: listing.lat!, lng: listing.lng! } : null;

  switch (area.kind) {
    case 'postalCodes':
      return area.codes.some((c) => c.slice(0, 5) === listing.postalCode?.slice(0, 5));

    case 'polygon':
      if (!p) return true;
      return isInsidePolygon(p, area.ring);

    case 'cityRadius': {
      if (!p) return true;
      if (area.centerLat == null || area.centerLng == null) return true;
      return isWithinRadius(p, { lat: area.centerLat, lng: area.centerLng }, area.radiusMiles);
    }

    case 'bbox':
      if (!p) return true;
      return (
        p.lat >= area.minLat && p.lat <= area.maxLat &&
        p.lng >= area.minLng && p.lng <= area.maxLng
      );
  }
}

export function filterListingsToArea<T extends Pick<NormalizedListing, 'lat' | 'lng' | 'postalCode'>>(
  listings: T[],
  area: AreaQuery,
): T[] {
  return listings.filter((l) => listingMatchesArea(l, area));
}
