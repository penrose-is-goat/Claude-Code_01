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

/**
 * Detects the interstitial served instead of results when a fetch is refused.
 *
 * Two rules keep this from firing on real listings:
 *
 *  1. **Only the markup outside the data blob is scanned.** Listing descriptions live
 *     inside `__NEXT_DATA__`, and a description can contain any words at all — a home
 *     that "will impress and hold its value" must not read as a press-and-hold
 *     challenge. Scanning the whole document let a single listing shut down ingest for
 *     the entire page.
 *  2. **Markers are word-anchored.** Without boundaries, "impress and hold" and
 *     "compress and hold" both matched.
 *
 * A challenge page has no data blob, so stripping the blob costs us nothing on a real
 * block and removes the entire false-positive surface.
 */
export function detectBlockPage(html: string): string | null {
  // Structural markers are unambiguous — no listing page embeds a captcha container.
  const structural: Array<[RegExp, string]> = [
    [/id=["']px-captcha["']|class=["'][^"']*px-captcha/i, 'PerimeterX/HUMAN captcha challenge'],
    [/\b_pxA[a-zA-Z]*|window\._pxAppId/i, 'PerimeterX script'],
    [/cf-challenge|__cf_chl_|cdn-cgi\/challenge-platform/i, 'Cloudflare challenge'],
  ];
  for (const [re, label] of structural) {
    if (re.test(html)) return label;
  }

  // Textual markers are checked ONLY in page chrome — <title> and top-level headings.
  // A listing description is free text and can legitimately contain any of these
  // phrases ("HOA rules: access to this page has been denied to non-residents"), and
  // treating that as a block discarded the whole page of results.
  const chrome = chromeText(html);
  const textual: Array<[RegExp, string]> = [
    [/attention required/i, 'Cloudflare challenge'],
    [/please verify you'?re a human/i, 'human verification interstitial'],
    [/\bpress\s*(?:&amp;|&|and)\s*hold\b(?![\w-])/i, 'press-and-hold challenge'],
    [/access (?:to this page )?(?:has been )?denied/i, 'access denied page'],
    [/are you a robot|unusual traffic/i, 'bot interstitial'],
  ];
  for (const [re, label] of textual) {
    if (re.test(chrome)) return label;
  }

  return null;
}

/** Title and heading text only — the parts of a page that state what it IS. */
function chromeText(html: string): string {
  const parts: string[] = [];
  for (const re of [/<title[^>]*>([\s\S]{0,300}?)<\/title>/gi, /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/gi, /<h2[^>]*>([\s\S]{0,300}?)<\/h2>/gi]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) parts.push(m[1].replace(/<[^>]+>/g, ' '));
  }
  return parts.join(' \n ');
}

/** Removes the JSON payload so only page chrome is inspected for challenge markers. */
function stripDataBlob(html: string): string {
  return html
    .replace(/<script[^>]*id="__NEXT_DATA__"[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

export function extractNextData(html: string): unknown {
  // Deliberately NOT checked first. A page that yields parseable results is a real
  // response no matter what its chrome says, so block detection is a fallback for
  // explaining an absent blob — never a veto over data we actually have.
  const patterns = [
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    /<script[^>]+id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
  ];

  let sawBlob = false;
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      sawBlob = true;
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

  const block = detectBlockPage(html);
  if (block) {
    throw new ZillowParseError(`Request was challenged: ${block}`, 'blocked');
  }

  // "present but unparseable" and "absent" call for different responses — the first
  // means the schema moved, the second means we did not get a listings page at all.
  if (sawBlob) {
    throw new ZillowParseError(
      'Found a __NEXT_DATA__ blob but its JSON was malformed or truncated',
      'no-results',
    );
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

/** Accepts an identifier expressed as either a string or a number. */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
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
    const startsAt = toDate(startRaw, timezone);
    const endsAt = toDate(endRaw, timezone);
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

function toDate(v: unknown, timeZone?: string): Date | null {
  if (v == null) return null;

  // Epoch values arrive as either seconds or milliseconds depending on the field.
  // The 1e12 cutoff is safe: 1e12 ms is 2001-09-09, so no real open house predates it
  // and no seconds-epoch open house exceeds it.
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof v === 'string') {
    const trimmed = v.trim();

    // Providers sometimes JSON-encode an epoch as a string. `new Date("1755370800000")`
    // is an Invalid Date, so this silently dropped the open house entirely.
    if (/^-?\d{9,14}$/.test(trimmed)) return toDate(Number(trimmed));

    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
    // A bare wall-clock string like "2026-08-16T13:00:00" has no zone, so `new Date()`
    // silently resolves it in the SERVER's timezone. For an open house that is simply
    // the wrong hour — and wrong by a different amount depending on where the app runs.
    if (!hasZone && timeZone) {
      const resolved = wallClockToUtc(v, timeZone);
      if (resolved) return resolved;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

/**
 * Interprets a zone-less timestamp as local time in `timeZone` and returns the UTC
 * instant. Two passes because the offset itself depends on the instant (DST): guess
 * using the offset at the naive time, then correct using the offset at the guess.
 */
export function wallClockToUtc(wallClock: string, timeZone: string): Date | null {
  const m = wallClock.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!m) return null;

  const [, y, mo, d, h, mi, sec] = m;
  const naiveUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0);

  let instant = naiveUtc - zoneOffsetMs(new Date(naiveUtc), timeZone);
  instant = naiveUtc - zoneOffsetMs(new Date(instant), timeZone);

  const out = new Date(instant);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** Offset of `timeZone` from UTC, in ms, at a given instant. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts: Record<string, number> = {};
    for (const part of dtf.formatToParts(at)) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(
      parts.year, parts.month - 1, parts.day,
      parts.hour === 24 ? 0 : parts.hour, parts.minute, parts.second,
    );
    return asUtc - at.getTime();
  } catch {
    return 0; // unknown zone: fall back to treating the value as UTC
  }
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

  // Everything before "city" and "STATE ZIP" belongs to the street address. Taking only
  // parts[0] dropped the unit from "1420 Pine St, Apt 3, Boulder, CO 80302", which
  // silently merged separate units into one address.
  const streetParts = parts.length >= 3 ? parts.slice(0, parts.length - 2) : [parts[0] ?? full.trim()];

  return {
    addressLine1: streetParts.filter(Boolean).join(', ') || full.trim(),
    city: parts.length >= 3 ? parts[parts.length - 2] : '',
    state: m?.[1]?.toUpperCase() ?? '',
    postalCode: m?.[2] ?? '',
  };
}

export function safeListingUrl(detailUrl: string | undefined, zpid: string): string {
  const fallback = `https://www.zillow.com/homedetails/${zpid}_zpid/`;
  if (!detailUrl) return fallback;

  if (detailUrl.startsWith('/')) {
    return `https://www.zillow.com${detailUrl}`;
  }

  try {
    const parsed = new URL(detailUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

export interface ParseContext {
  timezone: string;
  fetchedAt: Date;
}

export function normalizeZillowResult(raw: any, ctx: ParseContext): NormalizedListing {
  const info = raw?.hdpData?.homeInfo ?? {};

  // Zillow has shipped zpid as both a JSON string and a JSON number. Requiring a
  // string meant a numeric payload parsed to zero listings — indistinguishable from
  // "this area has no matches".
  const zpid = idOf(raw?.zpid) ?? idOf(info?.zpid);
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

  // Anything here ends up as a clickable hyperlink in the Excel export, so only
  // http(s) is allowed through. `startsWith('http')` also admitted "httpx://", and a
  // non-http relative value was concatenated with no separator.
  const listingUrl = safeListingUrl(str(raw?.detailUrl), zpid);

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
