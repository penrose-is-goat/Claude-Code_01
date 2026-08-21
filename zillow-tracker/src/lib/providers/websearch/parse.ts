import type { ListingStatus, NormalizedListing, PropertyType } from '../normalized';
import { splitAddress } from '../zillow/parse';

/**
 * Parses the data Zillow publishes *for search engines*.
 *
 * Zillow wants its listings found. Every `/homedetails/` page ships a canonical URL
 * carrying the zpid, a `<title>` carrying the address and (when the home is actively
 * listed) the MLS number, and a `<meta name="description">` carrying price, beds,
 * baths, square footage, home type and year built. That triple is the product Zillow
 * hands to every crawler on the internet, and it is what a search backend returns as
 * `{ url, title, description }` for a result.
 *
 * So this file parses search results, not web pages. Nothing here fetches anything and
 * nothing here needs an account, a cookie, or a page render. The same functions serve
 * two callers: the live `WebSearchProvider` (Brave / Google CSE / SearXNG on the user's
 * machine) and `scripts/harvest.ts`. One parser, one set of tests, two transports.
 *
 * The rule from the project's standing instructions applies hardest here: a field the
 * snippet did not state is left undefined. A description that omits the year built
 * yields no `yearBuilt` — never a guess, never a default, never a plausible-looking
 * filler value.
 */

/** One result as every search API returns it. */
export interface SearchResult {
  url: string;
  title: string;
  /** The indexed meta description. Some backends call this `snippet` or `content`. */
  description?: string;
}

// ---------------------------------------------------------------------------
// URL layer — identity
// ---------------------------------------------------------------------------

export interface HomedetailsRef {
  /** Zillow's own stable id. Survives address edits and re-listings. */
  zpid: string;
  /** The address slug Zillow put in the path, e.g. `1655-Walnut-St-UNIT-106-Boulder-CO-80302`. */
  slug: string;
  /** Normalized to https://www.zillow.com/... with tracking parameters dropped. */
  canonicalUrl: string;
}

/**
 * `https://www.zillow.com/homedetails/1655-Walnut-St-UNIT-106-Boulder-CO-80302/88908043_zpid/`
 *
 * Returns null for anything that is not a single-home page — index pages, agent
 * profiles, rental pages and mortgage calculators all live on the same host and all
 * turn up in results for an address query.
 */
export function parseHomedetailsUrl(rawUrl: string): HomedetailsRef | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!/(^|\.)zillow\.com$/i.test(parsed.hostname)) return null;

  // Path shape: /homedetails/<slug>/<zpid>_zpid/  — the slug is optional in the wild,
  // e.g. /homedetails/12345_zpid/ is a valid short form Zillow itself emits.
  const m = parsed.pathname.match(/\/homedetails\/(?:(.+?)\/)?(\d+)_zpid\/?$/i);
  if (!m) return null;

  const zpid = m[2];
  const slug = m[1] ?? '';

  return {
    zpid,
    slug,
    canonicalUrl: `https://www.zillow.com/homedetails/${slug ? `${slug}/` : ''}${zpid}_zpid/`,
  };
}

// ---------------------------------------------------------------------------
// Title layer — address, and the MLS-number tell
// ---------------------------------------------------------------------------

export interface TitleFacts {
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  /**
   * Present only when Zillow put `| MLS #...` in the title, which it does for homes
   * with a live MLS record. Its absence is a soft off-market signal — soft, because
   * some genuinely-active for-sale-by-owner listings carry no MLS number at all.
   */
  mlsId?: string;
}

/**
 * `1655 Walnut St #309, Boulder, CO 80302 | MLS #1025654 | Zillow`
 * `1655 Walnut St Ste 106, Boulder, CO 80302`                     (no suffixes at all)
 * `4370 Butler Cir, Boulder, CO 80305 | Zillow`
 */
