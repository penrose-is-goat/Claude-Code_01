import { describe, it, expect } from 'vitest';
import { addressKey, normalizeStreet, contentHash } from '@/lib/ingest/hash';
import type { NormalizedListing } from '@/lib/providers/normalized';

/**
 * Adversarial probes of the two identity functions.
 *
 * addressKey is documented as "identity for the SAME listing across DIFFERENT providers"
 * and is what SavedListing (favorites, notes, ratings) is keyed on.
 * contentHash is the gate that decides whether the pipeline writes anything at all —
 * pipeline.upsertListing takes the fast path (touch lastSeenAt, write nothing else)
 * whenever it is unchanged, so a field the hash ignores can never be corrected in the DB.
 */

const BASE = { addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302' };
const key = (over: Partial<typeof BASE>) => addressKey({ ...BASE, ...over });

function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'mock',
    sourceListingId: '1',
    addressLine1: '1420 Pine St',
    city: 'Boulder',
    state: 'CO',
    postalCode: '80302',
    status: 'ACTIVE',
    propertyType: 'SINGLE_FAMILY',
    listPrice: 800000,
    photos: [],
    openHouses: [],
    raw: {},
    fetchedAt: new Date('2026-08-15T12:00:00Z'),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// H1 — contentHash ignores fields that toRow() writes, so those columns are
// write-once: the first value the provider ever reported is permanent.
// ---------------------------------------------------------------------------
describe('H1 contentHash cannot see corrections to identity/location fields', () => {
  const cases: Array<[string, Partial<NormalizedListing>, string]> = [
    ['the street address', { addressLine1: '1420 Pine Street Apt 4' },
      'addressKey is derived from it, so the saved-listing link goes stale too'],
    ['the city', { city: 'Louisville' }, 'wrong city shown and searched forever'],
    ['the postal code', { postalCode: '80303' }, 'ZIP filters and the postalCode index go wrong'],
    ['lat/lng', { lat: 40.02, lng: -105.27 }, 'a geocode fix never lands in the row'],
    ['propertyType', { propertyType: 'CONDO' }, 'the property-type filter stays permanently wrong'],
    ['listingUrl', { listingUrl: 'https://example.com/moved' }, 'the "open on Zillow" link stays dead'],
  ];

  for (const [label, over, why] of cases) {
    it(`BUG: a correction to ${label} leaves the hash unchanged — ${why}`, () => {
      expect(contentHash(listing(over))).not.toBe(contentHash(listing()));
    });
  }

  it('BUG: replacing every photo URL is invisible because only photos.length is hashed', () => {
    const a = listing({ photos: [{ url: 'https://a/1.jpg', order: 0 }, { url: 'https://a/2.jpg', order: 1 }] });
    const b = listing({ photos: [{ url: 'https://b/9.jpg', order: 0 }, { url: 'https://b/8.jpg', order: 1 }] });
    // A relisted / re-shot home keeps rendering the old, often now-404, photo URLs.
    expect(contentHash(b)).not.toBe(contentHash(a));
  });

  it('BUG: an open house whose timezone is corrected is invisible', () => {
    const oh = (timezone: string) => ({
      startsAt: new Date('2026-08-22T17:00:00Z'), endsAt: new Date('2026-08-22T19:00:00Z'),
      timezone, appointmentOnly: false, virtual: false,
    });
    // Every open-house view renders with `timeZone: oh.timezone`, so this is a
    // user-visible two-hour error that the pipeline can never repair.
    expect(contentHash(listing({ openHouses: [oh('America/New_York')] })))
      .not.toBe(contentHash(listing({ openHouses: [oh('America/Denver')] })));
  });

  it('OK: the fields it does cover really do move the hash', () => {
    const base = contentHash(listing());
    for (const over of [{ listPrice: 799000 }, { status: 'PENDING' as const }, { beds: 4 },
      { description: 'new copy' }, { photos: [{ url: 'x', order: 0 }] }, { yearBuilt: 1999 },
      { hoaFeeMonthly: 250 }, { livingAreaSqft: 2100 }, { lotSizeSqft: 8000 }, { bathsTotal: 3 }]) {
      expect(contentHash(listing(over))).not.toBe(base);
    }
  });

  it('OK: volatile fields are correctly excluded (this is what makes polling cheap)', () => {
    expect(contentHash(listing({ fetchedAt: new Date('2030-01-01') }))).toBe(contentHash(listing()));
    expect(contentHash(listing({ providerDaysOnMarket: 99 }))).toBe(contentHash(listing()));
    expect(contentHash(listing({ raw: { anything: true } }))).toBe(contentHash(listing()));
  });

  it('OK: open-house order does not move the hash', () => {
    const a = { startsAt: new Date('2026-08-22T17:00:00Z'), endsAt: new Date('2026-08-22T19:00:00Z'), timezone: 'America/Denver', appointmentOnly: false, virtual: false };
    const b = { ...a, startsAt: new Date('2026-08-23T17:00:00Z'), endsAt: new Date('2026-08-23T19:00:00Z') };
    expect(contentHash(listing({ openHouses: [a, b] }))).toBe(contentHash(listing({ openHouses: [b, a] })));
  });
});

// ---------------------------------------------------------------------------
// H2 — addressKey false splits (the same home gets two identities).
// ---------------------------------------------------------------------------
describe('H2 addressKey splits one home across providers', () => {
  it('BUG: "Apt 3" / "Unit 3" / "#3" produce three different keys for one condo', () => {
    // Zillow's streetAddress says "APT 3"; Redfin and most MLS CSV exports say "Unit 3".
    // Since SavedListing is keyed on addressKey, the provider swap this key exists to
    // survive is exactly what loses your notes and rating.
    const apt = key({ addressLine1: '1420 Pine St Apt 3' });
    const unit = key({ addressLine1: '1420 Pine St Unit 3' });
    const hash = key({ addressLine1: '1420 Pine St #3' });
    expect(unit).toBe(apt);
    expect(hash).toBe(apt);
  });

  it('OK: suffix and directional folding works as advertised', () => {
    expect(key({ addressLine1: '1420 North Pine Street' })).toBe(key({ addressLine1: '1420 N. Pine St.' }));
    // 'apt' now canonicalizes to 'unit' so Apt 2B / Unit 2B / #2B share one key — the
    // cross-provider identity fix this suite asked for in H2.
    expect(normalizeStreet('1234 North Elm Street  Apt. 2B')).toBe('1234 n elm st unit 2b');
  });

  it('OK: ZIP+4 folds to the 5-digit ZIP; case and whitespace are folded', () => {
    expect(key({ postalCode: '80302-1234' })).toBe(key({ postalCode: '80302' }));
    expect(key({ city: '  boulder ', state: 'co' })).toBe(key({}));
  });
});

// ---------------------------------------------------------------------------
// H3 — addressKey false merges (two homes share one identity). These are the
// dangerous direction: one home's favorite flag and notes attach to another.
// ---------------------------------------------------------------------------
describe('H3 addressKey merges different addresses', () => {
  it('BUG: addressLine2 is not part of the key at all', () => {
    // NormalizedListing carries addressLine2 and pipeline.toRow persists it, but
    // addressKey's parameter type does not even mention it. Any provider that puts the
    // unit in line 2 — the field's entire purpose — gives every unit in a building the
    // same cross-provider identity, so favorites/notes bleed between units.
    const unit1 = { ...BASE, addressLine2: 'Apt 1' };
    const unit2 = { ...BASE, addressLine2: 'Apt 2' };
    expect(addressKey(unit2)).not.toBe(addressKey(unit1));
  });

  it('BUG: "#" is stripped, so unit "W" collides with a directional street suffix', () => {
    // Seattle and Salt Lake City really do suffix streets with a direction, so
    // "1420 5th Ave W" (a house on Fifth Avenue West) and "1420 5th Ave #W"
    // (unit W at 1420 Fifth Avenue) are different homes that hash identically.
    expect(key({ addressLine1: '1420 5th Ave #W' })).not.toBe(key({ addressLine1: '1420 5th Ave W' }));
  });

  it('OK: a unit number in line 1 does keep units apart', () => {
    expect(key({ addressLine1: '1420 Pine St' })).not.toBe(key({ addressLine1: '1420 Pine St Apt 1' }));
    expect(key({ addressLine1: '1420 Pine St Apt 1' })).not.toBe(key({ addressLine1: '1420 Pine St Apt 2' }));
  });

  it('OK: different city/state/zip never collide', () => {
    expect(key({ city: 'Denver' })).not.toBe(key({}));
    expect(key({ state: 'CA' })).not.toBe(key({}));
    expect(key({ postalCode: '80304' })).not.toBe(key({}));
  });

  it('OK (documented, low risk): folding directionals anywhere merges "North St" into "N St"', () => {
    // USPS Pub 28 abbreviates a street literally named "North" the same way, so this
    // merge matches the postal standard rather than contradicting it.
    expect(key({ addressLine1: '100 North St' })).toBe(key({ addressLine1: '100 N St' }));
  });
});
