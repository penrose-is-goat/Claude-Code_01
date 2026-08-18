import type { NormalizedListing, PropertyType } from './normalized';

export type ProviderId = 'snapshot' | 'zillow' | 'csv';

/**
 * Providers advertise what they can do; the scheduler and UI degrade gracefully rather
 * than assuming. E.g. the open-house tab hides itself when `supportsOpenHouses` is false.
 */
export interface ProviderCapabilities {
  supportsOpenHouses: boolean;
  supportsPolygonQuery: boolean;
  supportsRadiusQuery: boolean;
  supportsPostalCodeQuery: boolean;
  supportsPhotos: boolean;
  supportsPriceHistory: boolean;
  /** null = unmetered (mock, csv). Used to pace runs. */
  rateLimit: { requestsPerRun: number; minIntervalMs: number } | null;
}

/**
 * What the user drew or typed. Providers translate this into their own query language,
 * usually by coarsening it (polygon -> bounding box -> covering ZIPs).
 */
export type AreaQuery =
  | { kind: 'postalCodes'; codes: string[] }
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
export async function fetchAll<TRaw>(
  provider: ListingProvider<TRaw>,
  opts: FetchOptions,
  maxPages = 20,
): Promise<{ raw: TRaw[]; requestsUsed: number }> {
  const raw: TRaw[] = [];
  let cursor: string | undefined;
  let requestsUsed = 0;

  for (let page = 0; page < maxPages; page++) {
    const result = await provider.fetchPage(opts, cursor);
    raw.push(...result.raw);
    requestsUsed += result.requestsUsed;
    if (!result.cursor) break;
    cursor = result.cursor;

    const pace = provider.capabilities.rateLimit?.minIntervalMs;
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }

  return { raw, requestsUsed };
}
