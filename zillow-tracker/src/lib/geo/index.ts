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

/**
 * Does the ring cross itself?
 *
 * A hand-drawn area that crosses itself is a normal user mistake, and GeoJSON's even-odd
 * fill rule then quietly excludes the middle — dropping listings the user could plainly
 * see they had enclosed, with no error anywhere. Detecting it lets us fall back to
 * something predictable instead of being silently wrong.
 */
export function ringSelfIntersects(ring: Array<[number, number]>): boolean {
  const r = closeRing(ring);
  const n = r.length - 1;
  if (n < 4) return false;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Adjacent segments legitimately share an endpoint.
      if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(r[i], r[i + 1], r[j], r[j + 1])) return true;
    }
  }
  return false;
}

function segmentsCross(
  a: [number, number], b: [number, number], c: [number, number], d: [number, number],
): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Andrew's monotone chain. Used as the fallback shape for a self-intersecting ring. */
export function convexHull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...new Set(points.map((p) => `${p[0]},${p[1]}`))]
    .map((k) => k.split(',').map(Number) as [number, number])
    .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (source: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const pt of source) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop();
      out.push(pt);
    }
    out.pop();
    return out;
  };

  return [...build(pts), ...build([...pts].reverse())];
}

export function isInsidePolygon(p: LatLng, ring: Array<[number, number]>): boolean {
  // A crossed ring would otherwise apply even-odd fill and drop its own middle in
  // silence. The hull is a predictable, strictly-larger answer, and over-inclusion is
  // the cheaper error here — you can dismiss a house you see, not one you never do.
  if (ringSelfIntersects(ring)) {
    const hull = convexHull(ring);
    if (hull.length >= 3) {
      console.warn('[geo] area ring crosses itself; falling back to its convex hull');
      return isInsidePolygon(p, hull);
    }
  }

  const closed = closeRing(ring);
  // turf requires 4+ positions for a LinearRing. An already-closed 3-element ring
  // (`[A, B, A]`) passes a `length < 3` check but makes turf throw — and that throw
  // escapes filterListingsToArea between fetch and upsert, failing the entire run so
  // that not one listing gets written. A two-click draw is enough to produce one.
  if (closed.length < 4) return false;

  try {
    return booleanPointInPolygon(point(toPosition(p)), turfPolygon([closed]));
  } catch {
    // A malformed area must never take down ingestion for every listing in the batch.
    return false;
  }
}

export function milesBetween(a: LatLng, b: LatLng): number {
  return distance(point(toPosition(a)), point(toPosition(b)), { units: 'miles' });
}

export function isWithinRadius(p: LatLng, center: LatLng, radiusMiles: number): boolean {
  return milesBetween(p, center) <= radiusMiles;
}

/**
 * Bounding box of a ring.
 *
 * Handles the antimeridian: a ring spanning +179°..-179° is 2° wide, not 358°. Taking a
 * naive min/max produced a box covering almost the entire globe, which would silently
 * turn a small area into "everywhere". Irrelevant for a US-only tool today, but it is
 * the kind of thing that is invisible until it is very confusing.
 */
export function boundingBox(ring: Array<[number, number]>): {
  minLat: number; minLng: number; maxLat: number; maxLng: number;
} {
  const lngs = ring.map((r) => r[0]);
  const lats = ring.map((r) => r[1]);

  const naiveWidth = Math.max(...lngs) - Math.min(...lngs);
  const sorted = [...lngs].sort((a, b) => a - b);

  // Widest gap between consecutive longitudes; if that gap is bigger than the leftover
  // span, the ring wraps through the antimeridian.
  let gapStart = sorted[0];
  let widestGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > widestGap) { widestGap = gap; gapStart = sorted[i - 1]; }
  }
  const wrapWidth = 360 - widestGap;

  if (sorted.length > 1 && wrapWidth < naiveWidth) {
    return {
      minLng: sorted.find((v) => v > gapStart)!,
      maxLng: gapStart,
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
    };
  }

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
      // Same policy as the geometric cases below: if we cannot test it, keep it. A
      // listing you see and dismiss is cheaper than one you never see.
      if (!listing.postalCode) return true;
      return area.codes.some((c) => c.slice(0, 5) === listing.postalCode.slice(0, 5));

    case 'polygon':
      if (!p) return true;
      return isInsidePolygon(p, area.ring);

    case 'cityRadius': {
      if (!p) return true;
      if (area.centerLat == null || area.centerLng == null) return true;
      return isWithinRadius(p, { lat: area.centerLat, lng: area.centerLng }, area.radiusMiles);
    }

    case 'bbox': {
      if (!p) return true;
      if (p.lat < area.minLat || p.lat > area.maxLat) return false;
      // minLng > maxLng means the box crosses the antimeridian, so the longitude test
      // is a union of two ranges rather than a single interval.
      return area.minLng > area.maxLng
        ? p.lng >= area.minLng || p.lng <= area.maxLng
        : p.lng >= area.minLng && p.lng <= area.maxLng;
    }
  }
}

export function filterListingsToArea<T extends Pick<NormalizedListing, 'lat' | 'lng' | 'postalCode'>>(
  listings: T[],
  area: AreaQuery,
): T[] {
  return listings.filter((l) => listingMatchesArea(l, area));
}
