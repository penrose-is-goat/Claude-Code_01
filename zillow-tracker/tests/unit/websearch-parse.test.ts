import { describe, expect, it } from 'vitest';
import {
  classifyStatus, parseHomedetailsUrl, parseIndexPage, parseListingTitle,
  parseMetaDescription, toListing,
} from '../../src/lib/providers/websearch/parse';
import { slugToLabel, streetOf } from '../../src/lib/providers/websearch/sweep';

/**
 * Provenance of the fixtures in this file, stated because the project forbids invented
 * data and a reader deserves to know which is which:
 *
 *  - Every URL and every `title` below was returned verbatim by a real web search of the
 *    public index on 2026-08-21. They are captures.
 *  - The `description` strings are SPECIMENS of Zillow's documented meta-description
 *    format, not captures — the search tool used to collect the titles returns a
 *    summary rather than the raw snippet, so the exact bytes could not be captured here.
 *    A live backend (Brave/Google CSE) returns the real string, and `npm run harvest`
 *    on a networked machine is what proves these specimens match it.
 *
 * No listing fact asserted anywhere in this repo's datasets comes from a specimen.
 */

const FETCHED_AT = new Date('2026-08-21T12:00:00Z');

describe('parseHomedetailsUrl', () => {
  it('extracts the zpid and slug from a real listing URL', () => {
    const ref = parseHomedetailsUrl(
      'https://www.zillow.com/homedetails/1655-Walnut-St-UNIT-106-Boulder-CO-80302/88908043_zpid/',
    );
    expect(ref).toEqual({
      zpid: '88908043',
      slug: '1655-Walnut-St-UNIT-106-Boulder-CO-80302',
      canonicalUrl:
        'https://www.zillow.com/homedetails/1655-Walnut-St-UNIT-106-Boulder-CO-80302/88908043_zpid/',
    });
  });

  it('accepts the slugless short form Zillow also emits', () => {
    expect(parseHomedetailsUrl('https://www.zillow.com/homedetails/13184933_zpid/')?.zpid)
      .toBe('13184933');
  });

  it('strips tracking parameters by rebuilding the canonical URL', () => {
    const ref = parseHomedetailsUrl(
      'https://www.zillow.com/homedetails/4370-Butler-Cir-Boulder-CO-80305/13184933_zpid/?utm_source=x',
    );
    expect(ref?.canonicalUrl).toBe(
      'https://www.zillow.com/homedetails/4370-Butler-Cir-Boulder-CO-80305/13184933_zpid/',
    );
  });

  it('rejects the index, directory and off-site pages that share the result set', () => {
    // Every one of these came back from the same searches as the listings above.
    for (const url of [
      'https://www.zillow.com/boulder-co/',
      'https://www.zillow.com/boulder-co/houses/',
      'https://www.zillow.com/boulder-co-80301/open-house/',
      'https://www.zillow.com/central-boulder-boulder-co/open-house/',
      'https://www.redfin.com/CO/Boulder/1655-Walnut-St-80302/home/12345',
      'not a url',
    ]) {
      expect(parseHomedetailsUrl(url), url).toBeNull();
    }
  });

  it('refuses a lookalike host', () => {
    expect(parseHomedetailsUrl('https://zillow.com.evil.test/homedetails/1_zpid/')).toBeNull();
  });
});

describe('parseListingTitle', () => {
  it('reads address and MLS number from a three-segment title', () => {
    expect(parseListingTitle('1655 Walnut St #309, Boulder, CO 80302 | MLS #1025654 | Zillow'))
      .toEqual({
        addressLine1: '1655 Walnut St #309',
        city: 'Boulder',
        state: 'CO',
        postalCode: '80302',
        mlsId: '1025654',
      });
  });

  it('reads a two-segment title, leaving the MLS number absent rather than guessed', () => {
    const t = parseListingTitle('4370 Butler Cir, Boulder, CO 80305 | Zillow');
    expect(t?.addressLine1).toBe('4370 Butler Cir');
    expect(t?.mlsId).toBeUndefined();
  });

  it('reads a bare title with no Zillow suffix at all', () => {
    expect(parseListingTitle('1655 Walnut St Ste 106, Boulder, CO 80302')?.addressLine1)
      .toBe('1655 Walnut St Ste 106');
  });

  it('returns null when no segment carries a state and ZIP', () => {
    expect(parseListingTitle('Boulder CO Real Estate - Boulder CO Homes For Sale | Zillow'))
      .toBeNull();
    expect(parseListingTitle('')).toBeNull();
  });
});

