import type { PrismaClient } from '@prisma/client';
import type { Geocoder, ResolvedPlace } from './types';

/**
 * Nominatim (OpenStreetMap) geocoder.
 *
 * This app has no built-in area, so every "place" search starts by turning what the
 * user typed into coordinates. Nominatim is free, requires no API key, and its usage
 * policy (https://operations.osmfoundation.org/policies/nominatim/) is exactly two
 * requirements: identify yourself with a real User-Agent, and cap requests at 1/second.
 * Both are enforced here rather than left to the caller to remember.
 *
 * IMPORTANT: this container's egress proxy 403s every outbound host, Nominatim included
 * (see CLAUDE.md). That makes this class untestable against the real service from here.
 * Every code path is therefore exercised in tests via an injected `fetchImpl` — the
 * `Geocoder.resolve` contract returning `Promise<ResolvedPlace[]>` gives no room for a
 * distinguishable error return, so failures throw a typed `GeocodeError` instead. That is
 * a deliberate, catchable exception at this module's boundary, not "throwing into the
 * UI" — `search/service.ts` is the boundary that must never let one escape, and it is
 * the one place required to catch this class.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

/** Nominatim requires a real identifying UA, not a browser spoof, so a challenge from
 * their side names an actual client rather than looking like abuse. Deliberately carries
 * no personal contact info (e.g. the operator's email) — Nominatim's policy prefers one,
 * but this app has no standing consent to send the user's address to a third party. */
const DEFAULT_USER_AGENT = 'zillow-tracker/0.1 (personal listing tracker; single-user, low-volume)';

export type GeocodeErrorKind = 'network' | 'http' | 'parse';

export class GeocodeError extends Error {
  constructor(message: string, readonly kind: GeocodeErrorKind, readonly cause?: unknown) {
    super(message);
    this.name = 'GeocodeError';
  }
}

export interface NominatimGeocoderOptions {
  /** Injectable so tests never touch the network — required, since this sandbox 403s Nominatim outright. */
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  userAgent?: string;
  baseUrl?: string;
  now?: () => number;
}

/** Shape of one element of Nominatim's `format=json&addressdetails=1` response. */
interface NominatimResult {
  display_name?: string;
  lat?: string;
  lon?: string;
  boundingbox?: [string, string, string, string];
  address?: {
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    municipality?: string;
    county?: string;
    state?: string;
    'ISO3166-2-lvl4'?: string; // e.g. "US-CO" — the most reliable abbreviation source when present
  };
}

export class NominatimGeocoder implements Geocoder {
  readonly id = 'nominatim';

  private lastRequestAt = 0;
  private readonly opts: Required<Omit<NominatimGeocoderOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };

  constructor(private db: PrismaClient, options: NominatimGeocoderOptions = {}) {
    this.opts = {
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      minIntervalMs: options.minIntervalMs ?? 1000,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      baseUrl: options.baseUrl ?? NOMINATIM_BASE,
      now: options.now ?? (() => Date.now()),
    };
  }

  async resolve(query: string, signal?: AbortSignal): Promise<ResolvedPlace[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const cacheKey = `geocode:${trimmed.toLowerCase()}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    // Rate limit applies to actual network requests only — a cache hit above costs
    // nothing and must not be throttled behind one.
    await this.pace();

    const url = `${this.opts.baseUrl}?${new URLSearchParams({
      q: trimmed,
      format: 'json',
      addressdetails: '1',
      limit: '5',
    })}`;

    let res: Response;
    try {
      res = await this.opts.fetchImpl(url, {
        signal,
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
      });
    } catch (err) {
      throw new GeocodeError(`Nominatim unreachable: ${describeNetworkError(err)}`, 'network', err);
    }

    if (!res.ok) {
      throw new GeocodeError(`Nominatim returned HTTP ${res.status} for "${trimmed}"`, 'http');
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new GeocodeError('Nominatim returned a response that was not valid JSON', 'parse', err);
    }

    if (!Array.isArray(body)) {
      throw new GeocodeError('Nominatim returned an unexpected response shape', 'parse');
    }

    const places = (body as NominatimResult[]).map(toResolvedPlace).filter((p): p is ResolvedPlace => p != null);

    // Cache even a zero-result lookup. A typo the user keeps re-searching should not
    // spend the 1 req/sec budget every time.
    await this.writeCache(cacheKey, places);
    return places;
  }

  private async readCache(key: string): Promise<ResolvedPlace[] | null> {
    const row = await this.db.appState.findUnique({ where: { key } });
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as ResolvedPlace[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      // A corrupted cache entry should degrade to "re-fetch", not poison every future
      // search for the same query.
      return null;
    }
  }

  private async writeCache(key: string, places: ResolvedPlace[]): Promise<void> {
    const value = JSON.stringify(places);
    await this.db.appState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.opts.minIntervalMs - this.opts.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = this.opts.now();
  }
}

function toResolvedPlace(r: NominatimResult): ResolvedPlace | null {
  const lat = r.lat != null ? Number(r.lat) : NaN;
  const lng = r.lon != null ? Number(r.lon) : NaN;
  if (!r.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const a = r.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? undefined;
  const state = abbreviateState(a['ISO3166-2-lvl4'], a.state);

  // Nominatim's own boundingbox order — [south, north, west, east] as strings — already
  // matches ResolvedPlace's documented [minLat, maxLat, minLng, maxLng], so this is a
  // straight parse with no reordering (a classic place to introduce the lat/lng swap bug).
  const bb = r.boundingbox;
  const boundingBox: ResolvedPlace['boundingBox'] =
    bb && bb.length === 4 ? (bb.map(Number) as [number, number, number, number]) : undefined;

  return {
    displayName: r.display_name,
    lat,
    lng,
    city,
    state,
    ...(boundingBox && boundingBox.every(Number.isFinite) ? { boundingBox } : {}),
  };
}

/**
 * Zillow's public URLs take a two-letter state slug ("boulder-co"), but Nominatim's
 * `address.state` is a full name ("Colorado"). Prefer the ISO code Nominatim sometimes
 * supplies ("US-CO") when present; otherwise fall back to a name lookup. An unrecognized
 * or non-US state is passed through unchanged rather than dropped — the cityRadius query
 * still carries useful text even if the eventual URL slug ends up wrong.
 */
export function abbreviateState(iso?: string, name?: string): string | undefined {
  if (iso) {
    const code = iso.split('-')[1];
    if (code) return code.toUpperCase();
  }
  if (!name) return undefined;
  return US_STATE_ABBREVIATIONS[name.trim().toLowerCase()] ?? name;
}

const US_STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR',
};

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|abort/i.test(err.message)) {
      return `${err.message}. If you are running inside a sandbox, its egress proxy may be blocking nominatim.openstreetmap.org.`;
    }
    return err.message;
  }
  return String(err);
}
