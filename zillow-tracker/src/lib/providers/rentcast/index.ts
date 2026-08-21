import type { ListingStatus, NormalizedListing, PropertyType } from '../normalized';
import type {
  AreaQuery, FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import { boundingBox } from '../../geo';
import { splitSearch, type Circle } from './split';

/**
 * RentCast — a licensed listings API.
 *
 * Everything else in this project reads what Zillow chooses to publish, which is a real
 * constraint: search snippets carry no coordinates, no open-house times, and no listing
 * dates, and coverage is whatever the query budget reaches. RentCast is a different kind
 * of source — a paid, permitted feed with a documented contract, nationwide coverage,
 * geographic search, and 500 records per request. Where the websearch provider spends
 * forty queries to find twenty homes, one request here returns five hundred.
 *
 * It is not a replacement for tracking Zillow, and it is not registered ahead of it. The
 * product is a Zillow tracker and every listing still deep-links to Zillow. What this
 * adds is the option of a complete, quickly-refreshed market for anyone willing to hold
 * an API key — free for 50 requests a month, which is enough to poll one neighbourhood
 * daily.
 *
 * Live verification needs a key, which this environment does not have. The contract
 * below is taken from RentCast's published documentation; parsing is defensive about
 * every field, and `npm run verify-rentcast` is the one-request check that confirms it
 * against the real API from a machine that has one.
 */

const DEFAULT_BASE = 'https://api.rentcast.io/v1';
/** RentCast returns at most 500 records per request. A response of exactly 500 is truncated. */
const PAGE_CAP = 500;

export interface RentCastOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How many times a circle may be split when a search comes back truncated. */
  maxSplitLevel?: number;
  /** Ceiling on requests per run, so one poll cannot eat a monthly quota. */
  maxRequests?: number;
}

export class RentCastProvider implements ListingProvider<RentCastListing> {
  readonly id = 'rentcast' as const;
  readonly displayName = 'RentCast (licensed listings API)';
  readonly capabilities: ProviderCapabilities = {
    // RentCast publishes listing status and dates, but not open-house schedules.
    supportsOpenHouses: false,
    // No polygon parameter, but circles tile a polygon well enough to be worth doing.
    supportsPolygonQuery: true,
    supportsRadiusQuery: true,
    supportsPhotos: false,
    supportsPriceHistory: true,
    rateLimit: { requestsPerRun: 20, minIntervalMs: 60 },
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly maxSplitLevel: number;
  private readonly maxRequests: number;

  /** Reported after a run so the caller can say which areas came back truncated. */
  lastTruncated: Circle[] = [];

  constructor(opts: RentCastOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.RENTCAST_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.RENTCAST_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
    this.maxSplitLevel = opts.maxSplitLevel ?? Number(process.env.RENTCAST_MAX_SPLIT_LEVEL ?? 2);
    this.maxRequests = opts.maxRequests ?? Number(process.env.RENTCAST_MAX_REQUESTS ?? 20);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.apiKey) {
      return {
        ok: false,
        message: 'Set RENTCAST_API_KEY to enable. Free plan: 50 requests/month (rentcast.io/api).',
      };
    }
    return { ok: true, message: `Configured — up to ${this.maxRequests} requests per run.` };
  }

  async fetchPage(opts: FetchOptions): Promise<ProviderPage<RentCastListing>> {
    if (!this.apiKey) {
      throw new Error('RentCast is not configured. Set RENTCAST_API_KEY (free plan at rentcast.io/api).');
    }

    const circle = circleFor(opts.area);

    // Without coordinates there is nothing to split, but a city/state query still works
    // and still paginates — so fall back to that rather than failing.
    if (!circle) {
      const raw = await this.fetchAllPages(cityParams(opts.area), opts.signal);
      this.lastTruncated = [];
      return { raw, requestsUsed: Math.max(1, Math.ceil(raw.length / PAGE_CAP)) };
    }

    const result = await splitSearch<RentCastListing>(circle, {
      cap: PAGE_CAP,
      maxLevel: this.maxSplitLevel,
      maxRequests: this.maxRequests,
      signal: opts.signal,
      keyOf: (l) => l.id ?? `${l.latitude},${l.longitude},${l.formattedAddress}`,
      fetch: (c) =>
        this.fetchAllPages(
          { latitude: String(c.lat), longitude: String(c.lng), radius: String(round(c.radiusMiles)) },
          opts.signal,
        ),
    });

    this.lastTruncated = result.truncated;
    return { raw: result.items, requestsUsed: result.requests };
  }

