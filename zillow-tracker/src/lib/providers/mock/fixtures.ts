import type { NormalizedListing, NormalizedOpenHouse } from '../normalized';

/**
 * Deterministic three-run scenario.
 *
 * This exists so the entire pipeline — ingest, diff, events, notifications, Excel export
 * — is exercisable and demo-able with zero credentials and zero network. Every event
 * type the app can emit is triggered by some transition between these runs, which makes
 * it the fixture the unit tests assert against.
 *
 *   run 1 -> 8 baseline listings (2 with open houses)
 *   run 2 -> +2 new, 3 price drops, 1 -> PENDING, 2 open houses added, 1 price increase
 *   run 3 -> 1 SOLD, 1 back on market, 1 open house cancelled, 1 delisted (absent)
 */

const TZ = 'America/Denver';

/**
 * Anchored to the UPCOMING Saturday rather than a fixed calendar date.
 *
 * A hardcoded epoch rots: once that date passes, every demo open house is in the past,
 * the app shows an empty "this weekend" view, and cancellation logic can never fire
 * (correctly — a past open house ageing out is not a cancellation). Recomputing keeps
 * the demo sensible forever, and it stays stable within a single process.
 */
export const MOCK_EPOCH = upcomingSaturday();

function upcomingSaturday(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(12, 0, 0, 0);
  // 6 = Saturday. Always land at least one day out so "today" is never the anchor.
  const daysUntil = (6 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntil);
  return d;
}

function oh(dayOffset: number, startHour: number, endHour: number, extra: Partial<NormalizedOpenHouse> = {}): NormalizedOpenHouse {
  const base = new Date(MOCK_EPOCH);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const startsAt = new Date(base);
  startsAt.setUTCHours(startHour, 0, 0, 0);
  const endsAt = new Date(base);
  endsAt.setUTCHours(endHour, 0, 0, 0);
  return { startsAt, endsAt, timezone: TZ, appointmentOnly: false, virtual: false, ...extra };
}

interface Seed {
  id: string;
  addr: string;
  city: string;
  zip: string;
  lat: number;
  lng: number;
  price: number;
  beds: number;
  baths: number;
  sqft: number;
  year: number;
  type: NormalizedListing['propertyType'];
}

const SEEDS: Seed[] = [
  { id: '2001', addr: '1420 Pine St',        city: 'Boulder', zip: '80302', lat: 40.0189, lng: -105.2793, price: 875000,  beds: 3, baths: 2,   sqft: 1840, year: 1972, type: 'SINGLE_FAMILY' },
  { id: '2002', addr: '755 Marine St',       city: 'Boulder', zip: '80302', lat: 40.0043, lng: -105.2717, price: 1250000, beds: 4, baths: 3,   sqft: 2610, year: 1995, type: 'SINGLE_FAMILY' },
  { id: '2003', addr: '3300 Folsom St #12',  city: 'Boulder', zip: '80304', lat: 40.0311, lng: -105.2597, price: 465000,  beds: 2, baths: 2,   sqft: 1020, year: 2004, type: 'CONDO' },
  { id: '2004', addr: '2145 Norwood Ave',    city: 'Boulder', zip: '80304', lat: 40.0402, lng: -105.2778, price: 1690000, beds: 5, baths: 3.5, sqft: 3450, year: 2016, type: 'SINGLE_FAMILY' },
  { id: '2005', addr: '890 Alpine Ave',      city: 'Boulder', zip: '80304', lat: 40.0288, lng: -105.2831, price: 720000,  beds: 3, baths: 1.5, sqft: 1490, year: 1961, type: 'SINGLE_FAMILY' },
  { id: '2006', addr: '1177 Canyon Blvd',    city: 'Boulder', zip: '80302', lat: 40.0154, lng: -105.2836, price: 599000,  beds: 2, baths: 2,   sqft: 1180, year: 2010, type: 'TOWNHOUSE' },
  { id: '2007', addr: '4501 Thunderbird Dr', city: 'Boulder', zip: '80303', lat: 39.9905, lng: -105.2314, price: 545000,  beds: 3, baths: 2,   sqft: 1350, year: 1978, type: 'CONDO' },
  { id: '2008', addr: '625 Hawthorn Ave',    city: 'Boulder', zip: '80304', lat: 40.0341, lng: -105.2762, price: 1050000, beds: 4, baths: 2.5, sqft: 2240, year: 1988, type: 'SINGLE_FAMILY' },
  // Introduced in run 2:
  { id: '2009', addr: '1802 Mapleton Ave',   city: 'Boulder', zip: '80304', lat: 40.0227, lng: -105.2905, price: 1425000, beds: 4, baths: 3,   sqft: 2780, year: 1922, type: 'SINGLE_FAMILY' },
  { id: '2010', addr: '3155 28th St #4B',    city: 'Boulder', zip: '80301', lat: 40.0294, lng: -105.2540, price: 389000,  beds: 1, baths: 1,   sqft: 760,  year: 1999, type: 'CONDO' },
];

