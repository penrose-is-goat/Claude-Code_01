import type { AreaQuery } from '../types';
import { boundingBox } from '../../geo';

/**
 * The map rectangle to search.
 *
 * Zillow's search API takes a bounding box, so a radius has to become one. The box is
 * the SQUARE that contains the circle, deliberately larger than the area asked for —
 * the exact radius is re-applied by the geo filter afterwards, and fetching slightly too
 * much then narrowing is correct where fetching too little is silently wrong.
 */
export function boundsOf(area: AreaQuery): { north: number; east: number; south: number; west: number } {
  if (area.kind === 'bbox') {
    return { north: area.maxLat, east: area.maxLng, south: area.minLat, west: area.minLng };
  }

  if (area.kind === 'polygon') {
    const box = boundingBox(area.ring);
    return { north: box.maxLat, east: box.maxLng, south: box.minLat, west: box.minLng };
  }

  if (area.centerLat == null || area.centerLng == null) {
    throw new Error('This area has no coordinates, so there is no map rectangle to search.');
  }

  // 69 miles per degree of latitude; longitude degrees narrow toward the poles.
  const dLat = area.radiusMiles / 69;
  const dLng = area.radiusMiles / (69 * Math.max(Math.cos((area.centerLat * Math.PI) / 180), 0.01));

  return {
    north: area.centerLat + dLat,
    south: area.centerLat - dLat,
    east: area.centerLng + dLng,
    west: area.centerLng - dLng,
  };
}
