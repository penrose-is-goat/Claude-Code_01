import type { NormalizedListing } from '../normalized';
import type {
  AreaQuery, FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import { parseSearchPage, ZillowParseError, type ParseContext } from './parse';

/**
 * Reads Zillow's public, logged-out search pages.
 *
 * Deliberate constraints, all of them load-bearing:
 *   - No account, no cookies, no login. Logged-out is both simpler and the safer posture.
 *   - One request per area per run, paced at >=1s. We are a single household checking a
 *     handful of neighborhoods, and the traffic profile should look like it.
 *   - Hard stop on the first challenge response. No retry storms, no evasion. If Zillow
 *     declines, we record that honestly and let the CSV path take over.
 *
 * Zillow's Terms of Use disallow automated access. This provider is off by default and
 * the README says so plainly; enabling it is the operator's call.
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class ZillowBlockedError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ZillowBlockedError';
  }
}

export interface ZillowProviderOptions {
  timezone?: string;
  minIntervalMs?: number;
  userAgent?: string;
  /** Injectable so tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class ZillowPublicProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'zillow' as const;
  readonly displayName = 'Zillow (public pages)';
  readonly capabilities: ProviderCapabilities = {
    supportsOpenHouses: true,
    // Drawn shapes are sent as map bounds and the exact ring is re-applied locally,
    // so a bounding box is always a superset — never a silently narrower answer.
    supportsPolygonQuery: true,
    supportsRadiusQuery: false,
    supportsPhotos: true,
    supportsPriceHistory: false,
    rateLimit: { requestsPerRun: 4, minIntervalMs: 1500 },
  };

  private lastRequestAt = 0;
  private readonly opts: Required<Omit<ZillowProviderOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };

  constructor(options: ZillowProviderOptions = {}) {
    this.opts = {
      timezone: options.timezone ?? process.env.TZ ?? 'America/Denver',
      minIntervalMs: options.minIntervalMs ?? 1500,
      userAgent: options.userAgent ?? DEFAULT_UA,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      now: options.now ?? (() => new Date()),
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const html = await this.get('https://www.zillow.com/boulder-co/open-house/');
      const { listings } = parseSearchPage(html, this.ctx());
      return {
        ok: listings.length > 0,
        message:
          listings.length > 0
            ? `Reachable — parsed ${listings.length} listings from a sample page`
            : 'Page fetched but zero listings parsed (schema may have changed)',
      };
    } catch (err) {
      return { ok: false, message: describeError(err) };
    }
  }

  async fetchPage(opts: FetchOptions, cursor?: string): Promise<ProviderPage<NormalizedListing>> {
    const page = cursor ? Number(cursor) : 1;
    const url = buildSearchUrl(opts.area, page, Boolean(opts.filters?.openHouseOnly));

    const html = await this.get(url, opts.signal);
    const { listings, skipped } = parseSearchPage(html, this.ctx());

    if (skipped > 0) {
      console.warn(`[zillow] skipped ${skipped} unparseable result(s) on page ${page}`);
    }

    // Zillow caps a search at 20 pages; we stop well short of that by design.
    const hasMore = listings.length >= 40 && page < 3;

    return {
      raw: listings,
      cursor: hasMore ? String(page + 1) : undefined,
      requestsUsed: 1,
    };
  }

  normalize(raw: NormalizedListing): NormalizedListing {
    return raw; // parseSearchPage already produced the normalized shape
  }

  private ctx(): ParseContext {
    return { timezone: this.opts.timezone, fetchedAt: this.opts.now() };
  }

  private async get(url: string, signal?: AbortSignal): Promise<string> {
    await this.pace();

    const res = await this.opts.fetchImpl(url, {
      signal,
      redirect: 'follow',
      headers: {
        'User-Agent': this.opts.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    if (res.status === 403 || res.status === 429) {
      // Stop immediately. Retrying a refusal is both rude and pointless.
      throw new ZillowBlockedError(
        `Zillow declined the request (HTTP ${res.status}). Falling back to CSV import is the supported path.`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new Error(`Zillow returned HTTP ${res.status} for ${url}`);
    }

    return res.text();
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}

/**
 * Zillow's public URLs are slug-based. Polygons and radii have no URL representation, so
 * they are coarsened here and re-filtered precisely in the geo layer.
 */
export function buildSearchUrl(area: AreaQuery, page = 1, openHouseOnly = false): string {
  const base = 'https://www.zillow.com';
  const suffix = openHouseOnly ? 'open-house/' : '';
  const paged = page > 1 ? `${page}_p/` : '';

  switch (area.kind) {
    case 'cityRadius': {
      // Zillow's own slug, not anything the user typed — the user gave us a place name
      // and a radius; this is just how that gets spelled in Zillow's URL scheme.
      const slug = `${slugify(area.city)}-${area.state.toLowerCase()}`;
      return `${base}/${slug}/${suffix}${paged}`;
    }

    // A drawn shape becomes a map-bounds query. Without this, "draw an area" could only
    // ever be served from cached data — the live provider would refuse every drawn
    // search, which defeats the feature. Zillow accepts bounds via searchQueryState;
    // the exact shape is re-applied locally afterwards, since a box is only ever a
    // superset of the ring the user drew.
    case 'bbox':
      return boundsUrl(base, suffix, paged, area, page);

    case 'polygon': {
      const lngs = area.ring.map((r) => r[0]);
      const lats = area.ring.map((r) => r[1]);
      return boundsUrl(base, suffix, paged, {
        minLat: Math.min(...lats), maxLat: Math.max(...lats),
        minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
      }, page);
    }
  }
}

/**
 * Zillow encodes map bounds in a JSON `searchQueryState` query parameter. Shape
 * confirmed against @use_homi/real-estate-portal-schemas, whose Zillow schema was
 * verified against the live site by browser automation.
 */
function boundsUrl(
  base: string,
  suffix: string,
  paged: string,
  b: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  page: number,
): string {
  const state = {
    isMapVisible: true,
    isListVisible: true,
    mapBounds: { north: b.maxLat, east: b.maxLng, south: b.minLat, west: b.minLng },
    filterState: { sortSelection: { value: 'globalrelevanceex' }, isAllHomes: { value: true } },
    pagination: page > 1 ? { currentPage: page } : {},
  };
  return `${base}/homes/${suffix}${paged}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function describeError(err: unknown): string {
  if (err instanceof ZillowBlockedError) return err.message;
  if (err instanceof ZillowParseError) return `Parse failed (${err.kind}): ${err.message}`;
  if (err instanceof Error) {
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(err.message)) {
      return `Network unreachable: ${err.message}. If you are running inside a sandbox, its egress proxy may be blocking zillow.com.`;
    }
    return err.message;
  }
  return String(err);
}
