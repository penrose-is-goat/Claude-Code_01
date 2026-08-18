import { describe, it, expect } from 'vitest';
import {
  isInsidePolygon, isWithinRadius, milesBetween, boundingBox, closeRing,
  listingMatchesArea, filterListingsToArea,
} from '@/lib/geo';

/** A square around central Boulder, as [lng, lat] pairs. */
const SQUARE: Array<[number, number]> = [
  [-105.30, 40.00], [-105.25, 40.00], [-105.25, 40.05], [-105.30, 40.05],
];

describe('closeRing', () => {
  it('closes an open ring', () => {
    expect(closeRing(SQUARE)).toHaveLength(5);
    expect(closeRing(SQUARE)[4]).toEqual(SQUARE[0]);
  });

  it('leaves an already-closed ring alone', () => {
    const closed = [...SQUARE, SQUARE[0]];
    expect(closeRing(closed)).toHaveLength(5);
  });
});

describe('isInsidePolygon', () => {
  it('accepts a point inside', () => {
    expect(isInsidePolygon({ lat: 40.02, lng: -105.27 }, SQUARE)).toBe(true);
  });

  it('rejects a point outside', () => {
    expect(isInsidePolygon({ lat: 40.10, lng: -105.27 }, SQUARE)).toBe(false);
    expect(isInsidePolygon({ lat: 40.02, lng: -105.40 }, SQUARE)).toBe(false);
  });

  it('does not confuse lat with lng — the classic GeoJSON bug', () => {
    // Swapping the coordinates must NOT still test as inside.
    expect(isInsidePolygon({ lat: -105.27, lng: 40.02 }, SQUARE)).toBe(false);
  });

  it('rejects a degenerate ring rather than throwing', () => {
    expect(isInsidePolygon({ lat: 40.02, lng: -105.27 }, [[0, 0], [1, 1]])).toBe(false);
  });
});

describe('radius', () => {
  it('measures a known distance sanely', () => {
    const d = milesBetween({ lat: 40.0150, lng: -105.2705 }, { lat: 39.7392, lng: -104.9903 });
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(30);
  });

  it('includes points inside the radius and excludes those outside', () => {
    const center = { lat: 40.015, lng: -105.2705 };
    expect(isWithinRadius({ lat: 40.02, lng: -105.27 }, center, 5)).toBe(true);
    expect(isWithinRadius({ lat: 39.7392, lng: -104.9903 }, center, 5)).toBe(false);
  });
});

describe('boundingBox', () => {
  it('computes the extent of a ring', () => {
    expect(boundingBox(SQUARE)).toEqual({
      minLng: -105.30, maxLng: -105.25, minLat: 40.00, maxLat: 40.05,
    });
  });
});

describe('listingMatchesArea', () => {
  const inside = { lat: 40.02, lng: -105.27, postalCode: '80302' };
  const outside = { lat: 40.90, lng: -105.90, postalCode: '80513' };

  it('matches by ZIP', () => {
    const area = { kind: 'postalCodes', codes: ['80302', '80304'] } as const;
    expect(listingMatchesArea(inside, area)).toBe(true);
    expect(listingMatchesArea(outside, area)).toBe(false);
  });

  it('tolerates ZIP+4 on either side', () => {
    expect(listingMatchesArea(
      { lat: 0, lng: 0, postalCode: '80302-1234' },
      { kind: 'postalCodes', codes: ['80302'] },
    )).toBe(true);
  });

  it('matches by polygon', () => {
    const area = { kind: 'polygon', ring: SQUARE } as const;
    expect(listingMatchesArea(inside, area)).toBe(true);
    expect(listingMatchesArea(outside, area)).toBe(false);
  });

  it('matches by city radius', () => {
    const area = {
      kind: 'cityRadius', city: 'Boulder', state: 'CO',
      centerLat: 40.015, centerLng: -105.2705, radiusMiles: 5,
    } as const;
    expect(listingMatchesArea(inside, area)).toBe(true);
    expect(listingMatchesArea(outside, area)).toBe(false);
  });

  it('matches by bbox', () => {
    const area = { kind: 'bbox', minLat: 40, maxLat: 40.05, minLng: -105.3, maxLng: -105.25 } as const;
    expect(listingMatchesArea(inside, area)).toBe(true);
    expect(listingMatchesArea(outside, area)).toBe(false);
  });

  it('keeps a listing with no coordinates rather than silently hiding it', () => {
    const noCoords = { lat: undefined, lng: undefined, postalCode: '99999' };
    expect(listingMatchesArea(noCoords, { kind: 'polygon', ring: SQUARE })).toBe(true);
  });

  it('still applies ZIP matching when coordinates are missing', () => {
    const noCoords = { lat: undefined, lng: undefined, postalCode: '99999' };
    expect(listingMatchesArea(noCoords, { kind: 'postalCodes', codes: ['80302'] })).toBe(false);
  });
});

describe('filterListingsToArea', () => {
  it('filters a collection', () => {
    const listings = [
      { lat: 40.02, lng: -105.27, postalCode: '80302' },
      { lat: 40.90, lng: -105.90, postalCode: '80513' },
    ];
    expect(filterListingsToArea(listings, { kind: 'polygon', ring: SQUARE })).toHaveLength(1);
  });
});