describe('parseMetaDescription', () => {
  const ACTIVE =
    'Zillow has 39 photos of this $1,470,000 2 beds, 3 baths, 2,094 Square Feet condo home ' +
    'located at 1655 Walnut St UNIT 106, Boulder, CO 80302 built in 2009. MLS #950962.';

  it('reads every published fact from the canonical format', () => {
    expect(parseMetaDescription(ACTIVE)).toEqual({
      listPrice: 1470000,
      photoCount: 39,
      beds: 2,
      bathsTotal: 3,
      livingAreaSqft: 2094,
      propertyType: 'CONDO',
      yearBuilt: 2009,
      mlsId: '950962',
      addressText: '1655 Walnut St UNIT 106, Boulder, CO 80302',
    });
  });

  it('leaves omitted fields undefined instead of defaulting them', () => {
    const facts = parseMetaDescription(
      'Zillow has 25 photos of this 4 beds, 3 baths, 2,800 Square Feet single family home ' +
      'located at 9 Specimen St, Boulder, CO 80301.',
    );
    expect(facts.listPrice).toBeUndefined();
    expect(facts.yearBuilt).toBeUndefined();
    expect(facts.mlsId).toBeUndefined();
    expect(facts.beds).toBe(4);
    expect(facts.propertyType).toBe('SINGLE_FAMILY');
  });

  it('reads a rent figure as rent, never as a list price', () => {
    const facts = parseMetaDescription('This 2 beds, 1 bath apartment is $2,500/mo.');
    expect(facts.monthlyRent).toBe(2500);
    expect(facts.listPrice).toBeUndefined();
  });

  it('keeps half baths', () => {
    expect(parseMetaDescription('3 beds, 2.5 baths, 1,900 Square Feet').bathsTotal).toBe(2.5);
  });

  it('does not mistake a placeholder price for a real one', () => {
    expect(parseMetaDescription('Listed for $0. 3 beds.').listPrice).toBeUndefined();
  });

  it('rejects an implausible year rather than storing it', () => {
    expect(parseMetaDescription('built in 20090.').yearBuilt).toBeUndefined();
  });

  it('prefers the most specific home type', () => {
    expect(parseMetaDescription('multi family home').propertyType).toBe('MULTI_FAMILY');
    expect(parseMetaDescription('single family home').propertyType).toBe('SINGLE_FAMILY');
    expect(parseMetaDescription('townhouse').propertyType).toBe('TOWNHOUSE');
  });

  it('returns an empty object for a missing description', () => {
    expect(parseMetaDescription(undefined)).toEqual({});
  });
});

