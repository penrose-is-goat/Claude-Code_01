import type {
  ListingStatus, NormalizedListing, NormalizedOpenHouse, NormalizedPhoto, PropertyType,
} from '../normalized';

/**
 * Pure parsing for Zillow's public search pages.
 *
 * Deliberately parses the embedded JSON blob rather than CSS selectors. Markup changes
 * on every design tweak; the data blob changes far less often, and when it DOES change
 * it usually changes shape in a way we can detect and fail loudly on, rather than
 * silently yielding wrong values.
 *
 * Kept free of I/O so the whole thing is testable against committed fixtures.
 */

/** Zillow has moved this blob around over the years; try the known homes in order. */
const RESULT_PATHS: string[][] = [
  ['props', 'pageProps', 'searchPageState', 'cat1', 'searchResults', 'listResults'],
  ['props', 'pageProps', 'searchPageState', 'cat1', 'searchResults', 'mapResults'],
  ['cat1', 'searchResults', 'listResults'],
  ['searchResults', 'listResults'],
];

export class ZillowParseError extends Error {
  constructor(message: string, readonly kind: 'no-blob' | 'no-results' | 'blocked') {
    super(message);
    this.name = 'ZillowParseError';
  }
}

/** Detects the interstitial that gets served instead of results when a fetch is refused. */
export function detectBlockPage(html: string): string | null {
  const markers: Array<[RegExp, string]> = [
    [/px-captcha|_px[A-Za-z]*Captcha/i, 'PerimeterX/HUMAN captcha challenge'],
    [/Please verify you'?re a human/i, 'human verification interstitial'],
    [/press\s*(&amp;|and)?\s*hold/i, 'press-and-hold challenge'],
    [/Access to this page has been denied/i, 'access denied page'],
    [/<title>\s*Attention Required/i, 'Cloudflare challenge'],
  ];
  for (const [re, label] of markers) {
    if (re.test(html)) return label;
  }
  return null;
}

export function extractNextData(html: string): unknown {
  const block = detectBlockPage(html);
  if (block) {
    throw new ZillowParseError(`Request was challenged: ${block}`, 'blocked');
  }

  const patterns = [
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    /<script[^>]+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      try {
        return JSON.parse(m[1]);
      } catch {
        // fall through to the next pattern
      }
    }
  }

  // Older search pages inline the state in an HTML comment instead of a script tag.
  const comment = html.match(/<!--\s*(\{"queryState[\s\S]*?\})\s*-->/);
  if (comment?.[1]) {
    try {
      return JSON.parse(comment[1]);
    } catch {
      /* ignore */
    }
  }

  throw new ZillowParseError('No __NEXT_DATA__ blob found in page', 'no-blob');
}

function dig(root: unknown, path: string[]): unknown {
  let cur: any = root;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

export function extractResults(blob: unknown): any[] {
  for (const path of RESULT_PATHS) {
    const found = dig(blob, path);
    if (Array.isArray(found) && found.length > 0) return found;
  }
  // An empty-but-present results array is a legitimate "no matches", not a break.
  for (const path of RESULT_PATHS) {
    const found = dig(blob, path);
    if (Array.isArray(found)) return found;
  }
  throw new ZillowParseError(
    'Could not locate search results in page data — Zillow may have changed its schema',
    'no-results',
  );
}

const STATUS_MAP: Record<string, ListingStatus> = {
  for_sale: 'ACTIVE',
  forsale: 'ACTIVE',
  fsba: 'ACTIVE',
  fsbo: 'ACTIVE',
  new_construction: 'ACTIVE',
  coming_soon: 'COMING_SOON',
  comingsoon: 'COMING_SOON',
  pending: 'PENDING',
  under_contract: 'CONTINGENT',
  contingent: 'CONTINGENT',
  recently_sold: 'SOLD',
  sold: 'SOLD',
  off_market: 'OFF_MARKET',
  other: 'UNKNOWN',
};

const TYPE_MAP: Record<string, PropertyType> = {
  single_family: 'SINGLE_FAMILY',
  singlefamily: 'SINGLE_FAMILY',
  condo: 'CONDO',
  townhouse: 'TOWNHOUSE',
  multi_family: 'MULTI_FAMILY',
  apartment: 'MULTI_FAMILY',
  lot: 'LAND',
  land: 'LAND',
  manufactured: 'MANUFACTURED',
};

export function mapStatus(raw: unknown): ListingStatus {
  if (typeof raw !== 'string') return 'UNKNOWN';
  return STATUS_MAP[raw.toLowerCase().replace(/[\s-]/g, '_')] ?? 'UNKNOWN';
}

export function mapPropertyType(raw: unknown): PropertyType {
  if (typeof raw !== 'string') return 'OTHER';
  return TYPE_MAP[raw.toLowerCase().replace(/[\s-]/g, '_')] ?? 'OTHER';
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = Number(v.replace(/[$,+]/g, '').trim());
    if (Number.isFinite(cleaned)) return cleaned;
  }
  return undefined;
}

function int(v: unknown): number | undefined {
  const n = num(v);
  return n == null ? undefined : Math.round(n);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Zillow expresses open houses in several shapes depending on the endpoint. Accepts the
 * ones we've seen and skips anything it cannot make a real date range out of, rather
 * than inventing one.
 */
export function parseOpenHouses(raw: any, timezone: string): NormalizedOpenHouse[] {
  const candidates =
    raw?.openHouseSchedules ??
    raw?.hdpData?.homeInfo?.openHouseSchedules ??
    raw?.openHouseInfo?.openHouseShowing ??
    [];

  if (!Array.isArray(candidates)) return [];

  const out: NormalizedOpenHouse[] = [];
  for (const c of candidates) {
    const startRaw = c?.startTime ?? c?.open_house_start ?? c?.startDate;
    const endRaw = c?.endTime ?? c?.open_house_end ?? c?.endDate;
    const startsAt = toDate(startRaw);
    const endsAt = toDate(endRaw);
    if (!startsAt || !endsAt || endsAt <= startsAt) continue;

    out.push({
      startsAt,
      endsAt,
      timezone,
      appointmentOnly: Boolean(c?.appointmentOnly ?? c?.byAppointmentOnly),
      virtual: Boolean(c?.isVirtual ?? c?.virtual),
      note: str(c?.description),
    });
  }
  return out;
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  // Epoch values arrive as either seconds or milliseconds depending on the field.
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function parsePhotos(raw: any): NormalizedPhoto[] {
  const urls: string[] = [];
  if (typeof raw?.imgSrc === 'string') urls.push(raw.imgSrc);
  const carousel = raw?.carouselPhotos ?? raw?.photos;
  if (Array.isArray(carousel)) {
    for (const p of carousel) {
      const u = typeof p === 'string' ? p : p?.url ?? p?.src;
      if (typeof u === 'string') urls.push(u);
    }
  }
  return [...new Set(urls)].map((url, order) => ({ url, order }));
}

/** Splits "1420 Pine St, Boulder, CO 80302" when the structured fields are missing. */
export function splitAddress(full: string): {
  addressLine1: string; city: string; state: string; postalCode: string;
} {
  const parts = full.split(',').map((p) => p.trim()).filter(Boolean);
  const tail = parts.length >= 1 ? parts[parts.length - 1] : '';
  const m = tail.match(/^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/);
  return {
    addressLine1: parts[0] ?? full.trim(),
    city: parts.length >= 3 ? parts[parts.length - 2] : '',
    state: m?.[1]?.toUpperCase() ?? '',
    postalCode: m?.[2] ?? '',
  };
}

export interface ParseContext {
  timezone: string;
  fetchedAt: Date;
}

export function normalizeZillowResult(raw: any, ctx: ParseContext): NormalizedListing {
  const info = raw?.hdpData?.homeInfo ?? {};

  const zpid = str(raw?.zpid) ?? str(info?.zpid);
  if (!zpid) {
    throw new ZillowParseError('Result has no zpid — cannot establish stable identity', 'no-results');
  }

  const fullAddress = str(raw?.address) ?? str(info?.streetAddress) ?? '';
  const split = splitAddress(fullAddress);

  const addressLine1 = str(info?.streetAddress) ?? split.addressLine1;
  const city = str(raw?.addressCity) ?? str(info?.city) ?? split.city;
  const state = str(raw?.addressState) ?? str(info?.state) ?? split.state;
  const postalCode = str(raw?.addressZipcode) ?? str(info?.zipcode) ?? split.postalCode;

  if (!addressLine1) {
    throw new ZillowParseError(`Result ${zpid} has no usable street address`, 'no-results');
  }

  const detailUrl = str(raw?.detailUrl);
  const listingUrl = detailUrl
    ? detailUrl.startsWith('http')
      ? detailUrl
      : `https://www.zillow.com${detailUrl}`
    : `https://www.zillow.com/homedetails/${zpid}_zpid/`;

  const price = int(raw?.unformattedPrice) ?? int(info?.price) ?? int(raw?.price);

  return {
    providerId: 'zillow',
    sourceListingId: zpid,
    addressLine1,
    city,
    state,
    postalCode,
    lat: num(raw?.latLong?.latitude) ?? num(info?.latitude),
    lng: num(raw?.latLong?.longitude) ?? num(info?.longitude),
    status: mapStatus(raw?.statusType ?? info?.homeStatus),
    propertyType: mapPropertyType(info?.homeType ?? raw?.hdpData?.homeInfo?.homeType),
    listPrice: price,
    beds: num(raw?.beds) ?? num(info?.bedrooms),
    bathsTotal: num(raw?.baths) ?? num(info?.bathrooms),
    livingAreaSqft: int(raw?.area) ?? int(info?.livingArea),
    lotSizeSqft: int(info?.lotAreaValue),
    yearBuilt: int(info?.yearBuilt),
    hoaFeeMonthly: int(info?.hoaFee),
    taxAnnual: int(info?.taxAssessedValue) != null ? undefined : undefined,
    listingUrl,
    providerDaysOnMarket: int(info?.daysOnZillow) ?? int(raw?.daysOnZillow),
    description: str(raw?.statusText),
    photos: parsePhotos(raw),
    openHouses: parseOpenHouses(raw, ctx.timezone),
    raw,
    fetchedAt: ctx.fetchedAt,
  };
}

/** Full pipeline: HTML in, normalized listings out. Throws ZillowParseError on trouble. */
export function parseSearchPage(html: string, ctx: ParseContext): {
  listings: NormalizedListing[];
  skipped: number;
} {
  const blob = extractNextData(html);
  const results = extractResults(blob);

  const listings: NormalizedListing[] = [];
  let skipped = 0;

  for (const r of results) {
    try {
      listings.push(normalizeZillowResult(r, ctx));
    } catch {
      // One malformed row must never fail the whole run.
      skipped++;
    }
  }

  return { listings, skipped };
}
