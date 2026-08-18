import { describe, it, expect, vi, afterEach } from 'vitest';
import { diffListing, type PriorState } from '@/lib/ingest/diff';
import type { NormalizedListing, NormalizedOpenHouse } from '@/lib/providers/normalized';

/**
 * Adversarial probes of the pure diff engine.
 *
 * Tests prefixed BUG assert the behaviour a correct implementation would have; they FAIL
 * today and each one names a concrete defect. Tests prefixed OK document probes that the
 * implementation survived.
 */

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

function prior(over: Partial<PriorState> = {}): PriorState {
  return { status: 'ACTIVE', listPrice: 800000, description: null, photoCount: 0, openHouses: [], ...over };
}

function oh(over: Partial<NormalizedOpenHouse> = {}): NormalizedOpenHouse {
  return {
    startsAt: new Date('2026-08-22T17:00:00Z'),
    endsAt: new Date('2026-08-22T19:00:00Z'),
    timezone: 'America/Denver',
    appointmentOnly: false,
    virtual: false,
    ...over,
  };
}

const types = (evts: ReturnType<typeof diffListing>) => evts.map((e) => e.type);

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// D1 — diffListing is documented as a pure function of (previous, next) but reads
// the wall clock. Same inputs, different answers.
// ---------------------------------------------------------------------------
describe('D1 open-house cancellation depends on the wall clock', () => {
  it('BUG: identical (prev,next) inputs produce different events at different real times', () => {
    const scheduled = oh();
    const before = prior({ openHouses: [scheduled] });
    const after = listing({ openHouses: [] });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z')); // open house still upcoming
    const early = types(diffListing(before, after));

    vi.setSystemTime(new Date('2026-08-25T00:00:00Z')); // same inputs, clock moved on
    const late = types(diffListing(before, after));

    expect(early).toEqual(['OPEN_HOUSE_CANCELLED']);
    // A function documented as "a PURE function of (previous, next) ... testable without
    // a clock" must not change its answer because time passed.
    expect(late).toEqual(early);
  });

  it('honours an explicit `now`, so a backfill agrees with what the pipeline writes', () => {
    // pollArea(db, provider, area, { now }) is how runner.ts replays/backfills. Previously
    // syncOpenHouses() cancelled relative to the injected instant while diffListing() read
    // Date.now(), so the DB recorded a cancellation the event feed never showed. pollArea
    // now threads the same `now` into diffListing.
    const scheduled = oh({
      startsAt: new Date('2026-08-01T17:00:00Z'),
      endsAt: new Date('2026-08-01T19:00:00Z'),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00Z')); // wall clock: the OH is long past
    const injectedNow = new Date('2026-07-30T00:00:00Z'); // backfill instant: still upcoming

    const evts = types(
      diffListing(prior({ openHouses: [scheduled] }), listing({ openHouses: [] }), injectedNow),
    );
    expect(evts).toEqual(['OPEN_HOUSE_CANCELLED']);

    // And with no argument the answer comes from the data (fetchedAt), never the clock:
    // moving the system clock must not change it.
    const withoutArg = types(diffListing(prior({ openHouses: [scheduled] }), listing({ openHouses: [] })));
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const muchLater = types(diffListing(prior({ openHouses: [scheduled] }), listing({ openHouses: [] })));
    expect(muchLater).toEqual(withoutArg);
  });
});

// ---------------------------------------------------------------------------
// D2 — open-house detail changes that are rendered in the UI produce no event.
// ---------------------------------------------------------------------------
describe('D2 open-house timezone change is invisible to the diff', () => {
  it('BUG: correcting the timezone (which is what the UI renders in) emits nothing', () => {
    const evts = diffListing(
      prior({ openHouses: [oh({ timezone: 'America/Denver' })] }),
      listing({ openHouses: [oh({ timezone: 'America/New_York' })] }),
    );
    // 11:00 AM MDT vs 1:00 PM EDT — every open-house view renders a different hour.
    expect(types(evts)).toEqual(['OPEN_HOUSE_CHANGED']);
  });

  it('OK: appointmentOnly / virtual flips do emit OPEN_HOUSE_CHANGED', () => {
    expect(types(diffListing(
      prior({ openHouses: [oh()] }),
      listing({ openHouses: [oh({ virtual: true })] }),
    ))).toEqual(['OPEN_HOUSE_CHANGED']);
  });
});

// ---------------------------------------------------------------------------
// D3 — BACK_ON_MARKET fires out of UNKNOWN, which is the parser's failure sentinel.
// ---------------------------------------------------------------------------
describe('D3 BACK_ON_MARKET fires when the status parser recovers', () => {
  it('BUG: UNKNOWN -> ACTIVE is reported as "Back on market"', () => {
    // mapStatus() in the Zillow parser returns UNKNOWN for any token it does not know.
    // One upstream rename flips a whole area to UNKNOWN; fixing the map flips it back and
    // every listing in the area emits the app's highest-signal alert at once.
    const evts = diffListing(prior({ status: 'UNKNOWN' }), listing({ status: 'ACTIVE' }));
    expect(types(evts)).toEqual(['STATUS_CHANGE']);
  });

  it('OK: the genuinely actionable transitions do fire', () => {
    for (const from of ['PENDING', 'CONTINGENT', 'SOLD', 'WITHDRAWN', 'EXPIRED', 'OFF_MARKET'] as const) {
      expect(types(diffListing(prior({ status: from }), listing({ status: 'ACTIVE' }))))
        .toEqual(['STATUS_CHANGE', 'BACK_ON_MARKET']);
    }
  });
});

// ---------------------------------------------------------------------------
// D4 — degenerate prices.
// ---------------------------------------------------------------------------
describe('D4 degenerate list prices', () => {
  it('BUG: a rise from $0 is reported as a 0% change', () => {
    const [e] = diffListing(prior({ listPrice: 0 }), listing({ listPrice: 500000 }));
    expect(e.message).not.toContain('+0%'); // reads "Price increased $500,000 (+0%)"
  });

  // Resolved more strictly than this test first proposed. Rather than emitting a
  // sanitised PRICE_CHANGE, a non-finite price is treated as "no usable price" and no
  // event is synthesised at all — so nothing can reach the message or Prisma either way.
  it('a NaN price yields no event rather than a NaN delta', () => {
    const evts = diffListing(prior({ listPrice: 800000 }), listing({ listPrice: NaN }));
    expect(evts).toHaveLength(0);
    expect(JSON.stringify(evts)).not.toContain('NaN');
  });

  it('an Infinity price yields no event rather than a "$∞" message', () => {
    const evts = diffListing(prior({ listPrice: 800000 }), listing({ listPrice: Infinity }));
    expect(evts).toHaveLength(0);
    expect(JSON.stringify(evts)).not.toContain('∞');
  });

  it('OK: a negative price is at least arithmetically consistent', () => {
    const [e] = diffListing(prior({ listPrice: 700000 }), listing({ listPrice: -1 }));
    expect(e.deltaAbs).toBe(-700001);
  });

  it('OK: huge prices stay exact (no float drift in deltaAbs)', () => {
    const [e] = diffListing(prior({ listPrice: 1 }), listing({ listPrice: Number.MAX_SAFE_INTEGER }));
    expect(e.deltaAbs).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
});

// ---------------------------------------------------------------------------
// Probes that held up.
// ---------------------------------------------------------------------------
describe('probes the diff survived', () => {
  it('OK: a zero-length open house window is still keyed and diffed distinctly', () => {
    const zero = oh({ endsAt: new Date('2026-08-22T17:00:00Z') });
    expect(types(diffListing(prior({ openHouses: [] }), listing({ openHouses: [zero] }))))
      .toEqual(['OPEN_HOUSE_ADDED']);
    expect(types(diffListing(prior({ openHouses: [zero] }), listing({ openHouses: [oh()] }))))
      .toContain('OPEN_HOUSE_ADDED');
  });

  it('OK: all 72 ordered status pairs emit exactly one STATUS_CHANGE', () => {
    const all = ['ACTIVE', 'COMING_SOON', 'PENDING', 'CONTINGENT', 'SOLD',
      'WITHDRAWN', 'EXPIRED', 'OFF_MARKET', 'UNKNOWN'] as const;
    for (const a of all) for (const b of all) {
      if (a === b) continue;
      const evts = types(diffListing(prior({ status: a }), listing({ status: b })));
      expect(evts.filter((t) => t === 'STATUS_CHANGE')).toHaveLength(1);
    }
  });

  it('OK: reordered open houses are not a change', () => {
    const a = oh();
    const b = oh({ startsAt: new Date('2026-08-23T17:00:00Z'), endsAt: new Date('2026-08-23T19:00:00Z') });
    expect(diffListing(prior({ openHouses: [a, b] }), listing({ openHouses: [b, a] }))).toEqual([]);
  });
});
