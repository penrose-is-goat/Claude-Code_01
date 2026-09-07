import type { AreaQuery } from '../providers/types';
import { boundingBox } from '../geo';
import { splitSearch, type Circle } from './split';

/**
 * An address index: it answers "what addresses exist in this area", and nothing else.
 *
 * This is deliberately NOT a listing provider and is not registered as one. Nothing it
 * returns is ever shown to a user, stored as a listing, or displayed as a fact. Its only
 * job is to hand the Zillow harvester a complete list of streets and addresses to look
 * up, so the sweep stops discovering its frontier one lucky result at a time.
 *
 * The reason for the split is that the product is a Zillow tracker. Prices, statuses and
 * open houses must come from Zillow or they are not the thing being tracked — a second
 * feed's idea of a price would disagree with the Zillow page the listing links to, and
 * the user would be right to distrust both. What a second feed CAN do without that
 * problem is tell you where the houses are, because an address is not an opinion.
 */

export interface AddressSeed {
  addressLine1: string;
  city: string;
  state: string;
  postalCode?: string;
  lat?: number;
  lng?: number;
}

export interface AddressIndex {
  readonly id: string;
  readonly displayName: string;
  isConfigured(): boolean;
  /** Setup instructions, shown when it isn't configured. */
  readonly setupHint: string;
  addresses(area: AreaQuery, signal?: AbortSignal): Promise<AddressIndexResult>;
}

export interface AddressIndexResult {
  seeds: AddressSeed[];
  requestsUsed: number;
  /** Areas that came back at the source's cap and could not be broken down further. */
  truncated: Circle[];
}

const DEFAULT_BASE = 'https://api.rentcast.io/v1';
/** RentCast returns at most 500 records per response; exactly 500 means truncated. */
const PAGE_CAP = 500;

export interface RentCastOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxSplitLevel?: number;
  maxRequests?: number;
}

/**
 * RentCast as an address index.
 *
 * Chosen because it covers the whole country, searches a circle, returns 500 records per
 * request, and has a free tier. One request replaces roughly fifty search queries' worth
 * of street discovery — and then the actual listing facts still come from Zillow.
 */
export class RentCastAddressIndex implements AddressIndex {
  readonly id = 'rentcast';
  readonly displayName = 'RentCast address index';
  readonly setupHint =
    'Set RENTCAST_API_KEY to enable. Free plan: 50 requests/month (rentcast.io/api).';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly maxSplitLevel: number;
  private readonly maxRequests: number;

  constructor(opts: RentCastOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.RENTCAST_API_KEY ?? '';
    this.baseUrl = (opts.baseUrl ?? process.env.RENTCAST_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
    this.maxSplitLevel = opts.maxSplitLevel ?? Number(process.env.RENTCAST_MAX_SPLIT_LEVEL ?? 2);
    this.maxRequests = opts.maxRequests ?? Number(process.env.RENTCAST_MAX_REQUESTS ?? 8);
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0;
  }

  async addresses(area: AreaQuery, signal?: AbortSignal): Promise<AddressIndexResult> {
    if (!this.isConfigured()) throw new Error(this.setupHint);

    const circle = circleFor(area);
    if (!circle) {
      const rows = await this.fetchAllPages(cityParams(area), signal);
      return { seeds: rows.map(toSeed).filter(isSeed), requestsUsed: 1, truncated: [] };
    }

    const result = await splitSearch<RentCastRecord>(circle, {
      cap: PAGE_CAP,
      maxLevel: this.maxSplitLevel,
      maxRequests: this.maxRequests,
      signal,
      keyOf: (r) => r.id ?? `${r.latitude},${r.longitude},${r.formattedAddress}`,
      fetch: (c) =>
        this.fetchAllPages(
          { latitude: String(c.lat), longitude: String(c.lng), radius: String(Math.round(c.radiusMiles * 100) / 100) },
          signal,
        ),
    });

    return {
      seeds: result.items.map(toSeed).filter(isSeed),
      requestsUsed: result.requests,
      truncated: result.truncated,
    };
  }

  private async fetchAllPages(
    params: Record<string, string>,
    signal?: AbortSignal,
    maxPages = 2,
  ): Promise<RentCastRecord[]> {
    const out: RentCastRecord[] = [];

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

      if (res.status === 401 || res.status === 403) throw new Error(`RentCast rejected the API key (HTTP ${res.status}).`);
      if (res.status === 429) throw new Error('RentCast rate limit or monthly quota reached (HTTP 429).');
      if (!res.ok) throw new Error(`RentCast returned HTTP ${res.status}.`);

      const body = (await res.json()) as unknown;
      const rows = Array.isArray(body) ? body : [];
      out.push(...(rows as RentCastRecord[]));
      if (rows.length < PAGE_CAP) break;
    }

    return out;
  }
}

/** Only the fields an address needs. Everything else the API returns is ignored. */
interface RentCastRecord {
  id?: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  latitude?: number;
  longitude?: number;
}

function toSeed(r: RentCastRecord): AddressSeed | null {
  const addressLine1 = typeof r.addressLine1 === 'string' ? r.addressLine1.trim() : '';
  const city = typeof r.city === 'string' ? r.city.trim() : '';
  const state = typeof r.state === 'string' ? r.state.trim().toUpperCase() : '';
  if (!addressLine1 || !city || !state) return null;

  return {
    addressLine1,
    city,
    state,
    postalCode: typeof r.zipCode === 'string' ? r.zipCode.trim() : undefined,
    lat: typeof r.latitude === 'number' ? r.latitude : undefined,
    lng: typeof r.longitude === 'number' ? r.longitude : undefined,
  };
}

function isSeed(s: AddressSeed | null): s is AddressSeed {
  return s !== null;
}

/**
 * A search circle for an area query. A drawn shape becomes the circle circumscribing its
 * bounding box — larger than the shape on purpose, since the exact ring is applied later.
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

  return { lat, lng, radiusMiles: Math.max(Math.hypot(latSpanMiles, lngSpanMiles) / 2, 0.1) };
}

function cityParams(area: AreaQuery): Record<string, string> {
  if (area.kind === 'cityRadius' && area.city && area.state) {
    return { city: area.city, state: area.state.toUpperCase() };
  }
  throw new Error('The address index needs coordinates or a resolved city and state.');
}

export { splitCircle, splitSearch, type Circle } from './split';