export function parseListingTitle(title: string): TitleFacts | null {
  if (!title) return null;

  // Split on the pipe, then classify each segment rather than assuming a fixed count —
  // Zillow ships two, three and (for some rentals) four-segment titles.
  const segments = title.split('|').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  let mlsId: string | undefined;
  let addressSegment: string | undefined;

  for (const seg of segments) {
    if (/^zillow$/i.test(seg)) continue;

    const mls = seg.match(/^MLS\s*#\s*([\w-]+)$/i);
    if (mls) {
      mlsId = mls[1];
      continue;
    }

    // The address segment is the one ending in STATE ZIP.
    if (!addressSegment && /,\s*[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/.test(seg)) {
      addressSegment = seg;
    }
  }

  if (!addressSegment) return null;

  const { addressLine1, city, state, postalCode } = splitAddress(addressSegment);
  if (!addressLine1 || !state || !postalCode) return null;

  return { addressLine1, city, state, postalCode, mlsId };
}

// ---------------------------------------------------------------------------
// Description layer — the facts Zillow publishes to crawlers
// ---------------------------------------------------------------------------

export interface DescriptionFacts {
  listPrice?: number;
  /** Set instead of `listPrice` when the figure is a monthly rent. Never mixed. */
  monthlyRent?: number;
  beds?: number;
  bathsTotal?: number;
  livingAreaSqft?: number;
  propertyType?: PropertyType;
  yearBuilt?: number;
  mlsId?: string;
  photoCount?: number;
  /** The address as the description states it, used to corroborate the title. */
  addressText?: string;
}

/**
 * The canonical form, stable for years:
 *
 *   "Zillow has 39 photos of this $1,470,000 2 beds, 3 baths, 2,094 Square Feet condo
 *    home located at 1655 Walnut St UNIT 106, Boulder, CO 80302 built in 2009.
 *    MLS #950962."
 *
 * Off-market homes get the same sentence with the price omitted. Rentals get `/mo`.
 * Every field is independently optional: this returns whatever it can prove and stays
 * silent about the rest.
 */
export function parseMetaDescription(description: string | undefined): DescriptionFacts {
  const out: DescriptionFacts = {};
  if (!description) return out;

  const text = description.replace(/\s+/g, ' ').trim();

  // Rent first: "$2,500/mo" must never be read as a list price. Checking the rent
  // pattern before the price pattern is what keeps a rental out of the for-sale set.
  const rent = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:\+)?\s*\/\s*mo\b/i);
  if (rent) {
    const n = toNumber(rent[1]);
    if (n != null) out.monthlyRent = n;
  } else {
    const price = text.match(/\$\s*([\d,]+)(?!\s*\/)/);
    if (price) {
      const n = toNumber(price[1]);
      // A "$0" or a stray "$1" is Zillow having no price, not a one-dollar house.
      if (n != null && n >= 1000) out.listPrice = n;
    }
  }

  const photos = text.match(/has\s+([\d,]+)\s+photos?\b/i);
  if (photos) {
    const n = toNumber(photos[1]);
    if (n != null) out.photoCount = n;
  }

  const beds = text.match(/\b([\d.]+)\s*(?:beds?|bedrooms?|bd)\b/i);
  if (beds) {
    const n = toNumber(beds[1]);
    if (n != null && n >= 0 && n <= 100) out.beds = n;
  }

  const baths = text.match(/\b([\d.]+)\s*(?:baths?|bathrooms?|ba)\b/i);
  if (baths) {
    const n = toNumber(baths[1]);
    if (n != null && n >= 0 && n <= 100) out.bathsTotal = n;
  }

  const sqft = text.match(/\b([\d,]+)\s*(?:square\s*(?:feet|foot)|sq\.?\s*ft\.?|sqft)\b/i);
  if (sqft) {
    const n = toNumber(sqft[1]);
    if (n != null && n > 0) out.livingAreaSqft = n;
  }

  const year = text.match(/built\s+in\s+(\d{4})\b/i);
  if (year) {
    const n = toNumber(year[1]);
    // Guard against a "built in 20090" typo and against future years.
    if (n != null && n >= 1600 && n <= new Date().getUTCFullYear() + 5) out.yearBuilt = n;
  }

  const mls = text.match(/\bMLS\s*#\s*([\w-]+)/i);
  if (mls) out.mlsId = mls[1];

  // "located at <address> built in" / "located at <address>." — the description repeats
  // the address, which is how a title/description mismatch gets caught.
  const at = text.match(/located\s+at\s+(.+?)(?=\s+built\s+in\b|\.\s|$)/i);
  if (at) out.addressText = at[1].replace(/[.,\s]+$/, '');

  const type = matchPropertyType(text);
  if (type) out.propertyType = type;

  return out;
}

function matchPropertyType(text: string): PropertyType | undefined {
  // Ordered most-specific first: "single family home" must win over a bare "home", and
  // "multi family" must not be swallowed by "family".
  const table: Array<[RegExp, PropertyType]> = [
    [/\bmulti[\s-]?family\b|\bduplex\b|\btriplex\b|\bfourplex\b/i, 'MULTI_FAMILY'],
    [/\bsingle[\s-]?family\b/i, 'SINGLE_FAMILY'],
    [/\btownhouse\b|\btownhome\b/i, 'TOWNHOUSE'],
    [/\bcondo(?:minium)?\b|\bco-?op\b|\bapartment\b/i, 'CONDO'],
    [/\bmanufactured\b|\bmobile\s+home\b/i, 'MANUFACTURED'],
    [/\b(?:lot|land)\b(?:\s*\/\s*land)?/i, 'LAND'],
  ];
  for (const [re, type] of table) if (re.test(text)) return type;
  return undefined;
}

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Status — positive filtering
// ---------------------------------------------------------------------------

export interface StatusVerdict {
  status: ListingStatus;
  /**
   * True only when the evidence positively says "you can buy this today". Everything
   * ambiguous is false. The search index is full of sold and never-listed homes, so the
   * default has to be exclusion — otherwise a "homes for sale" list quietly fills up
   * with houses that sold in 2019.
   */
  forSale: boolean;
  /** Why, in words. Surfaced in the harvest report so a wrong call is debuggable. */
  reason: string;
}

/**
 * Decides whether an indexed home is actually on the market.
 *
 * The signals, strongest first:
 *  - explicit sold / rental / auction language  -> excluded outright
 *  - explicit pending / coming-soon language    -> that status, still "on the market"
 *  - a list price in the description            -> active
 *  - no price at all                            -> off market (Zillow omits the price
 *    from the description of every home that is not for sale)
 */
export function classifyStatus(
  title: string,
  description: string | undefined,
  facts: DescriptionFacts,
  /** Parsed title, when the caller already has it. Supplies the MLS-number signal. */
  titleFacts?: TitleFacts | null,
): StatusVerdict {
  const text = `${title} ${description ?? ''}`.replace(/\s+/g, ' ');

  if (facts.monthlyRent != null || /\bfor\s+rent\b|\brental\b|\/mo\b/i.test(text)) {
    return { status: 'OFF_MARKET', forSale: false, reason: 'rental listing' };
  }

  // "last sold for", "sold on 08/12/2021", "Sold" in the title. Note the deliberate
  // omission of a bare "sold" match: active listings say things like "sold as-is".
  if (/\blast\s+sold\b|\bsold\s+on\b|\bsold\s+for\b|\brecently\s+sold\b|\|\s*sold\b/i.test(text)) {
    return { status: 'SOLD', forSale: false, reason: 'sale-history language' };
  }

  if (/\bforeclosur|\bauction\b|\bpre-?foreclosure\b/i.test(text)) {
    return { status: 'OFF_MARKET', forSale: false, reason: 'foreclosure/auction' };
  }

  if (/\bcoming\s+soon\b/i.test(text)) {
    return { status: 'COMING_SOON', forSale: true, reason: 'coming-soon language' };
  }

  if (/\bunder\s+contract\b|\bpending\b/i.test(text)) {
    return { status: 'PENDING', forSale: true, reason: 'pending language' };
  }

  if (/\bcontingent\b/i.test(text)) {
    return { status: 'CONTINGENT', forSale: true, reason: 'contingent language' };
  }

  if (/\boff\s+market\b|\bnot\s+currently\s+for\s+sale\b|\bno\s+longer\s+(?:for\s+sale|available)\b/i.test(text)) {
    return { status: 'OFF_MARKET', forSale: false, reason: 'explicit off-market language' };
  }

  if (facts.listPrice != null) {
    return { status: 'ACTIVE', forSale: true, reason: 'list price published' };
  }

  /*
   * The MLS-number tell.
   *
   * Zillow appends `| MLS #123456` to the page title of a home with a live MLS record
   * and drops it when the record closes. Checked against 27 results across four Boulder
   * ZIPs on 2026-08-21, it agreed with the for-sale status every time — including a
   * slice where a search reported exactly one of ten homes as listed, and that one home
   * was the only title carrying an MLS number.
   *
   * It matters because it is independent of the description. A backend that returns a
   * terse snippet, or none at all, still yields a title, so this keeps a genuinely
   * listed home from being discarded for want of a price. The price stays undefined
   * rather than being guessed: "on the market, price not published here" is a fact, and
   * an invented number would not be.
   */
  const mls = titleFacts?.mlsId ?? (parseListingTitle(title)?.mlsId);
  if (mls) {
    return { status: 'ACTIVE', forSale: true, reason: `live MLS record #${mls} in page title` };
  }

  // Zillow publishes the price for everything it is trying to sell. No price and no MLS
  // record means this page is a property record, not an offer.
  return { status: 'OFF_MARKET', forSale: false, reason: 'no list price and no MLS number' };
}

// ---------------------------------------------------------------------------
// Index pages — the coverage denominator
// ---------------------------------------------------------------------------

export type IndexKind = 'forSale' | 'openHouse' | 'sold' | 'rent' | 'unknown';

export interface IndexPageFacts {
  url: string;
  /** What Zillow calls the area: "Boulder CO", "Central Boulder Boulder", "80304". */
  scopeLabel: string;
  kind: IndexKind;
  /** The number Zillow itself publishes in the title. This is the denominator. */
  count?: number;
  /** Zillow's own slug for the area, e.g. `central-boulder-boulder-co`. */
  areaSlug?: string;
  /** Page number from a `/2_p/` suffix; 1 when absent. */
  page: number;
}

/**
 * Zillow's index-page titles state the size of the market:
 *
 *   "Boulder CO Open Houses - 61 Upcoming | Zillow"
 *   "Boulder CO Single Family Homes For Sale - 406 Homes | Zillow"
 *   "80301 Single Family Homes For Sale - 67 Homes | Zillow"
 *
 * That published count is the honest denominator for a coverage report: it is how the
 * app can say "found 512 of the 774 Zillow lists" instead of quietly presenting a
 * partial harvest as the whole market.
 *
 * It also exposes Zillow's own neighborhood directory — `central-boulder-boulder-co`,
 * `southeast-boulder-boulder-co` — which is how a sweep subdivides a city that has
 * more listings than any single query can return.
 */
export function parseIndexPage(result: SearchResult): IndexPageFacts | null {
  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    return null;
  }

  if (!/(^|\.)zillow\.com$/i.test(parsed.hostname)) return null;
  if (/\/homedetails\//i.test(parsed.pathname)) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let page = 1;
  const pageSeg = segments[segments.length - 1].match(/^(\d+)_p$/);
  if (pageSeg) {
    page = Number(pageSeg[1]);
    segments.pop();
  }

  const areaSlug = segments[0];
  // Zillow's area slugs come in three shapes: `boulder-co` (city), `boulder-co-80301`
  // (ZIP within a city) and a bare `80301`. Requiring a trailing state code alone
  // rejected every ZIP page, which are the most useful slices a sweep has.
  const isAreaSlug =
    /^[a-z0-9-]+-[a-z]{2}$/i.test(areaSlug) ||
    /^[a-z0-9-]+-\d{5}$/i.test(areaSlug) ||
    /^\d{5}$/.test(areaSlug);
  if (!isAreaSlug) return null;

  const facets = segments.slice(1).map((s) => s.toLowerCase());
  const kind: IndexKind =
    facets.includes('open-house') ? 'openHouse'
    : facets.includes('sold') ? 'sold'
    : facets.includes('rentals') || facets.includes('apartments') ? 'rent'
    : 'forSale';

  /*
   * "- 61 Upcoming | Zillow" / "- 406 Homes | Zillow" / "- 1,042 Homes | Zillow"
   *
   * The count phrase must END the title. Matching it anywhere read the ZIP out of
   * "80305 Real Estate - 80305 Homes For Sale | Zillow" and reported a market of eighty
   * thousand homes — which then became the denominator for a coverage percentage. A
   * wrong denominator is worse than none, so this errs toward finding no count.
   */
  const countMatch = result.title.match(
    /[-–]\s*([\d,]+)\s+(?:Upcoming|Homes|Listings|Results)\s*(?:\|.*)?$/i,
  );
  let count = countMatch ? toNumber(countMatch[1]) ?? undefined : undefined;

  // Belt and braces: a "count" identical to the page's own ZIP is the ZIP.
  const zipInSlug = segments[0].match(/(?:^|-)(\d{5})$/)?.[1];
  if (count != null && zipInSlug && String(count) === zipInSlug) count = undefined;

  const scopeLabel = result.title.split(/\s+[-–]\s+/)[0].replace(/\s*\|\s*Zillow\s*$/i, '').trim();

  return { url: result.url, scopeLabel, kind, count, areaSlug, page };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ToListingContext {
  fetchedAt: Date;
  providerId?: string;
  /** Drop anything not positively for sale. Defaults to true. */
  requireForSale?: boolean;
}

export interface ToListingOutcome {
  listing?: NormalizedListing;
  /** Why a result was dropped. Counted in the harvest report rather than swallowed. */
  dropped?: { url: string; reason: string };
}

/**
 * One search result -> one listing, or a recorded reason it was not one.
 *
 * Every field comes from the URL, the title, or the description. Nothing is inferred
 * from a neighbouring result, and nothing is filled in from a default. `lat`/`lng` in
 * particular stay undefined: search results do not carry coordinates, so a listing
 * harvested this way is placed by its address, never by an invented point.
 */
export function toListing(result: SearchResult, ctx: ToListingContext): ToListingOutcome {
  const providerId = ctx.providerId ?? 'websearch';
  const ref = parseHomedetailsUrl(result.url);
  if (!ref) return { dropped: { url: result.url, reason: 'not a /homedetails/ page' } };

  const titleFacts = parseListingTitle(result.title);
  if (!titleFacts) {
    return { dropped: { url: result.url, reason: 'title did not contain a parseable address' } };
  }

  const facts = parseMetaDescription(result.description);
  const verdict = classifyStatus(result.title, result.description, facts, titleFacts);

  if ((ctx.requireForSale ?? true) && !verdict.forSale) {
    return { dropped: { url: result.url, reason: `not for sale (${verdict.reason})` } };
  }

  const listing: NormalizedListing = {
    providerId,
    sourceListingId: ref.zpid,
    mlsId: titleFacts.mlsId ?? facts.mlsId,
    addressLine1: titleFacts.addressLine1,
    city: titleFacts.city,
    state: titleFacts.state,
    postalCode: titleFacts.postalCode,
    status: verdict.status,
    propertyType: facts.propertyType ?? 'OTHER',
    listPrice: facts.listPrice,
    beds: facts.beds,
    bathsTotal: facts.bathsTotal,
    livingAreaSqft: facts.livingAreaSqft,
    yearBuilt: facts.yearBuilt,
    // Always point back at Zillow. The whole product is a tracker over Zillow's pages,
    // not a copy of them.
    listingUrl: ref.canonicalUrl,
    // Search results carry no photo URLs, and photos are never stored regardless.
    photos: [],
    openHouses: [],
    raw: { url: result.url, title: result.title, description: result.description, verdict },
    fetchedAt: ctx.fetchedAt,
  };

  return { listing };
}