  /**
   * Drains one query's pages.
   *
   * A single circle can hold more than 500 homes; `offset` walks the rest. Splitting and
   * paginating solve different halves of the same problem — pagination gets everything
   * the source will admit exists for one query, splitting handles a query whose total the
   * source will not admit at all.
   */
  private async fetchAllPages(
    params: Record<string, string>,
    signal?: AbortSignal,
    maxPages = 4,
  ): Promise<RentCastListing[]> {
    const out: RentCastListing[] = [];

    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${this.baseUrl}/listings/sale`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      url.searchParams.set('status', 'Active');
      url.searchParams.set('limit', String(PAGE_CAP));
      if (page > 0) url.searchParams.set('offset', String(page * PAGE_CAP));

      const res = await this.doFetch(url, {
        headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey },
        signal,
      });

      if (res.status === 401 || res.status === 403) {
        throw new Error('RentCast rejected the API key (HTTP ' + res.status + ').');
      }
      if (res.status === 429) {
        throw new Error('RentCast rate limit or monthly quota reached (HTTP 429).');
      }
      if (!res.ok) throw new Error(`RentCast returned HTTP ${res.status}.`);

      const body = (await res.json()) as unknown;
      // The endpoint returns a bare array; tolerate an envelope in case that changes.
      const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { listings?: unknown }).listings)
          ? (body as { listings: unknown[] }).listings
          : [];

      out.push(...(rows as RentCastListing[]));
      if (rows.length < PAGE_CAP) break;
    }

    return out;
  }

  normalize(raw: RentCastListing): NormalizedListing {
    const addressLine1 = str(raw.addressLine1) ?? str(raw.formattedAddress);
    if (!addressLine1) throw new Error('RentCast listing has no address');

    return {
      providerId: 'rentcast',
      sourceListingId: str(raw.id) ?? addressLine1,
      mlsId: str(raw.mlsNumber),
      mlsName: str(raw.mlsName),
      addressLine1,
      addressLine2: str(raw.addressLine2),
      city: str(raw.city) ?? '',
      state: (str(raw.state) ?? '').toUpperCase(),
      postalCode: str(raw.zipCode) ?? '',
      county: str(raw.county),
      lat: num(raw.latitude),
      lng: num(raw.longitude),
      status: mapStatus(raw),
      propertyType: mapPropertyType(str(raw.propertyType)),
      listPrice: num(raw.price),
      beds: num(raw.bedrooms),
      bathsTotal: num(raw.bathrooms),
      livingAreaSqft: num(raw.squareFootage),
      lotSizeSqft: num(raw.lotSize),
      yearBuilt: num(raw.yearBuilt),
      listedAt: date(raw.listedDate),
      providerDaysOnMarket: num(raw.daysOnMarket),
      // Still a Zillow tracker: the link a person clicks goes to Zillow, whichever feed
      // supplied the facts. RentCast publishes no listing URL of its own.
      listingUrl: zillowSearchUrl(addressLine1, str(raw.city), str(raw.state), str(raw.zipCode)),
      photos: [],
      openHouses: [],
      raw,
      fetchedAt: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------

/** The documented sale-listing record. Every field optional: none is assumed present. */
export interface RentCastListing {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
  status?: string;
  price?: number;
  listedDate?: string;
  removedDate?: string;
  lastSeenDate?: string;
  daysOnMarket?: number;
  mlsName?: string;
  mlsNumber?: string;
}

/**
 * A search circle for an area query.
 *
 * A drawn polygon becomes the circle that circumscribes its bounding box — deliberately
 * larger than the shape, because the exact ring is applied afterwards by the geometry
 * filter. Fetching slightly too much and filtering down is correct; fetching an inscribed
 * circle would quietly miss the corners.
 */
export function circleFor(area: AreaQuery): Circle | null {
  if (area.kind === 'cityRadius') {
    if (area.centerLat == null || area.centerLng == null) return null;
    return { lat: area.centerLat, lng: area.centerLng, radiusMiles: area.radiusMiles };
  }

  const box = area.kind === 'polygon' ? boundingBox(area.ring) : area;
  const lat = (box.minLat + box.maxLat) / 2;
  const lng = (box.minLng + box.maxLng) / 2;

  const latSpanMiles = (box.maxLat - box.minLat) * 69;
  const lngSpanMiles = (box.maxLng - box.minLng) * 69 * Math.cos((lat * Math.PI) / 180);
  const radiusMiles = Math.sqrt(latSpanMiles ** 2 + lngSpanMiles ** 2) / 2;

  return { lat, lng, radiusMiles: Math.max(radiusMiles, 0.1) };
}

function cityParams(area: AreaQuery): Record<string, string> {
  if (area.kind === 'cityRadius' && area.city && area.state) {
    return { city: area.city, state: area.state.toUpperCase() };
  }
  throw new Error(
    'RentCast needs either coordinates or a resolved city and state, and this area has neither.',
  );
}

/**
 * RentCast reports `Active` / `Inactive` and a removal date, which is less granular than
 * this app's status set. Nothing is invented to fill the gap: an inactive listing is
 * OFF_MARKET rather than a guess between sold, expired and withdrawn.
 */
export function mapStatus(raw: RentCastListing): ListingStatus {
  const status = (raw.status ?? '').trim().toLowerCase();
  if (status === 'active') return 'ACTIVE';
  if (status === 'inactive') return raw.removedDate ? 'OFF_MARKET' : 'UNKNOWN';
  return 'UNKNOWN';
}

export function mapPropertyType(value: string | undefined): PropertyType {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'single family': return 'SINGLE_FAMILY';
    case 'condo': return 'CONDO';
    case 'townhouse': return 'TOWNHOUSE';
    case 'multi-family': case 'multi family': case 'apartment': return 'MULTI_FAMILY';
    case 'manufactured': return 'MANUFACTURED';
    case 'land': return 'LAND';
    default: return 'OTHER';
  }
}

/** Deep-link to Zillow's search for this address — the product tracks Zillow. */
function zillowSearchUrl(line1: string, city?: string, state?: string, zip?: string): string {
  const parts = [line1, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return `https://www.zillow.com/homes/${encodeURIComponent(parts).replace(/%20/g, '-')}_rb/`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function date(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
