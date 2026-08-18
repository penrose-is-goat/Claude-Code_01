import { describe, it, expect } from 'vitest';
import {
  isInsidePolygon, closeRing, listingMatchesArea, filterListingsToArea, isWithinRadius, boundingBox,
} from '@/lib/geo';
import type { AreaQuery } from '@/lib/providers/types';

/**
 * Adversarial probes of the geofilter. This runs between fetch and upsert, so anything
 * that throws here fails the entire poll run (pollArea's catch marks it FAILED and no
 * listing in the batch is written), and anything that silently returns false drops
 * listings the user drew a box around.
 */

// A 1km-ish square around Boulder, in GeoJSON [lng, lat] order.
const SQUARE: Array<[number, number]> = [
  [-105.30, 40.00], [-105.20, 40.00], [-105.20, 40.10], [-105.30, 40.10],
];

const at = (lat: number, lng: number) => ({ lat, lng });

describe('G1 degenerate rings', () => {
  it('BUG: an already-closed 2-point ring throws instead of returning false', () => {
    // A user who clicks twice and lets the editor close the shape stores [A, B, A].
    // ring.length < 3 is the only guard, so this reaches @turf/helpers, which requires
    // 4+ positions and throws — killing the whole poll run for that area.
    const ring: Array<[number, number]> = [[-105.3, 40.0], [-105.2, 40.0], [-105.3, 40.0]];
    expect(ring.length).toBe(3);
    expect(() => isInsidePolygon(at(40.05, -105.25), ring)).not.toThrow();
  });

  it('BUG: three identical points throw as well', () => {
    const ring: Array<[number, number]> = [[-105.3, 40.0], [-105.3, 40.0], [-105.3, 40.0]];
    expect(() => isInsidePolygon(at(40.05, -105.25), ring)).not.toThrow();
  });

  it('OK: fewer than 3 points is rejected cleanly', () => {
    expect(isInsidePolygon(at(40.05, -105.25), [])).toBe(false);
    expect(isInsidePolygon(at(40.05, -105.25), [[-105.3, 40.0]])).toBe(false);
    expect(isInsidePolygon(at(40.05, -105.25), [[-105.3, 40.0], [-105.2, 40.0]])).toBe(false);
  });

  it('OK: a collinear (zero-area) triangle contains nothing off the line', () => {
    const ring: Array<[number, number]> = [[-105.3, 40.0], [-105.25, 40.0], [-105.2, 40.0]];
    expect(isInsidePolygon(at(40.01, -105.25), ring)).toBe(false);
    // (a point exactly ON the degenerate line reads as inside, consistent with turf's
    // boundary rule — surprising, but harmless and consistent.)
    expect(isInsidePolygon(at(40.0, -105.25), ring)).toBe(true);
  });

  it('OK: duplicate interior points are tolerated', () => {
    const dup: Array<[number, number]> = [
      [-105.30, 40.00], [-105.20, 40.00], [-105.20, 40.00], [-105.20, 40.10], [-105.30, 40.10],
    ];
    expect(isInsidePolygon(at(40.05, -105.25), dup)).toBe(true);
  });

  it('OK: closeRing is idempotent and does not mutate its input', () => {
    const once = closeRing(SQUARE);
    expect(closeRing(once)).toEqual(once);
    expect(SQUARE).toHaveLength(4);
  });
});

describe('G2 boundaries', () => {
  it('OK: a point exactly on an edge is inside (turf default), consistently', () => {
    expect(isInsidePolygon(at(40.00, -105.25), SQUARE)).toBe(true);   // on the south edge
    expect(isInsidePolygon(at(40.05, -105.30), SQUARE)).toBe(true);   // on the west edge
  });

  it('OK: a point exactly on a vertex is inside', () => {
    expect(isInsidePolygon(at(40.00, -105.30), SQUARE)).toBe(true);
  });

  it('OK: a point exactly at the radius edge is included', () => {
    const center = at(40.0, -105.25);
    expect(isWithinRadius(center, center, 0)).toBe(true);
  });

  it('OK: bbox comparisons are inclusive on all four sides', () => {
    const q: AreaQuery = { kind: 'bbox', minLat: 40, maxLat: 41, minLng: -106, maxLng: -105 };
    for (const p of [at(40, -106), at(41, -105), at(40, -105), at(41, -106)]) {
      expect(listingMatchesArea({ ...p, postalCode: '80302' }, q)).toBe(true);
    }
  });
});

describe('G3 self-intersection and wrap-around', () => {
  it('BUG(quiet): a self-intersecting "bowtie" silently excludes its own middle', () => {
    // Nothing validates the ring, so a hand-drawn shape that crosses itself applies
    // even-odd filling and drops listings the user visibly enclosed. No error surfaces.
    const bowtie: Array<[number, number]> = [
      [-105.30, 40.00], [-105.20, 40.10], [-105.20, 40.00], [-105.30, 40.10],
    ];
    expect(isInsidePolygon(at(40.05, -105.25), bowtie)).toBe(true);
  });

  it('BUG(quiet): a bbox spanning the antimeridian matches nothing', () => {
    const q: AreaQuery = { kind: 'bbox', minLat: 50, maxLat: 55, minLng: 170, maxLng: -170 };
    expect(listingMatchesArea({ lat: 52, lng: 179, postalCode: '99546' }, q)).toBe(true);
  });

  it('BUG(quiet): boundingBox of an antimeridian ring spans the whole globe', () => {
    const bb = boundingBox([[179, 51], [-179, 51], [-179, 53], [179, 53]]);
    expect(bb.maxLng - bb.minLng).toBeLessThan(10);
  });
});

describe('G4 the missing-coordinate policy', () => {
  it('BUG: the "keep it if we cannot test it" policy is not applied to postal-code areas', () => {
    // polygon / cityRadius / bbox all return true for a listing with no coordinates,
    // on the documented grounds that a false positive is cheaper than an invisible home.
    // A listing with no postalCode is silently dropped instead — the opposite call, made
    // implicitly rather than deliberately.
    const noZip = { lat: undefined, lng: undefined, postalCode: '' };
    const poly: AreaQuery = { kind: 'polygon', ring: SQUARE };
    expect(listingMatchesArea(noZip, poly)).toBe(true);
    expect(listingMatchesArea(noZip, { kind: 'postalCodes', codes: ['80302'] })).toBe(true);
  });

  it('OK (documented tradeoff): a coordinate-less listing lands in every polygon area', () => {
    const noCoords = [{ lat: undefined, lng: undefined, postalCode: '99999' }];
    expect(filterListingsToArea(noCoords, { kind: 'polygon', ring: SQUARE })).toHaveLength(1);
  });

  it('OK: a postal-code area ignores coordinates entirely, as designed', () => {
    const q: AreaQuery = { kind: 'postalCodes', codes: ['80302'] };
    expect(listingMatchesArea({ lat: 0, lng: 0, postalCode: '80302-1234' }, q)).toBe(true);
    expect(listingMatchesArea({ lat: 40.05, lng: -105.25, postalCode: '80303' }, q)).toBe(false);
  });
});
