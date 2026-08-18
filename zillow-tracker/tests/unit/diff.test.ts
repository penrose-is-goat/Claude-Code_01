import { describe, it, expect } from 'vitest';
import { diffListing, type PriorState } from '@/lib/ingest/diff';
import type { NormalizedListing, NormalizedOpenHouse } from '@/lib/providers/normalized';

function listing(over: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'snapshot',
    sourceListingId: '1',
    addressLine1: '4072 Crystal Ct',
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

function prior(over: Partial<PriorState> = {}): PriorState {
  return { status: 'ACTIVE', listPrice: 800000, description: null, photoCount: 0, openHouses: [], ...over };
}

/** Far enough in the future that "already ended" logic never fires accidentally. */
function futureOh(over: Partial<NormalizedOpenHouse> = {}): NormalizedOpenHouse {
  const startsAt = new Date(Date.now() + 3 * 864e5);
  const endsAt = new Date(startsAt.getTime() + 2 * 36e5);
  return { startsAt, endsAt, timezone: 'America/Denver', appointmentOnly: false, virtual: false, ...over };
}

const types = (evts: ReturnType<typeof diffListing>) => evts.map((e) => e.type).sort();

describe('diffListing — first sighting', () => {
  it('emits exactly one NEW_LISTING', () => {
    expect(types(diffListing(null, listing()))).toEqual(['NEW_LISTING']);
  });

  it('also surfaces open houses attached on first sight', () => {
    const evts = diffListing(null, listing({ openHouses: [futureOh()] }));
    expect(types(evts)).toEqual(['NEW_LISTING', 'OPEN_HOUSE_ADDED']);
  });

  it('includes the price in the message', () => {
    const [e] = diffListing(null, listing({ listPrice: 875000 }));
    expect(e.message).toContain('$875,000');
  });
});

describe('diffListing — price', () => {
  it('reports a drop with a negative delta', () => {
    const evts = diffListing(prior({ listPrice: 800000 }), listing({ listPrice: 750000 }));
    expect(evts).toHaveLength(1);
    expect(evts[0].type).toBe('PRICE_CHANGE');
    expect(evts[0].deltaAbs).toBe(-50000);
    expect(evts[0].deltaPct).toBeCloseTo(-6.25, 2);
    expect(evts[0].message).toContain('dropped');
  });

  it('reports an increase with a positive delta', () => {
    const evts = diffListing(prior({ listPrice: 800000 }), listing({ listPrice: 850000 }));
    expect(evts[0].deltaAbs).toBe(50000);
    expect(evts[0].message).toContain('increased');
  });

  it('is silent when the price is unchanged', () => {
    expect(diffListing(prior(), listing())).toHaveLength(0);
  });

  it('does not invent a change when either side is missing a price', () => {
    expect(diffListing(prior({ listPrice: null }), listing({ listPrice: 800000 }))).toHaveLength(0);
    expect(diffListing(prior({ listPrice: 800000 }), listing({ listPrice: undefined }))).toHaveLength(0);
  });
});

describe('diffListing — status', () => {
  it('emits STATUS_CHANGE on a transition', () => {
    const evts = diffListing(prior(), listing({ status: 'PENDING' }));
    expect(types(evts)).toEqual(['STATUS_CHANGE']);
  });

  it('emits BACK_ON_MARKET alongside STATUS_CHANGE when returning to active', () => {
    const evts = diffListing(prior({ status: 'PENDING' }), listing({ status: 'ACTIVE' }));
    expect(types(evts)).toEqual(['BACK_ON_MARKET', 'STATUS_CHANGE']);
  });

  it('does NOT treat active -> pending as back on market', () => {
    const evts = diffListing(prior({ status: 'ACTIVE' }), listing({ status: 'PENDING' }));
    expect(types(evts)).not.toContain('BACK_ON_MARKET');
  });

  it('treats coming soon as on-market for back-on-market purposes', () => {
    const evts = diffListing(prior({ status: 'CONTINGENT' }), listing({ status: 'COMING_SOON' }));
    expect(types(evts)).toContain('BACK_ON_MARKET');
  });
});

describe('diffListing — open houses', () => {
  it('detects an added open house', () => {
    const evts = diffListing(prior(), listing({ openHouses: [futureOh()] }));
    expect(types(evts)).toEqual(['OPEN_HOUSE_ADDED']);
  });

  it('detects a cancelled future open house', () => {
    const oh = futureOh();
    const evts = diffListing(prior({ openHouses: [oh] }), listing({ openHouses: [] }));
    expect(types(evts)).toEqual(['OPEN_HOUSE_CANCELLED']);
  });

  it('does not call a PAST open house dropping out a cancellation', () => {
    const startsAt = new Date(Date.now() - 5 * 864e5);
    const past = futureOh({ startsAt, endsAt: new Date(startsAt.getTime() + 2 * 36e5) });
    const evts = diffListing(prior({ openHouses: [past] }), listing({ openHouses: [] }));
    expect(evts).toHaveLength(0);
  });

  it('is order-independent', () => {
    const a = futureOh();
    const b = futureOh({ startsAt: new Date(Date.now() + 5 * 864e5) });
    const evts = diffListing(prior({ openHouses: [a, b] }), listing({ openHouses: [b, a] }));
    expect(evts).toHaveLength(0);
  });

  it('detects a change to virtual/appointment flags', () => {
    const oh = futureOh();
    const evts = diffListing(
      prior({ openHouses: [oh] }),
      listing({ openHouses: [{ ...oh, virtual: true }] }),
    );
    expect(types(evts)).toEqual(['OPEN_HOUSE_CHANGED']);
  });
});

describe('diffListing — photos and description', () => {
  it('emits PHOTOS_ADDED only when the count rises', () => {
    const withPhotos = listing({ photos: [{ url: 'a', order: 0 }, { url: 'b', order: 1 }] });
    expect(types(diffListing(prior({ photoCount: 0 }), withPhotos))).toEqual(['PHOTOS_ADDED']);
    expect(diffListing(prior({ photoCount: 5 }), withPhotos)).toHaveLength(0);
  });

  it('emits DESCRIPTION_CHANGED on real edits but ignores whitespace', () => {
    expect(
      types(diffListing(prior({ description: 'Old' }), listing({ description: 'New' }))),
    ).toEqual(['DESCRIPTION_CHANGED']);
    expect(
      diffListing(prior({ description: 'Same' }), listing({ description: '  Same  ' })),
    ).toHaveLength(0);
  });
});

describe('diffListing — combinations', () => {
  it('reports every independent change in one pass', () => {
    const evts = diffListing(
      prior({ status: 'PENDING', listPrice: 900000, photoCount: 1 }),
      listing({
        status: 'ACTIVE',
        listPrice: 850000,
        photos: [{ url: 'a', order: 0 }, { url: 'b', order: 1 }],
        openHouses: [futureOh()],
      }),
    );
    expect(types(evts)).toEqual([
      'BACK_ON_MARKET', 'OPEN_HOUSE_ADDED', 'PHOTOS_ADDED', 'PRICE_CHANGE', 'STATUS_CHANGE',
    ]);
  });
});
