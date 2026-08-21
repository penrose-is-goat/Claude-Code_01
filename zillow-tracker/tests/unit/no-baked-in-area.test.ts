import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { filterToPlace } from '../../src/lib/providers/snapshot';
import { filterToLocation } from '../../src/lib/search/service';
import type { NormalizedListing } from '../../src/lib/providers/normalized';

/**
 * The app must have NO built-in area.
 *
 * This is a product requirement, not a preference: the user asked for something they
 * could point anywhere, and deliberately would not name their own city so that it could
 * not be baked in. These tests are what makes that checkable instead of promised.
 *
 * They exist because the promise was already broken once. Snapshots are a pile of
 * captures from whatever has been harvested so far, and the snapshot provider served
 * all of them for every search — so a search for Austin returned 49 Boulder homes. The
 * geometry filter downstream could not catch it, because captured listings carry no
 * coordinates and that filter keeps what it cannot place.
 */

const listing = (city: string, state: string): NormalizedListing => ({
  providerId: 'snapshot',
  sourceListingId: `${city}-1`,
  addressLine1: '1 Main St',
  city, state, postalCode: '00000',
  status: 'ACTIVE', propertyType: 'SINGLE_FAMILY',
  listingUrl: 'https://www.zillow.com/homedetails/1_zpid/',
  photos: [], openHouses: [], raw: {}, fetchedAt: new Date('2026-08-21T00:00:00Z'),
});

const ROWS = [listing('Boulder', 'CO'), listing('Austin', 'TX'), listing('Portland', 'OR')];

describe('captured snapshots are scoped to the place being searched', () => {
  it('returns only the searched city', () => {
    const got = filterToPlace(ROWS, {
      area: { kind: 'cityRadius', city: 'Austin', state: 'TX', radiusMiles: 10 },
    });
    expect(got.map((l) => l.city)).toEqual(['Austin']);
  });

  it('does not match a same-named city in another state', () => {
    expect(filterToPlace(ROWS, {
      area: { kind: 'cityRadius', city: 'Boulder', state: 'TX', radiusMiles: 10 },
    })).toEqual([]);
  });

  it('fails closed: no place to match means no listings, not every listing', () => {
    // The regression, stated directly. Returning ROWS here is what shipped before.
    expect(filterToPlace(ROWS, {
      area: { kind: 'bbox', minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
    })).toEqual([]);
  });

  it('uses the label the user gave a drawn shape', () => {
    const got = filterToPlace(ROWS, {
      area: { kind: 'bbox', minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
      placeHint: 'Portland, OR',
    });
    expect(got.map((l) => l.city)).toEqual(['Portland']);
  });

  it('is case- and spacing-insensitive about how the user typed it', () => {
    const rows = [listing('San Francisco', 'CA')];
    for (const typed of ['san francisco', 'San  Francisco', ' SAN FRANCISCO ']) {
      expect(filterToPlace(rows, {
        area: { kind: 'cityRadius', city: typed, state: 'ca', radiusMiles: 5 },
      }), typed).toHaveLength(1);
    }
  });
});

describe('filterToLocation does not keep another city as merely unplaceable', () => {
  const resolved = { displayName: 'Austin, Texas', lat: 30.27, lng: -97.74, city: 'Austin', state: 'TX' };
  const place = { kind: 'place' as const, query: 'Austin, TX', radiusMiles: 25 };

  it('drops a coordinate-less listing that names a different city', () => {
    const got = filterToLocation(
      [{ lat: undefined, lng: undefined, city: 'Boulder' }, { lat: undefined, lng: undefined, city: 'Austin' }],
      place, resolved,
    );
    expect(got.map((l) => l.city)).toEqual(['Austin']);
  });

  it('still keeps a coordinate-less listing that names no city at all', () => {
    expect(filterToLocation([{ lat: undefined, lng: undefined }], place, resolved)).toHaveLength(1);
  });
});

describe('no city is hardcoded in application code', () => {
  const SRC = join(process.cwd(), 'src');

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return tsFiles(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
  }

  /** Comments legitimately cite real addresses as parser examples; code must not. */
  function codeOnly(source: string): string {
    return source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  }

  it('never names a specific city or ZIP in a URL, constant or default', () => {
    const offenders: string[] = [];

    for (const file of tsFiles(SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));

      // A city slug inside a zillow.com URL is the exact shape of the bug this catches:
      // healthCheck used to probe https://www.zillow.com/boulder-co/open-house/.
      const slugInUrl = code.match(/zillow\.com\/[a-z]+(?:-[a-z]+)*-[a-z]{2}\//g);
      if (slugInUrl) offenders.push(`${file}: ${slugInUrl.join(', ')}`);

      // A bare five-digit ZIP as a literal value.
      const zipLiteral = code.match(/['"`]\d{5}['"`]/g);
      if (zipLiteral) offenders.push(`${file}: ZIP literal ${zipLiteral.join(', ')}`);
    }

    expect(offenders).toEqual([]);
  });
});