describe('classifyStatus', () => {
  const verdict = (title: string, desc: string) =>
    classifyStatus(title, desc, parseMetaDescription(desc));

  it('calls a priced listing active', () => {
    expect(verdict('1 A St, Boulder, CO 80301 | MLS #1 | Zillow', 'this $900,000 3 beds home'))
      .toMatchObject({ status: 'ACTIVE', forSale: true });
  });

  it('excludes a home with no published price — Zillow omits it when not selling', () => {
    expect(verdict('9 Specimen St, Boulder, CO 80301 | Zillow', '4 beds, 3 baths, 2,800 Square Feet'))
      .toMatchObject({ status: 'OFF_MARKET', forSale: false });
  });

  it('excludes sale history even when a dollar figure is present', () => {
    // This is the trap: "last sold for $1,200,000" parses as a price. Without the
    // sale-history check a house that sold in 2021 lands in "homes for sale".
    expect(verdict('1655 Walnut St UNIT 101, Boulder, CO 80302 | Zillow',
      'last sold on 3/23/2021 for $1,200,000'))
      .toMatchObject({ status: 'SOLD', forSale: false });
  });

  it('excludes rentals', () => {
    expect(verdict('1 A St, Boulder, CO 80301', 'available for rent at $2,500/mo'))
      .toMatchObject({ forSale: false });
  });

  it('excludes the explicit not-for-sale wording the index actually returns', () => {
    expect(verdict('9 Specimen St, Boulder, CO 80305', 'Other Properties (Not Currently for Sale)'))
      .toMatchObject({ forSale: false });
  });

  it('keeps pending and coming-soon homes, which are still on the market', () => {
    expect(verdict('1 A St, Boulder, CO 80301', 'Pending. $900,000 3 beds'))
      .toMatchObject({ status: 'PENDING', forSale: true });
    expect(verdict('1 A St, Boulder, CO 80301', 'Coming soon. $900,000'))
      .toMatchObject({ status: 'COMING_SOON', forSale: true });
  });

  it('keeps a genuinely listed home whose snippet omitted the price, on the MLS tell', () => {
    // Real capture, 2026-08-21: this title carried an MLS number while the search
    // snippet gave only size and bed count. Without the MLS signal it was discarded.
    const v = verdict('2055 Kalmia Avenue, Boulder, CO 80304 | MLS #8169666',
      '2,765 square feet single family home with 3 bedrooms and 3 bathrooms, built in 1983');
    expect(v).toMatchObject({ status: 'ACTIVE', forSale: true });
    expect(v.reason).toMatch(/MLS record/);
  });

  it('still excludes a home with neither a price nor an MLS number', () => {
    expect(verdict('2205 Grove Cir, Boulder, CO 80302 | Zillow',
      '1500 square feet single family home with 3 bedrooms and 2 bathrooms'))
      .toMatchObject({ status: 'OFF_MARKET', forSale: false });
  });

  it('does not let an MLS number override sold or rental evidence', () => {
    expect(verdict('1 A St, Boulder, CO 80301 | MLS #1 | Zillow', 'last sold for $1,200,000'))
      .toMatchObject({ forSale: false });
    expect(verdict('1 A St, Boulder, CO 80301 | MLS #1 | Zillow', 'for rent at $3,200/mo'))
      .toMatchObject({ forSale: false });
  });

  it('does not read "sold as-is" in an active listing as a sale', () => {
    expect(verdict('1 A St, Boulder, CO 80301 | MLS #1 | Zillow',
      'this $900,000 3 beds home being sold as-is'))
      .toMatchObject({ status: 'ACTIVE', forSale: true });
  });
});

describe('parseIndexPage', () => {
  it('reads the market size Zillow publishes in its own title', () => {
    expect(parseIndexPage({
      url: 'https://www.zillow.com/boulder-co/open-house/',
      title: 'Boulder CO Open Houses - 61 Upcoming | Zillow',
    })).toMatchObject({ scopeLabel: 'Boulder CO Open Houses', kind: 'openHouse', count: 61, page: 1 });
  });

  it('reads a for-sale count with a thousands separator', () => {
    expect(parseIndexPage({
      url: 'https://www.zillow.com/boulder-county-co/houses/',
      title: 'Boulder County CO Single Family Homes For Sale - 1042 Homes | Zillow',
    })?.count).toBe(1042);
  });

  it('recognizes the neighborhood directory Zillow exposes', () => {
    const page = parseIndexPage({
      url: 'https://www.zillow.com/central-boulder-boulder-co/open-house/',
      title: 'Central Boulder Boulder Open Houses - 26 Upcoming | Zillow',
    });
    expect(page?.areaSlug).toBe('central-boulder-boulder-co');
    expect(page?.count).toBe(26);
  });

  it('reads a ZIP-scoped page and its pagination suffix', () => {
    expect(parseIndexPage({
      url: 'https://www.zillow.com/boulder-co-80301/houses/',
      title: '80301 Single Family Homes For Sale - 67 Homes | Zillow',
    })).toMatchObject({ areaSlug: 'boulder-co-80301', count: 67, kind: 'forSale' });

    expect(parseIndexPage({
      url: 'https://www.zillow.com/boulder-county-co/open-house/2_p/',
      title: 'Boulder County CO Open Houses - 219 Upcoming | Zillow',
    })?.page).toBe(2);
  });

  it('does not read a ZIP code as a market count', () => {
    // Real title, 2026-08-21. Matching the count anywhere in the title turned this ZIP
    // into a market of 80,305 homes and then into a coverage denominator.
    const page = parseIndexPage({
      url: 'https://www.zillow.com/boulder-co-80305/',
      title: '80305 Real Estate - 80305 Homes For Sale | Zillow',
    });
    expect(page).not.toBeNull();
    expect(page?.count).toBeUndefined();
  });

  it('is not fooled by a listing page', () => {
    expect(parseIndexPage({
      url: 'https://www.zillow.com/homedetails/4370-Butler-Cir-Boulder-CO-80305/13184933_zpid/',
      title: '4370 Butler Cir, Boulder, CO 80305 | Zillow',
    })).toBeNull();
  });

  it('returns the page without a count when the title states none', () => {
    const page = parseIndexPage({
      url: 'https://www.zillow.com/boulder-co/',
      title: 'Boulder CO Real Estate - Boulder CO Homes For Sale | Zillow',
    });
    expect(page?.count).toBeUndefined();
    expect(page?.areaSlug).toBe('boulder-co');
  });
});

