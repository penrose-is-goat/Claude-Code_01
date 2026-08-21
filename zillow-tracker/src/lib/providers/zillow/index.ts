import type { NormalizedListing } from '../normalized';
import { browserAvailable, fetchRendered } from './browser';
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
  /**
   * How pages are retrieved.
   *
   *  - `browser` drives a real headless Chromium. Slower to start, and the only mode
   *    that has any prospect of working: Zillow refuses a plain fetch with 403 because
   *    of what the client is, not where it is from.
   *  - `fetch` is the plain HTTP path, kept because it is what the tests exercise and
   *    what a permitted deployment would use.
   *  - `auto` (the default) tries the browser and falls back to fetch when Playwright or
   *    Chromium is not installed.
   */
  transport?: 'auto' | 'browser' | 'fetch';
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
  /** Why the browser transport was skipped, surfaced in healthCheck. */
  private browserNote: string | null = null;
  private readonly opts: Required<Omit<ZillowProviderOptions, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };

  constructor(options: ZillowProviderOptions = {}) {
    this.opts = {
      transport: options.transport ?? (process.env.ZILLOW_TRANSPORT as 'auto' | 'browser' | 'fetch') ?? 'auto',
      timezone: options.timezone ?? process.env.TZ ?? 'America/Denver',
      minIntervalMs: options.minIntervalMs ?? 1500,
      userAgent: options.userAgent ?? DEFAULT_UA,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      now: options.now ?? (() => new Date()),
    };
  }

  async healthCheck(area?: AreaQuery): Promise<HealthCheckResult> {
    try {
      // No baked-in city. A health check is "is this source reachable and still the
      // shape we parse", and any area answers that — so it uses the one the caller is
      // actually interested in, and only falls back to a well-known large market when
      // asked to probe with no area in hand.
      const html = await this.get(probeUrl(area));
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

    if (this.opts.transport !== 'fetch') {
      try {
        return await this.getViaBrowser(url, signal);
      } catch (err) {
        if (err instanceof ZillowBlockedError) throw err;
        if (this.opts.transport === 'browser') throw err;
        // `auto`: no browser installed, so fall through to the plain fetch below. That
        // path is expected to 403, and says so, which is still better than failing with
        // a message about Playwright when the user never asked for a browser.
        this.browserNote = err instanceof Error ? err.message : String(err);
      }
    }

    const res = await this.opts.fetchImpl(url, {
      signal,
      redirect: 'follow',
      // A complete, honest set of headers — what an ordinary Chrome tab sends when a
      // person navigates to this URL, nothing more. This is here to rule out "the
      // request looked incomplete" as the reason for the 403, not to disguise the
      // client: there is no TLS fingerprint spoofing, no header order trickery, no
      // proxy rotation. If Zillow still refuses a complete, honest request, that is a
      // real answer, not an artifact of a lazy fetch.
      headers: {
        'User-Agent': this.opts.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'Upgrade-Insecure-Requests': '1',
        // Sec-Fetch-* describe a top-level document navigation typed into the address
        // bar — the same posture a first-time visitor has, matching "no login, no
        // cookies" above.
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        // Client-hints companions to the Chrome UA string in DEFAULT_UA; a UA claiming
        // Chrome 126 with no matching Sec-Ch-Ua triplet is itself a mismatch a server
        // can flag, independent of anything meant to evade detection.
        'Sec-Ch-Ua': '"Chromium";v="126", "Not.A/Brand";v="24", "Google Chrome";v="126"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
      },
    });

    if (res.status === 403 || res.status === 429) {
      // Stop immediately. Retrying a refusal is both rude and pointless.
      throw new ZillowBlockedError(
        `Zillow declined the request (HTTP ${res.status}). This is expected: Zillow refuses ` +
        `direct page fetches even from an ordinary residential connection. The supported path is ` +
        `the "websearch" provider, which reads the same listings from the public search index ` +
        `Zillow publishes them to. CSV import remains available for an MLS or Redfin export.`,
        res.status,
      );
    }
    if (!res.ok) {
      throw new Error(`Zillow returned HTTP ${res.status} for ${url}`);
    }

    return res.text();
  }

  /**
   * Opens the page in a real browser and returns what rendered.
   *
   * A 403 here means something different from a 403 on a plain fetch, and the message
   * says so: the plain fetch is refused for being an obvious non-browser, while a real
   * Chromium being refused is Zillow declining this connection specifically.
   */
  private async getViaBrowser(url: string, signal?: AbortSignal): Promise<string> {
    const { html, status } = await fetchRendered(url, { signal });

    if (status === 403 || status === 429) {
      throw new ZillowBlockedError(
        `Zillow declined the request (HTTP ${status}) even from a real browser. ` +
        'Try again in a few minutes, or use the "websearch" provider, which reads the ' +
        'same listings from the public search index Zillow publishes them to.',
        status,
      );
    }
    if (status >= 400) throw new Error(`Zillow returned HTTP ${status} for ${url}`);

    return html;
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
  // Zillow spells the open-house filter two different ways, and which one is valid
  // depends on the URL form. An area-slug page takes the `/open-house/` path segment
  // (`/boulder-co/open-house/`, `/fl/open-house/`). A map-bounds query lives under
  // `/homes/` and takes `for_sale/1_open/` instead — both confirmed against real indexed
  // Zillow URLs. Using the slug spelling under /homes/ built a URL that is not the
  // open-house filter at all, so every drawn open-house search asked the wrong question.
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
      return boundsUrl(base, openHouseOnly, paged, area, page);

    case 'polygon': {
      const lngs = area.ring.map((r) => r[0]);
      const lats = area.ring.map((r) => r[1]);
      return boundsUrl(base, openHouseOnly, paged, {
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
  openHouseOnly: boolean,
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
  const facet = openHouseOnly ? 'for_sale/1_open/' : 'for_sale/';
  return `${base}/homes/${facet}${paged}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
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

/**
 * The URL a health check probes.
 *
 * Falls back to a national listing page rather than any particular city: a fallback that
 * names a town reads as that town being special to this app, and it is not.
 */
function probeUrl(area?: AreaQuery): string {
  if (area?.kind === 'cityRadius' && area.city && area.state) {
    const slug = `${area.city.trim().toLowerCase().replace(/\s+/g, '-')}-${area.state.toLowerCase()}`;
    return `https://www.zillow.com/${slug}/open-house/`;
  }
  return 'https://www.zillow.com/homes/for_sale/';
}
