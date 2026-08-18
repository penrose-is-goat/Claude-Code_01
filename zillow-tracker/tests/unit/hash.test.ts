import { describe, it, expect } from 'vitest';
import { addressKey, contentHash, normalizeStreet, canonicalOpenHouses } from '@/lib/ingest/hash';
import type { NormalizedListing } from '@/lib/providers/normalized';

function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'mock', sourceListingId: '1', addressLine1: '1420 Pine St', city: 'Boulder',
    state: 'CO', postalCode: '80302', status: 'ACTIVE', propertyType: 'SINGLE_FAMILY',
    listPrice: 800000, photos: [], openHouses: [], raw: {},
    fetchedAt: new Date('2026-08-15T12:00:00Z'), ...over,
  };
}

describe('normalizeStreet', () => {
  it('folds suffixes and directionals', () => {
    expect(normalizeStreet('1420 North Pine Street')).toBe('1420 n pine st');
    expect(normalizeStreet('55 Southwest Oak Boulevard')).toBe('55 sw oak blvd');
  });

  it('is punctuation and case insensitive', () => {
    expect(normalizeStreet('1420 Pine St.')).toBe(normalizeStreet('1420 pine st'));
    expect(normalizeStreet('3300 Folsom St #12')).toBe('3300 folsom st 12');
  });

  it('leaves unknown tokens alone rather than guessing', () => {
    expect(normalizeStreet('12 Wibble Foo')).toBe('12 wibble foo');
  });
});

describe('addressKey', () => {
  const base = { addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302' };

  it('is stable across formatting differences', () => {
    expect(addressKey(base)).toBe(addressKey({
      addressLine1: '1420 Pine Street', city: 'boulder', state: 'co', postalCode: '80302-1234',
    }));
  });

  it('differs for genuinely different addresses', () => {
    expect(addressKey(base)).not.toBe(addressKey({ ...base, addressLine1: '1422 Pine St' }));
    expect(addressKey(base)).not.toBe(addressKey({ ...base, postalCode: '80304' }));
  });
});

describe('contentHash', () => {
  it('is stable for identical content', () => {
    expect(contentHash(listing())).toBe(contentHash(listing()));
  });

  it('ignores fields that churn on every poll', () => {
    expect(contentHash(listing())).toBe(
      contentHash(listing({
        fetchedAt: new Date('2027-01-01T00:00:00Z'),
        providerDaysOnMarket: 999,
        raw: { totally: 'different' },
      })),
    );
  });

  it('changes when price changes', () => {
    expect(contentHash(listing())).not.toBe(contentHash(listing({ listPrice: 750000 })));
  });

  it('changes when status changes', () => {
    expect(contentHash(listing())).not.toBe(contentHash(listing({ status: 'PENDING' })));
  });

  it('changes when a photo is added', () => {
    expect(contentHash(listing())).not.toBe(
      contentHash(listing({ photos: [{ url: 'a', order: 0 }] })),
    );
  });

  it('is unaffected by open-house array order', () => {
    const a = { startsAt: new Date('2026-08-16T19:00:00Z'), endsAt: new Date('2026-08-16T22:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    const b = { startsAt: new Date('2026-08-17T19:00:00Z'), endsAt: new Date('2026-08-17T22:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    expect(contentHash(listing({ openHouses: [a, b] })))
      .toBe(contentHash(listing({ openHouses: [b, a] })));
  });

  it('changes when an open house is actually added', () => {
    const a = { startsAt: new Date('2026-08-16T19:00:00Z'), endsAt: new Date('2026-08-16T22:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    expect(contentHash(listing())).not.toBe(contentHash(listing({ openHouses: [a] })));
  });
});

describe('canonicalOpenHouses', () => {
  it('produces a sorted, comparable representation', () => {
    const a = { startsAt: new Date('2026-08-17T19:00:00Z'), endsAt: new Date('2026-08-17T22:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    const b = { startsAt: new Date('2026-08-16T19:00:00Z'), endsAt: new Date('2026-08-16T22:00:00Z'), timezone: 'UTC', appointmentOnly: false, virtual: false };
    expect(canonicalOpenHouses([a, b])).toEqual(canonicalOpenHouses([b, a]));
    expect(canonicalOpenHouses([a, b])[0]).toContain('2026-08-16');
  });
});