describe('toListing', () => {
  const active = {
    url: 'https://www.zillow.com/homedetails/1655-Walnut-St-UNIT-106-Boulder-CO-80302/88908043_zpid/',
    title: '1655 Walnut St UNIT 106, Boulder, CO 80302 | MLS #950962 | Zillow',
    description:
      'Zillow has 39 photos of this $1,470,000 2 beds, 3 baths, 2,094 Square Feet condo home ' +
      'located at 1655 Walnut St UNIT 106, Boulder, CO 80302 built in 2009. MLS #950962.',
  };

  it('assembles a listing that deep-links back to Zillow', () => {
    const { listing } = toListing(active, { fetchedAt: FETCHED_AT });
    expect(listing).toMatchObject({
      providerId: 'websearch',
      sourceListingId: '88908043',
      mlsId: '950962',
      addressLine1: '1655 Walnut St UNIT 106',
      city: 'Boulder',
      state: 'CO',
      postalCode: '80302',
      status: 'ACTIVE',
      propertyType: 'CONDO',
      listPrice: 1470000,
      listingUrl: active.url,
    });
  });

  it('never invents coordinates, photos, or open houses', () => {
    const { listing } = toListing(active, { fetchedAt: FETCHED_AT });
    expect(listing?.lat).toBeUndefined();
    expect(listing?.lng).toBeUndefined();
    expect(listing?.photos).toEqual([]);
    expect(listing?.openHouses).toEqual([]);
  });

  it('drops a non-listing result with a stated reason', () => {
    const { listing, dropped } = toListing(
      { url: 'https://www.zillow.com/boulder-co/houses/', title: 'Boulder CO ... | Zillow' },
      { fetchedAt: FETCHED_AT },
    );
    expect(listing).toBeUndefined();
    expect(dropped?.reason).toMatch(/homedetails/);
  });

  it('drops an off-market home by default and keeps it when explicitly asked', () => {
    const offMarket = {
      url: 'https://www.zillow.com/homedetails/9-Specimen-St-Boulder-CO-80301/13185000_zpid/',
      title: '9 Specimen St, Boulder, CO 80301 | Zillow',
      description: 'Zillow has 25 photos of this 4 beds, 3 baths, 2,800 Square Feet home.',
    };
    expect(toListing(offMarket, { fetchedAt: FETCHED_AT }).dropped?.reason).toMatch(/not for sale/);
    expect(toListing(offMarket, { fetchedAt: FETCHED_AT, requireForSale: false }).listing?.status)
      .toBe('OFF_MARKET');
  });
});

describe('streetOf', () => {
  it('reduces an address to the street that can be swept', () => {
    expect(streetOf('1655 Walnut St UNIT 106')).toBe('Walnut St');
    expect(streetOf('4370 Butler Cir')).toBe('Butler Cir');
    expect(streetOf('718 Emerson Gulch Road')).toBe('Emerson Gulch Road');
    expect(streetOf('118 Crooked Spur')).toBeNull(); // no recognizable street type
  });

  it('drops unit designators so two units yield one street query', () => {
    expect(streetOf('1655 Walnut St #309')).toBe('Walnut St');
    expect(streetOf('1655 Walnut St Ste 106')).toBe('Walnut St');
  });
});

describe('slugToLabel', () => {
  it('turns a Zillow area slug into the words a search engine indexes', () => {
    expect(slugToLabel('central-boulder-boulder-co')).toBe('Central Boulder Boulder');
    expect(slugToLabel('southeast-boulder-boulder-co')).toBe('Southeast Boulder Boulder');
  });
});