function build(seed: Seed, overrides: Partial<NormalizedListing> = {}): NormalizedListing {
  return {
    providerId: 'mock',
    sourceListingId: seed.id,
    mlsId: `IRES${seed.id}`,
    mlsName: 'IRES MLS',
    addressLine1: seed.addr,
    city: seed.city,
    state: 'CO',
    postalCode: seed.zip,
    county: 'Boulder',
    lat: seed.lat,
    lng: seed.lng,
    status: 'ACTIVE',
    propertyType: seed.type,
    listPrice: seed.price,
    originalListPrice: seed.price,
    beds: seed.beds,
    bathsTotal: seed.baths,
    bathsFull: Math.floor(seed.baths),
    bathsHalf: seed.baths % 1 >= 0.5 ? 1 : 0,
    livingAreaSqft: seed.sqft,
    lotSizeSqft: seed.type === 'CONDO' ? undefined : seed.sqft * 4,
    yearBuilt: seed.year,
    hoaFeeMonthly: seed.type === 'CONDO' ? 385 : undefined,
    taxAnnual: Math.round(seed.price * 0.0055),
    listingUrl: `https://www.zillow.com/homedetails/${seed.id}_zpid/`,
    listedAt: new Date(MOCK_EPOCH.getTime() - 21 * 864e5),
    providerDaysOnMarket: 21,
    listingAgentName: 'Dana Reyes',
    listingOfficeName: 'Front Range Realty',
    description: `Charming ${seed.beds}-bedroom ${seed.type.toLowerCase().replace(/_/g, ' ')} in ${seed.city}.`,
    photos: [
      { url: `https://photos.zillowstatic.com/fp/${seed.id}-a.jpg`, order: 0 },
      { url: `https://photos.zillowstatic.com/fp/${seed.id}-b.jpg`, order: 1 },
    ],
    openHouses: [],
    raw: { mock: true, seedId: seed.id },
    fetchedAt: MOCK_EPOCH,
    ...overrides,
  };
}

const byId = (id: string) => SEEDS.find((s) => s.id === id)!;

/** Run 1 — baseline. Two listings already have open houses on the books. */
export function run1(): NormalizedListing[] {
  return SEEDS.slice(0, 8).map((s) => {
    if (s.id === '2001') return build(s, { openHouses: [oh(0, 19, 22)] });
    if (s.id === '2004') return build(s, { openHouses: [oh(1, 18, 20)] });
    return build(s);
  });
}

/** Run 2 — the interesting one. Exercises price drops, a rise, status, and new stock. */
export function run2(): NormalizedListing[] {
  const out: NormalizedListing[] = [];

  out.push(build(byId('2001'), { listPrice: 849000, openHouses: [oh(0, 19, 22)] }));       // price drop
  out.push(build(byId('2002'), { listPrice: 1195000 }));                                    // price drop
  out.push(build(byId('2003'), { status: 'PENDING' }));                                     // status change
  out.push(build(byId('2004'), { openHouses: [oh(1, 18, 20), oh(2, 17, 19)] }));            // open house added
  out.push(build(byId('2005'), { listPrice: 699000 }));                                     // price drop
  out.push(build(byId('2006'), { listPrice: 615000 }));                                     // price INCREASE
  out.push(build(byId('2007'), { openHouses: [oh(1, 20, 22, { virtual: true })] }));        // open house added
  out.push(build(byId('2008'), {
    photos: [
      { url: 'https://photos.zillowstatic.com/fp/2008-a.jpg', order: 0 },
      { url: 'https://photos.zillowstatic.com/fp/2008-b.jpg', order: 1 },
      { url: 'https://photos.zillowstatic.com/fp/2008-c.jpg', order: 2 },
    ],
  }));                                                                                       // photos added
  out.push(build(byId('2009')));                                                             // NEW
  out.push(build(byId('2010'), { openHouses: [oh(1, 17, 19)] }));                            // NEW + open house

  return out;
}

/** Run 3 — the endings. Sold, back-on-market, a cancellation, and one that vanishes. */
export function run3(): NormalizedListing[] {
  const out: NormalizedListing[] = [];

  out.push(build(byId('2001'), { listPrice: 849000, status: 'SOLD', openHouses: [] }));
  out.push(build(byId('2002'), { listPrice: 1195000 }));
  out.push(build(byId('2003'), { status: 'ACTIVE' }));                                       // BACK_ON_MARKET
  out.push(build(byId('2004'), { openHouses: [oh(1, 18, 20)] }));                            // one cancelled
  out.push(build(byId('2005'), { listPrice: 699000 }));
  out.push(build(byId('2006'), { listPrice: 615000 }));
  // 2007 deliberately absent -> absence counter increments (needs 2 runs to delist)
  out.push(build(byId('2008')));
  out.push(build(byId('2009')));
  out.push(build(byId('2010'), { openHouses: [oh(1, 17, 19)] }));

  return out;
}

export const RUNS: Array<() => NormalizedListing[]> = [run1, run2, run3];
