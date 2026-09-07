import { describe, expect, it } from 'vitest';
import type { NormalizedListing } from '../../src/lib/providers/normalized';
import { identityKey, mergeListings, splitStreet } from '../../src/lib/providers/websearch/merge';

const FETCHED = new Date('2026-08-22T12:00:00Z');

function listing(over: Partial<NormalizedListing>): NormalizedListing {
  return {
    providerId: 'websearch',
    sourceListingId: over.sourceListingId ?? '111',
    addressLine1: over.addressLine1 ?? '1655 Walnut St',
    city: over.city ?? 'Boulder',
    state: over.state ?? 'CO',
    postalCode: over.postalCode ?? '80302',
    status: over.status ?? 'ACTIVE',
    propertyType: over.propertyType ?? 'OTHER',
    photos: over.photos ?? [],
    openHouses: over.openHouses ?? [],
    raw: over.raw ?? {},
    fetchedAt: over.fetchedAt ?? FETCHED,
    ...over,
  } as NormalizedListing;
}

describe('splitStreet', () => {
  it('reads number and street', () => {
    expect(splitStreet('1655 Walnut St')).toEqual({ number: '1655', unit: '', street: 'Walnut St' });
  });

  it('reads trailing unit designators', () => {
    expect(splitStreet('1655 Walnut St UNIT 106')).toMatchObject({ number: '1655', unit: 'unit 106' });
    expect(splitStreet('1655 Walnut St Apt 3')).toMatchObject({ number: '1655', unit: 'unit 3' });
    expect(splitStreet('1655 Walnut St Suite 200')).toMatchObject({ number: '1655', unit: 'suite 200' });
  });

  it('reads # units and normalizes different spellings to one key', () => {
    // Two different snippets writing the same unit differently must merge, so the unit
    // form has to canonicalize.
    const withHash = splitStreet('1655 Walnut St #106');
    const withUnit = splitStreet('1655 Walnut St UNIT 106');
    const withApt = splitStreet('1655 Walnut St Apt 106');
    expect(withHash?.unit).toBe('unit 106');
    expect(withUnit?.unit).toBe('unit 106');
    expect(withApt?.unit).toBe('unit 106');
  });

  it('reads comma-separated units', () => {
    expect(splitStreet('1655 Walnut St, Apt 3'))
      .toMatchObject({ number: '1655', street: 'Walnut St', unit: 'unit 3' });
  });

  it('accepts a letter-suffixed number', () => {
    expect(splitStreet('12B Cove Ln')).toMatchObject({ number: '12B', street: 'Cove Ln' });
  });

  it('returns null with no street number', () => {
    // Without a leading number the whole address key is unsafe to build, and null tells
    // the caller to keep the record as its own identity.
    expect(splitStreet('Walnut St')).toBeNull();
    expect(splitStreet('')).toBeNull();
  });
});

describe('identityKey', () => {
  it('prefers zpid over address when a zpid exists', () => {
    const a = listing({ sourceListingId: '88908043' });
    expect(identityKey(a)).toBe('zpid:88908043');
  });

  it('extracts zpid from listingUrl for providers that do not use it as the id', () => {
    const a = listing({
      providerId: 'snapshot',
      sourceListingId: 'snap-1',
      listingUrl: 'https://www.zillow.com/homedetails/1655-Walnut-St-UNIT-106-Boulder-CO-80302/88908043_zpid/',
    });
    expect(identityKey(a)).toBe('zpid:88908043');
  });

  it('leads the address key with street number and unit', () => {
    // Two homes with everything the same except the number must not collide.
    const a = listing({ sourceListingId: 'a', addressLine1: '1311 E Fort Ave', postalCode: '21230', city: 'Baltimore', state: 'MD' });
    const b = listing({ sourceListingId: 'b', addressLine1: '1337 S Charles St', postalCode: '21230', city: 'Baltimore', state: 'MD' });
    expect(identityKey(a)).not.toBe(identityKey(b));
    expect(identityKey(a).startsWith('addr:1311|')).toBe(true);
  });

  it('separates two units in the same building', () => {
    // The exact case that would fail without unit in the key: same street name, ZIP,
    // even street number, only the unit differs.
    const u106 = listing({ sourceListingId: 'a', addressLine1: '1655 Walnut St UNIT 106' });
    const u309 = listing({ sourceListingId: 'b', addressLine1: '1655 Walnut St #309' });
    expect(identityKey(u106)).not.toBe(identityKey(u309));
  });

  it('matches the same unit written two ways', () => {
    const one = listing({ sourceListingId: 'a', addressLine1: '1655 Walnut St UNIT 106' });
    const two = listing({ sourceListingId: 'b', addressLine1: '1655 Walnut St #106' });
    expect(identityKey(one)).toBe(identityKey(two));
  });

  it('keeps a record with no street number as its own identity', () => {
    // The safe direction to fail: a duplicate row is annoying, a wrong merge lies.
    const a = listing({ sourceListingId: 'a', addressLine1: 'Somewhere on Walnut St' });
    const b = listing({ sourceListingId: 'b', addressLine1: 'Somewhere on Walnut St' });
    expect(identityKey(a)).not.toBe(identityKey(b));
  });
});

