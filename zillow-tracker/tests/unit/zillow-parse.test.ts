import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseSearchPage, extractNextData, detectBlockPage, splitAddress,
  mapStatus, mapPropertyType, parseOpenHouses, ZillowParseError,
  decodeEntities,
} from '@/lib/providers/zillow/parse';
import { buildSearchUrl, slugify } from '@/lib/providers/zillow';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/zillow/${name}`, import.meta.url)), 'utf8');

/**
 * Prefers a REAL captured page when one exists (written by `npm run verify-live` on a
 * machine with internet access) and falls back to the constructed sample otherwise.
 * See fixtures/zillow/README.md for why the committed sample is not a real capture.
 */
function searchPage(): { html: string; real: boolean } {
  try {
    return { html: fixture('live-capture.html'), real: true };
  } catch {
    return { html: fixture('search-page.html'), real: false };
  }
}

const CTX = { timezone: 'America/Denver', fetchedAt: new Date('2026-08-15T12:00:00Z') };

describe('block detection', () => {
  it('recognizes a challenge page', () => {
    expect(detectBlockPage(fixture('blocked-page.html'))).toBeTruthy();
  });

  it('does not false-positive on a real results page', () => {
    expect(detectBlockPage(fixture('search-page.html'))).toBeNull();
  });

  it('throws a typed blocked error rather than a parse error', () => {
    try {
      extractNextData(fixture('blocked-page.html'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZillowParseError);
      expect((err as ZillowParseError).kind).toBe('blocked');
    }
  });
});

describe('parseSearchPage', () => {
  const result = parseSearchPage(fixture('search-page.html'), CTX);

  it('reports whether it is running against a real captured page', () => {
    const { real } = searchPage();
    if (!real) {
      console.warn('[zillow-parse] using the constructed sample; run `npm run verify-live` on a networked machine to capture a real page');
    }
    expect(typeof real).toBe('boolean');
  });

  it('parses every well-formed listing', () => {
    expect(result.listings).toHaveLength(3);
  });

  it('skips the malformed row without failing the run', () => {
    expect(result.skipped).toBe(1);
  });

  it('extracts core facts correctly', () => {
    const l = result.listings[0];
    expect(l.sourceListingId).toBe('13141234');
    expect(l.addressLine1).toBe('1420 Pine St');
    expect(l.city).toBe('Boulder');
    expect(l.state).toBe('CO');
    expect(l.postalCode).toBe('80302');
    expect(l.listPrice).toBe(875000);
    expect(l.beds).toBe(3);
    expect(l.bathsTotal).toBe(2);
    expect(l.livingAreaSqft).toBe(1840);
    expect(l.yearBuilt).toBe(1972);
    expect(l.status).toBe('ACTIVE');
    expect(l.propertyType).toBe('SINGLE_FAMILY');
  });

  it('stores price as a number, never a formatted string', () => {
    for (const l of result.listings) {
      if (l.listPrice != null) expect(typeof l.listPrice).toBe('number');
    }
  });

  it('builds an absolute listing URL from a relative detailUrl', () => {
    expect(result.listings[0].listingUrl).toBe(
      'https://www.zillow.com/homedetails/1420-Pine-St-Boulder-CO-80302/13141234_zpid/',
    );
  });

  it('maps a pending listing to PENDING', () => {
    expect(result.listings[1].status).toBe('PENDING');
    expect(result.listings[1].propertyType).toBe('CONDO');
    expect(result.listings[1].hoaFeeMonthly).toBe(385);
  });

  it('extracts open house windows including the virtual flag', () => {
    expect(result.listings[0].openHouses).toHaveLength(1);
    expect(result.listings[0].openHouses[0].startsAt).toBeInstanceOf(Date);
    expect(result.listings[2].openHouses[0].virtual).toBe(true);
  });

  it('leaves openHouses empty rather than inventing one', () => {
    expect(result.listings[1].openHouses).toEqual([]);
  });

  it('collects photo URLs without downloading them', () => {
    expect(result.listings[0].photos[0].url).toContain('zillowstatic.com');
  });
});

describe('open house time parsing', () => {
  it('accepts epoch milliseconds', () => {
    const [oh] = parseOpenHouses({ openHouseSchedules: [{ startTime: 1755370800000, endTime: 1755381600000 }] }, 'America/Denver');
    expect(oh.startsAt.getTime()).toBe(1755370800000);
  });

  it('accepts epoch seconds', () => {
    const [oh] = parseOpenHouses({ openHouseSchedules: [{ startTime: 1755370800, endTime: 1755381600 }] }, 'America/Denver');
    expect(oh.startsAt.getTime()).toBe(1755370800000);
  });

  it('accepts ISO strings', () => {
    const [oh] = parseOpenHouses({ openHouseSchedules: [{ startTime: '2026-08-16T19:00:00Z', endTime: '2026-08-16T22:00:00Z' }] }, 'America/Denver');
    expect(oh.startsAt.toISOString()).toBe('2026-08-16T19:00:00.000Z');
  });

  it('drops entries where the range is impossible', () => {
    expect(parseOpenHouses({ openHouseSchedules: [{ startTime: 200, endTime: 100 }] }, 'UTC')).toHaveLength(0);
    expect(parseOpenHouses({ openHouseSchedules: [{ startTime: null, endTime: null }] }, 'UTC')).toHaveLength(0);
  });

  it('returns empty for a listing with no schedule at all', () => {
    expect(parseOpenHouses({}, 'UTC')).toEqual([]);
  });
});

describe('address splitting', () => {
  it('splits a full address', () => {
    expect(splitAddress('1420 Pine St, Boulder, CO 80302')).toEqual({
      addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302',
    });
  });

  it('handles ZIP+4', () => {
    expect(splitAddress('1 A St, Denver, CO 80202-1234').postalCode).toBe('80202');
  });

  it('degrades without throwing on junk', () => {
    expect(splitAddress('nonsense').addressLine1).toBe('nonsense');
  });
});

describe('status and type mapping', () => {
  it('maps known values', () => {
    expect(mapStatus('FOR_SALE')).toBe('ACTIVE');
    expect(mapStatus('recently_sold')).toBe('SOLD');
    expect(mapPropertyType('CONDO')).toBe('CONDO');
  });

  it('falls back rather than throwing on unknown values', () => {
    expect(mapStatus('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(mapStatus(undefined)).toBe('UNKNOWN');
    expect(mapPropertyType('houseboat')).toBe('OTHER');
  });
});

describe('search URL building', () => {
  it('builds a ZIP URL', () => {
    expect(buildSearchUrl({ kind: 'postalCodes', codes: ['80302'] })).toBe('https://www.zillow.com/80302/');
  });

  it('builds an open-house URL', () => {
    expect(buildSearchUrl({ kind: 'postalCodes', codes: ['80302'] }, 1, true))
      .toBe('https://www.zillow.com/80302/open-house/');
  });

  it('adds the page segment past page 1', () => {
    expect(buildSearchUrl({ kind: 'cityRadius', city: 'Boulder', state: 'CO', radiusMiles: 5 }, 2))
      .toBe('https://www.zillow.com/boulder-co/2_p/');
  });

  it('refuses a polygon instead of silently querying the wrong area', () => {
    expect(() => buildSearchUrl({ kind: 'polygon', ring: [[0, 0], [1, 1], [0, 1]] }))
      .toThrow(/resolve it to ZIP codes/);
  });

  it('slugifies multi-word cities', () => {
    expect(slugify('Colorado Springs')).toBe('colorado-springs');
  });
});

/**
 * Regressions found by cross-checking against pyzill (github.com/johnbalvin/pyzill), a
 * library that actually issues requests to Zillow. Both bugs were invisible to the
 * hand-written fixture in this repo, and either would have broken the live provider on
 * its first contact with a real page.
 */
describe('validated against a working Zillow client', () => {
  const row = (zpid: number, street: string, price: number) => ({
    zpid,
    address: `${street}, Boulder, CO 80304`,
    unformattedPrice: price,
    statusType: 'FOR_SALE',
    hdpData: { homeInfo: {
      zpid, streetAddress: street, city: 'Boulder', state: 'CO', zipcode: '80304',
      price, homeType: 'SINGLE_FAMILY', homeStatus: 'FOR_SALE',
    } },
  });

  const blob = {
    props: { pageProps: { searchPageState: { cat1: { searchResults: {
      // The sidebar view: a strict subset.
      listResults: [row(111, '4072 Crystal Ct', 789000)],
      // The full result set for the searched area.
      mapResults: [
        row(111, '4072 Crystal Ct', 789000),
        row(222, '245 Linden Dr', 4250000),
        row(333, '1127 Juniper Ave', 3250000),
      ],
    } } } } },
  };

  const wrap = (inner: string) =>
    `<html><body><script id="__NEXT_DATA__" type="application/json">${inner}</script></body></html>`;
  const raw = JSON.stringify(blob);

  it('reads mapResults, not just the narrower listResults', () => {
    // pyzill: "use mapResults which contains all the listings from all paginations;
    // listResults is more for the right side bar". Preferring listResults returned the
    // page you can see rather than the area you asked for.
    const { listings } = parseSearchPage(wrap(raw), CTX);
    expect(listings).toHaveLength(3);
    expect(listings.map((l) => l.addressLine1).sort()).toEqual([
      '1127 Juniper Ave', '245 Linden Dr', '4072 Crystal Ct',
    ]);
  });

  it('deduplicates a home appearing in both result arrays', () => {
    const { listings } = parseSearchPage(wrap(raw), CTX);
    expect(listings.filter((l) => l.sourceListingId === '111')).toHaveLength(1);
  });

  it('parses a blob whose entities are HTML-escaped, as Zillow serves it', () => {
    // pyzill calls html.unescape() before json.loads(). Without that a real page throws
    // and is misreported as a schema change.
    const escaped = raw
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const { listings } = parseSearchPage(wrap(escaped), CTX);
    expect(listings).toHaveLength(3);
    expect(listings.find((l) => l.sourceListingId === '222')?.listPrice).toBe(4250000);
  });

  it('still parses an unescaped blob unchanged', () => {
    expect(parseSearchPage(wrap(raw), CTX).listings).toHaveLength(3);
  });

  it('decodes numeric and hex entities too', () => {
    expect(decodeEntities('&#34;a&#x26;b&#34;')).toBe('"a&b"');
  });
});
