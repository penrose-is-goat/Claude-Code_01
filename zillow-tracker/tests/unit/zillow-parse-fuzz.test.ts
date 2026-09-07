/**
 * Adversarial fuzzing of src/lib/providers/zillow/parse.ts.
 *
 * Tests named "DEFECT n" assert the behaviour the parser SHOULD have and currently fail.
 * Everything else passes and documents behaviour that holds up — in particular, a parser
 * that REJECTS garbage is behaving correctly and is not reported as a defect.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSearchPage, extractNextData, extractResults, detectBlockPage, splitAddress,
  parseOpenHouses, normalizeZillowResult, mapStatus, mapPropertyType, ZillowParseError,
} from '@/lib/providers/zillow/parse';

const CTX = { timezone: 'America/Denver', fetchedAt: new Date('2026-08-15T12:00:00Z') };

function page(results: unknown): string {
  return `<!DOCTYPE html><html><head><title>Boulder CO Homes | Zillow</title></head><body>
<div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { searchPageState: { cat1: { searchResults: { listResults: results } } } } },
  })}</script></body></html>`;
}

const GOOD = {
  zpid: '13141234',
  address: '1420 Pine St, Boulder, CO 80302',
  detailUrl: '/homedetails/1420-Pine-St-Boulder-CO-80302/13141234_zpid/',
  unformattedPrice: 875000,
  statusType: 'FOR_SALE',
  beds: 3, baths: 2, area: 1840,
};

const oh = (c: unknown, tz = 'America/Denver') =>
  parseOpenHouses({ openHouseSchedules: [c] }, tz);

// ---------------------------------------------------------------------------
// Behaviour that holds up
// ---------------------------------------------------------------------------

describe('zillow parse — cases that hold up', () => {
  it('truncated HTML fails loudly with no-blob', () => {
    expect(() => extractNextData('<html><script id="__NEXT_DATA__">{"props":{"page'))
      .toThrow(ZillowParseError);
  });

  it('a __NEXT_DATA__ blob with invalid JSON fails rather than half-parsing', () => {
    expect(() => extractNextData('<script id="__NEXT_DATA__">{nope,,}</script>'))
      .toThrow(ZillowParseError);
  });

  it('valid JSON of an unexpected shape produces a typed no-results error', () => {
    expect(() => extractResults({ totally: { different: 'schema' } })).toThrow(/changed its schema/);
    expect(() => extractResults(null)).toThrow(ZillowParseError);
    expect(() => extractResults('a string')).toThrow(ZillowParseError);
    expect(() => extractResults(42)).toThrow(ZillowParseError);
  });

  it('an empty-but-present results array is a legitimate zero-match, not an error', () => {
    expect(parseSearchPage(page([]), CTX)).toEqual({ listings: [], skipped: 0 });
  });

  it('5,000-deep nested JSON parses without a stack overflow', () => {
    const deep = '{"a":'.repeat(5000) + '1' + '}'.repeat(5000);
    expect(() => extractResults(extractNextData(`<script id="__NEXT_DATA__">${deep}</script>`)))
      .toThrow(ZillowParseError);
  });

  it('a very large blob (5,000 results) parses in reasonable time', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ ...GOOD, zpid: String(i) }));
    const t0 = Date.now();
    const { listings, skipped } = parseSearchPage(page(many), CTX);
    expect(listings).toHaveLength(5000);
    expect(skipped).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20000);
  }, 60000);

  it('nulls, primitives and shapeless objects in the results array are skipped, not fatal', () => {
    const { listings, skipped } = parseSearchPage(
      page([null, 42, 'a string', [], {}, { zpid: null }, GOOD]), CTX,
    );
    expect(listings).toHaveLength(1);
    expect(skipped).toBe(6);
  });

  it('a result with no usable street address is skipped', () => {
    const { listings, skipped } = parseSearchPage(page([{ zpid: '1' }]), CTX);
    expect(listings).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('prices arriving as formatted strings are cleaned into numbers', () => {
    expect(normalizeZillowResult({ ...GOOD, unformattedPrice: '$1,234,567' }, CTX).listPrice).toBe(1234567);
    expect(normalizeZillowResult({ ...GOOD, unformattedPrice: '+875000' }, CTX).listPrice).toBe(875000);
  });

  it('unparseable price shorthand is rejected rather than guessed at', () => {
    // "1.2M" has no defensible numeric reading — dropping it is correct.
    expect(normalizeZillowResult({ ...GOOD, unformattedPrice: '1.2M', price: '1.2M' }, CTX).listPrice)
      .toBeUndefined();
    expect(normalizeZillowResult({ ...GOOD, unformattedPrice: NaN, price: Infinity }, CTX).listPrice)
      .toBeUndefined();
  });

  it('unknown status and property-type strings degrade instead of throwing', () => {
    expect(mapStatus('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(mapStatus(42)).toBe('UNKNOWN');
    expect(mapPropertyType({})).toBe('OTHER');
  });

  it('the epoch seconds-vs-milliseconds cutoff is right for any realistic open house', () => {
    // 1e12 ms is 2001-09-09; no open house is ever scheduled before that, and no
    // seconds-epoch open house ever exceeds it, so the cutoff cannot misfire in practice.
    expect(oh({ startTime: 1755370800, endTime: 1755381600 })[0].startsAt.toISOString())
      .toBe('2025-08-16T19:00:00.000Z');
    expect(oh({ startTime: 1755370800000, endTime: 1755381600000 })[0].startsAt.toISOString())
      .toBe('2025-08-16T19:00:00.000Z');
    // Exactly at the boundary, treated as milliseconds — the correct reading.
    expect(oh({ startTime: 1e12, endTime: 1e12 + 3.6e6 })[0].startsAt.toISOString())
      .toBe('2001-09-09T01:46:40.000Z');
  });

  it('an open house whose end is at or before its start is dropped', () => {
    expect(oh({ startTime: 1755381600, endTime: 1755370800 })).toEqual([]);
    expect(oh({ startTime: 1755370800, endTime: 1755370800 })).toEqual([]);
  });

  it('unparseable open-house date strings are dropped, not invented', () => {
    expect(oh({ startTime: 'next Saturday', endTime: 'afternoon' })).toEqual([]);
    expect(oh({ startTime: null, endTime: null })).toEqual([]);
    expect(parseOpenHouses({ openHouseSchedules: 'not an array' }, 'UTC')).toEqual([]);
    expect(parseOpenHouses(null, 'UTC')).toEqual([]);
  });

  it('addresses with no commas, empty commas or a PO box do not throw', () => {
    expect(splitAddress('1420 Pine St').addressLine1).toBe('1420 Pine St');
    expect(splitAddress(',,,,').addressLine1).toBe(',,,,');
    expect(splitAddress('').addressLine1).toBe('');
    expect(splitAddress('PO Box 42, Nederland, CO 80466')).toEqual({
      addressLine1: 'PO Box 42', city: 'Nederland', state: 'CO', postalCode: '80466',
    });
    expect(splitAddress('1420 Pine St, Boulder, co 80302-1234')).toEqual({
      addressLine1: '1420 Pine St', city: 'Boulder', state: 'CO', postalCode: '80302',
    });
  });

  it('a unit number in the street segment is preserved', () => {
    expect(splitAddress('3300 Folsom St #12, Boulder, CO 80304').addressLine1)
      .toBe('3300 Folsom St #12');
  });

  it('one malformed result never fails the whole page', () => {
    const { listings, skipped } = parseSearchPage(page([{ boom: true }, GOOD, null]), CTX);
    expect(listings).toHaveLength(1);
    expect(skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DEFECTS
// ---------------------------------------------------------------------------

describe('zillow parse — DEFECTS', () => {
  it('DEFECT 1: block detection false-positives on ordinary listing prose', () => {
    // detectBlockPage runs over the ENTIRE raw HTML, which includes the __NEXT_DATA__
    // blob and therefore every listing description. "press and hold" is a substring of
    // perfectly ordinary marketing copy ("impress and hold its value"), and the phrase
    // is not anchored to word boundaries. One such listing discards the whole page of
    // results and reports the run as `blocked` — the state the provider treats as
    // "Zillow refused us, stop and fall back to CSV".
    const innocent = [
      'This home will impress and hold its value for decades.',
      'Custom wine press and hold-over cellar in the basement.',
      'HOA rules: access to this page has been denied to non-residents of the community portal.',
    ];
    for (const description of innocent) {
      expect(detectBlockPage(`<html><body><p>${description}</p></body></html>`), description).toBeNull();
    }

    const html = page([{ ...GOOD, statusText: 'This home will impress and hold its value.' }]);
    expect(detectBlockPage(html)).toBeNull();
    expect(() => parseSearchPage(html, CTX)).not.toThrow();
  });

  it('DEFECT 2: a numeric zpid silently discards the listing', () => {
    // JSON numbers are the natural encoding for zpid and Zillow has shipped both.
    // str() requires typeof string, so every result in such a payload is skipped —
    // the run reports zero listings with only a console.warn, which reads exactly like
    // "nothing matched your search".
    const numeric = { ...GOOD, zpid: 13141234 };
    expect(normalizeZillowResult(numeric, CTX).sourceListingId).toBe('13141234');

    const { listings, skipped } = parseSearchPage(page([numeric, { ...GOOD, zpid: 2 }]), CTX);
    expect(skipped).toBe(0);
    expect(listings).toHaveLength(2);
  });

  it('DEFECT 3: an epoch delivered as a numeric string drops the open house', () => {
    // num()/int() already accept numeric strings everywhere else in this file; toDate()
    // hands them to `new Date(string)`, which returns Invalid Date for "1755370800000".
    expect(oh({ startTime: '1755370800000', endTime: '1755381600000' })).toHaveLength(1);
    expect(oh({ startTime: '1755370800', endTime: '1755381600' })).toHaveLength(1);
  });

  it('DEFECT 4: open-house wall-clock strings ignore the listing timezone', () => {
    // NormalizedOpenHouse documents startsAt/endsAt as "Stored UTC", and the timezone is
    // carried alongside — but a zone-less string is resolved against the SERVER's local
    // zone, so the same payload yields a different instant depending on where the worker
    // runs, and never the listing's own zone. Parsing the same schedule as Denver and as
    // Tokyo must not produce the same UTC instant.
    const denver = oh({ startTime: '2026-08-16T13:00:00', endTime: '2026-08-16T15:00:00' }, 'America/Denver');
    const tokyo = oh({ startTime: '2026-08-16T13:00:00', endTime: '2026-08-16T15:00:00' }, 'Asia/Tokyo');
    expect(denver[0].startsAt.toISOString()).not.toBe(tokyo[0].startsAt.toISOString());
  });

  it('DEFECT 5: splitAddress silently deletes the middle of a multi-line address', () => {
    // A 4-part address keeps only parts[0] and parts[length-2]; the unit/second address
    // line vanishes, so two different units of the same building export as one address.
    expect(splitAddress('1420 Pine St, Apt 3, Boulder, CO 80302')).toEqual({
      addressLine1: '1420 Pine St, Apt 3', city: 'Boulder', state: 'CO', postalCode: '80302',
    });
  });

  it('DEFECT 6: detailUrl is concatenated onto the Zillow origin with no scheme check', () => {
    // Anything not literally starting with "http" is glued onto https://www.zillow.com
    // with no separator, and anything that does start with "http" (including "httpx://")
    // is trusted verbatim. The result becomes the clickable hyperlink in the xlsx export.
    expect(normalizeZillowResult({ ...GOOD, detailUrl: 'javascript:alert(1)' }, CTX).listingUrl)
      .not.toBe('https://www.zillow.comjavascript:alert(1)');
    expect(normalizeZillowResult({ ...GOOD, detailUrl: 'httpx://evil.example.com/x' }, CTX).listingUrl)
      .not.toBe('httpx://evil.example.com/x');
  });

  it('DEFECT 7: a malformed __NEXT_DATA__ blob is misreported as a missing blob', () => {
    // The blob was found and is broken, but the operator is told "No __NEXT_DATA__ blob
    // found in page", which points the investigation at the wrong thing.
    try {
      extractNextData('<script id="__NEXT_DATA__" type="application/json">{"props":,}</script>');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ZillowParseError).message).toMatch(/malformed|invalid JSON/i);
    }
  });
});