describe('mergeListings', () => {
  it('merges two snippets of the same home into one, keeping every field', () => {
    const priceOnly = listing({
      sourceListingId: '111', listPrice: 500000, beds: undefined, bathsTotal: undefined,
      fetchedAt: new Date('2026-08-22T09:00:00Z'),
    });
    const bedsOnly = listing({
      sourceListingId: '111', listPrice: undefined, beds: 3, bathsTotal: 2, yearBuilt: 1990,
      fetchedAt: new Date('2026-08-22T10:00:00Z'),
    });
    const { merged, stats } = mergeListings([priceOnly, bedsOnly]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ listPrice: 500000, beds: 3, bathsTotal: 2, yearBuilt: 1990 });
    expect(stats.merges).toBe(1);
  });

  it('never merges two different homes that share every weak field', () => {
    // Same street name, city, ZIP, beds, baths, sqft. Different street number. Two homes.
    const a = listing({ sourceListingId: 'a', addressLine1: '1311 E Fort Ave', beds: 3, bathsTotal: 2, livingAreaSqft: 1400 });
    const b = listing({ sourceListingId: 'b', addressLine1: '1337 S Charles St', beds: 3, bathsTotal: 2, livingAreaSqft: 1400 });
    expect(mergeListings([a, b]).merged).toHaveLength(2);
  });

  it('newer value wins where two records disagree', () => {
    // A price drop: earlier snippet at $650k, later at $625k. Merged record shows $625k.
    const before = listing({
      sourceListingId: '222', listPrice: 650000,
      fetchedAt: new Date('2026-08-22T09:00:00Z'),
    });
    const after = listing({
      sourceListingId: '222', listPrice: 625000,
      fetchedAt: new Date('2026-08-22T10:00:00Z'),
    });
    // Input order is oldest-first, so the newer record is at the end.
    expect(mergeListings([before, after]).merged[0].listPrice).toBe(625000);
  });

  it('unions open houses from two snippets and dedupes exact matches', () => {
    const sat = { startsAt: new Date('2026-08-22T15:00:00Z'), endsAt: new Date('2026-08-22T17:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    const sun = { startsAt: new Date('2026-08-23T17:00:00Z'), endsAt: new Date('2026-08-23T19:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    const a = listing({ sourceListingId: '333', openHouses: [sat] });
    const b = listing({ sourceListingId: '333', openHouses: [sat, sun] });
    expect(mergeListings([a, b]).merged[0].openHouses).toHaveLength(2);
  });

  it('promotes a specific propertyType/status over the OTHER/UNKNOWN default', () => {
    const generic = listing({ sourceListingId: '444', propertyType: 'OTHER', status: 'UNKNOWN', fetchedAt: new Date('2026-08-22T10:00:00Z') });
    const specific = listing({ sourceListingId: '444', propertyType: 'SINGLE_FAMILY', status: 'ACTIVE', fetchedAt: new Date('2026-08-22T09:00:00Z') });
    // Order: specific (older) then generic (newer). The generic newer record still gets
    // promoted to the specific type, because OTHER/UNKNOWN are stand-ins for "unknown".
    const { merged } = mergeListings([specific, generic]);
    expect(merged[0].propertyType).toBe('SINGLE_FAMILY');
    expect(merged[0].status).toBe('ACTIVE');
  });

  it('collapses many overlapping snippets down to the distinct set', () => {
    // No-zpid ids on purpose — this exercises the ADDRESS-based identity path, which
    // is what a snippet from an index page (no /homedetails/ URL) actually hits.
    const rows = [
      listing({ providerId: 'websearch', sourceListingId: 'ix-a', addressLine1: '1311 E Fort Ave', beds: 3 }),
      listing({ providerId: 'websearch', sourceListingId: 'ix-b', addressLine1: '1311 E Fort Ave', listPrice: 500000 }),
      listing({ providerId: 'websearch', sourceListingId: 'ix-c', addressLine1: '1337 S Charles St' }),
      listing({ providerId: 'websearch', sourceListingId: 'ix-d', addressLine1: '1655 Walnut St UNIT 106' }),
      listing({ providerId: 'websearch', sourceListingId: 'ix-e', addressLine1: '1655 Walnut St UNIT 309' }),
      // Same unit two ways — must merge.
      listing({ providerId: 'websearch', sourceListingId: 'ix-f', addressLine1: '1655 Walnut St #106', beds: 2 }),
    ];
    const { merged } = mergeListings(rows);
    expect(merged.map((l) => l.addressLine1).sort()).toEqual([
      '1311 E Fort Ave',
      '1337 S Charles St',
      '1655 Walnut St #106',
      '1655 Walnut St UNIT 309',
    ]);
    // The 1655 UNIT 106 pair merged — beds from the second snippet is present.
    const walnut106 = merged.find((l) => l.addressLine1.includes('106'));
    expect(walnut106?.beds).toBe(2);
  });
});
