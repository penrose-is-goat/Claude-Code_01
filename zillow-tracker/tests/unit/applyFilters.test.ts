import { describe, expect, it } from 'vitest';
import type { NormalizedListing } from '../../src/lib/providers/normalized';
import { applyFilters, locationFingerprint } from '../../src/lib/search/applyFilters';

function listing(over: Partial<NormalizedListing>): NormalizedListing {
  return {
    providerId: 'websearch',
    sourceListingId: over.sourceListingId ?? '111',
    addressLine1: over.addressLine1 ?? '1 Main St',
    city: over.city ?? 'Anywhere',
    state: over.state ?? 'CO',
    postalCode: over.postalCode ?? '80302',
    status: over.status ?? 'ACTIVE',
    propertyType: over.propertyType ?? 'SINGLE_FAMILY',
    photos: [],
    openHouses: over.openHouses ?? [],
    raw: {},
    fetchedAt: new Date('2026-08-22T12:00:00Z'),
    ...over,
  } as NormalizedListing;
}

describe('applyFilters', () => {
  it('returns everything when no filters set', () => {
    const ls = [listing({ sourceListingId: 'a' }), listing({ sourceListingId: 'b' })];
    expect(applyFilters(ls, undefined)).toHaveLength(2);
    expect(applyFilters(ls, {})).toHaveLength(2);
  });

  it('drops listings below minPrice, keeps ones with no published price', () => {
    // The whole point of NOT dropping the price-less one: a snippet may just have omitted
    // it. Dropping would hide a real listing. Providers already agree on this policy.
    const ls = [
      listing({ sourceListingId: 'cheap', listPrice: 200_000 }),
      listing({ sourceListingId: 'expensive', listPrice: 900_000 }),
      listing({ sourceListingId: 'unknown', listPrice: undefined }),
    ];
    const out = applyFilters(ls, { minPrice: 500_000 });
    expect(out.map((l) => l.sourceListingId).sort()).toEqual(['expensive', 'unknown']);
  });

  it('drops listings above maxPrice, keeps ones with no published price', () => {
    const ls = [
      listing({ sourceListingId: 'cheap', listPrice: 200_000 }),
      listing({ sourceListingId: 'expensive', listPrice: 900_000 }),
      listing({ sourceListingId: 'unknown', listPrice: undefined }),
    ];
    const out = applyFilters(ls, { maxPrice: 500_000 });
    expect(out.map((l) => l.sourceListingId).sort()).toEqual(['cheap', 'unknown']);
  });

  it('drops listings under minBeds, keeps ones with no published beds', () => {
    const ls = [
      listing({ sourceListingId: 'studio', beds: 0 }),
      listing({ sourceListingId: 'three', beds: 3 }),
      listing({ sourceListingId: 'unknown', beds: undefined }),
    ];
    const out = applyFilters(ls, { minBeds: 2 });
    expect(out.map((l) => l.sourceListingId).sort()).toEqual(['three', 'unknown']);
  });

  it('drops listings under minBaths, keeps ones with no published baths', () => {
    const ls = [
      listing({ sourceListingId: 'one', bathsTotal: 1 }),
      listing({ sourceListingId: 'three', bathsTotal: 3 }),
      listing({ sourceListingId: 'unknown', bathsTotal: undefined }),
    ];
    const out = applyFilters(ls, { minBaths: 2 });
    expect(out.map((l) => l.sourceListingId).sort()).toEqual(['three', 'unknown']);
  });

  it('narrows to selected property types', () => {
    const ls = [
      listing({ sourceListingId: 'sfh', propertyType: 'SINGLE_FAMILY' }),
      listing({ sourceListingId: 'condo', propertyType: 'CONDO' }),
      listing({ sourceListingId: 'town', propertyType: 'TOWNHOUSE' }),
    ];
    const out = applyFilters(ls, { propertyTypes: ['CONDO', 'TOWNHOUSE'] });
    expect(out.map((l) => l.sourceListingId).sort()).toEqual(['condo', 'town']);
  });

  it('with openHouseOnly, keeps listings whose end time is in the future', () => {
    const now = new Date('2026-08-22T12:00:00Z');
    const past = {
      startsAt: new Date('2026-08-20T20:00:00Z'),
      endsAt: new Date('2026-08-20T22:00:00Z'),
      timezone: 'America/New_York',
      appointmentOnly: false,
      virtual: false,
    };
    const upcoming = {
      startsAt: new Date('2026-08-23T15:00:00Z'),
      endsAt: new Date('2026-08-23T17:00:00Z'),
      timezone: 'America/New_York',
      appointmentOnly: false,
      virtual: false,
    };
    const ls = [
      listing({ sourceListingId: 'past', openHouses: [past] }),
      listing({ sourceListingId: 'soon', openHouses: [upcoming] }),
      listing({ sourceListingId: 'none', openHouses: [] }),
    ];
    const out = applyFilters(ls, { openHouseOnly: true }, now);
    expect(out.map((l) => l.sourceListingId)).toEqual(['soon']);
  });

  it('combines multiple filters (all must pass)', () => {
    const ls = [
      listing({ sourceListingId: 'match', listPrice: 600_000, beds: 3, propertyType: 'SINGLE_FAMILY' }),
      listing({ sourceListingId: 'too-cheap', listPrice: 200_000, beds: 3, propertyType: 'SINGLE_FAMILY' }),
      listing({ sourceListingId: 'wrong-type', listPrice: 600_000, beds: 3, propertyType: 'CONDO' }),
    ];
    const out = applyFilters(ls, { minPrice: 500_000, minBeds: 2, propertyTypes: ['SINGLE_FAMILY'] });
    expect(out.map((l) => l.sourceListingId)).toEqual(['match']);
  });

  it('does not mutate the input array', () => {
    const ls = [listing({ sourceListingId: 'a', listPrice: 100_000 })];
    const snapshot = [...ls];
    applyFilters(ls, { minPrice: 500_000 });
    expect(ls).toEqual(snapshot);
  });
});

describe('locationFingerprint', () => {
  it('is stable for identical place searches', () => {
    const a = locationFingerprint({ kind: 'place', query: 'Boulder, CO', radiusMiles: 5 });
    const b = locationFingerprint({ kind: 'place', query: 'Boulder, CO', radiusMiles: 5 });
    expect(a).toBe(b);
  });

  it('differs on radius change', () => {
    const a = locationFingerprint({ kind: 'place', query: 'Boulder, CO', radiusMiles: 5 });
    const b = locationFingerprint({ kind: 'place', query: 'Boulder, CO', radiusMiles: 10 });
    expect(a).not.toBe(b);
  });

  it('differs on query text change', () => {
    const a = locationFingerprint({ kind: 'place', query: 'Boulder, CO', radiusMiles: 5 });
    const b = locationFingerprint({ kind: 'place', query: 'Denver, CO', radiusMiles: 5 });
    expect(a).not.toBe(b);
  });

  it('is stable for identical drawn rings', () => {
    const ring: Array<[number, number]> = [[40, -105], [40.1, -105], [40, -104.9]];
    const a = locationFingerprint({ kind: 'drawn', ring });
    const b = locationFingerprint({ kind: 'drawn', ring: [...ring] });
    expect(a).toBe(b);
  });

  it('differs on ring point change', () => {
    const a = locationFingerprint({ kind: 'drawn', ring: [[40, -105], [40.1, -105], [40, -104.9]] });
    const b = locationFingerprint({ kind: 'drawn', ring: [[40, -105], [40.2, -105], [40, -104.9]] });
    expect(a).not.toBe(b);
  });
});
