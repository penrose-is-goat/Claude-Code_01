import type { NormalizedListing, PropertyType } from './normalized';

export type ProviderId = 'websearch' | 'snapshot' | 'zillow' | 'csv';

/**
 * Providers advertise what they can do; the scheduler and UI degrade gracefully rather
 * than assuming. E.g. the open-house tab hides itself when `supportsOpenHouses` is false.
 */
export interface ProviderCapabilities {
  supportsOpenHouses: boolean;
  supportsPolygonQuery: boolean;
  supportsRadiusQuery: boolean;
  supportsPhotos: boolean;
  supportsPriceHistory: boolean;
  /** null = unmetered (mock, csv). Used to pace runs. */
  rateLimit: { requestsPerRun: number; minIntervalMs: number } | null;
}

/**
 * What the user drew or typed, coarsened for a provider that speaks its own query
 * language rather than raw geometry.
 *
 * No ZIP/postal-code variant, deliberately: the user chose "city + radius" or "draw on
 * the map" and explicitly rejected ZIP codes, so nothing in this interface accepts one.
 * A provider's URL builder MAY still use a ZIP or city slug as an internal query-string
 * detail (Zillow's public search URLs are ZIP- or city-slug-based) — that is an
 * implementation choice made after this type, never something a person types in.
 */
export type AreaQuery =
  | { kind: 'cityRadius'; city: string; state: string; centerLat?: number; centerLng?: number; radiusMiles: number }
  | { kind: 'polygon'; ring: Array<[number, number]> }
  | { kind: 'bbox'; minLat: number; minLng: number; maxLat: number; maxLng: number };

export interface ListingFilters {
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  minBaths?: number;
  propertyTypes?: PropertyType[];
  openHouseOnly?: boolean;
}

export interface FetchOptions {
  area: AreaQuery;
  filters?: ListingFilters;
  /** Providers that support it fetch only records changed since this instant. */
  modifiedSince?: Date;
  /**
   * A human place name for the area, when one is known: "Boulder, CO".
   *
   * `AreaQuery` is geometry, and geometry is all a geo-aware provider needs. A provider
   * backed by a text search engine needs words, and a drawn ring contains none — so the
   * search service passes along whatever name it has (the geocoder's answer, or the
   * label the user gave the shape) and the provider says so plainly when there is none.
   */
  placeHint?: string;
  signal?: AbortSignal;
}

export interface ProviderPage<TRaw = unknown> {
  raw: TRaw[];
  /** undefined => this was the last page */
  cursor?: string;
  requestsUsed: number;
}

export interface HealthCheckResult {
  ok: boolean;
  message: string;
}

export interface ListingProvider<TRaw = unknown> {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  /** Cheap connectivity/credential probe, surfaced on the Settings page. */
  healthCheck(): Promise<HealthCheckResult>;

  /** Paginated pull. Implementations MUST honour `opts.signal`. */
  fetchPage(opts: FetchOptions, cursor?: string): Promise<ProviderPage<TRaw>>;

  /**
   * Pure raw -> normalized. Throws on an unparseable record; the pipeline logs and skips
   * that one row rather than failing the whole run.
   */
  normalize(raw: TRaw): NormalizedListing;
}

/** Convenience: drain every page of a provider for one area. */
/**
 * Convenience: drain every page of a provider for one area.
 *
 * A failure partway through KEEPS the pages already fetched. This is not politeness, it
 * is the difference between working and not: a real run fetched page 1 of a Zillow
 * search successfully, was challenged on page 2, and the exception discarded page 1 —
 * so a search that had genuinely found forty homes reported zero. Later pages are
 * always the least valuable ones, and losing them is a smaller failure than losing
 * everything, so partial results are returned with the reason attached.
 *
 * A failure on the FIRST page has nothing to salvage and rethrows, because "no data and
 * no error" is the one outcome a caller cannot act on.
 */
export async function fetchAll<TRaw>(
  provider: ListingProvider<TRaw>,
  opts: FetchOptions,
  maxPages = 20,
): Promise<{ raw: TRaw[]; requestsUsed: number; partial?: string }> {
  const raw: TRaw[] = [];
  let cursor: string | undefined;
  let requestsUsed = 0;

  for (let page = 0; page < maxPages; page++) {
    let result;
    try {
      result = await provider.fetchPage(opts, cursor);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (page === 0) throw err;
      return {
        raw,
        requestsUsed,
        partial: `Stopped after page ${page} of results: ${message}`,
      };
    }

    raw.push(...result.raw);
    requestsUsed += result.requestsUsed;
    if (!result.cursor) break;
    cursor = result.cursor;

    const pace = provider.capabilities.rateLimit?.minIntervalMs;
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }

  return { raw, requestsUsed };
}
