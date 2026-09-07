import type { NormalizedListing } from '../normalized';
import { browserAvailable, fetchRendered } from './browser';
import { UserBrowserSession, howToEnable, userBrowserAvailable } from './userBrowser';
import { querySearchApi, type SearchQueryState } from './searchApi';
import { boundsOf } from './bounds';
import { harvestArea, type HarvestReport } from './harvest';
import type {
  AreaQuery, FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import {
  ZillowParseError, normalizeZillowResult, parseSearchPage, type ParseContext,
} from './parse';

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
   *  - `user-browser` attaches to the Chrome the person already has open, through its
   *    DevTools port. The only mode measured to work: a launched headless Chromium was
   *    refused 403 by Zillow from a real residential connection, while a browser someone
   *    started for their own use is not distinguishable from that person browsing —
   *    because it is that person browsing.
   *  - `browser` launches a headless Chromium. Kept for completeness; expect a 403.
   *  - `fetch` is the plain HTTP path. Expect a 403.
   *  - `auto` (the default) tries them in that order.
   */
  transport?: 'auto' | 'user-browser' | 'browser' | 'fetch';
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
  /** Set while a human-verification challenge is waiting to be solved. */
  private challengeNote: string | null = null;
  private session: UserBrowserSession | null = null;

  /**
   * The most recent map harvest, so callers can say how complete a search was — how many
   * page reads it took, how many areas were left incomplete, and what Zillow itself
   * reported as the total for the area.
   */
  lastHarvest: HarvestReport | null = null;
  /** The search page the session is currently sitting on. */
  private landedOn: string | null = null;
  /** Why the JSON path was skipped, if it was. */
  private apiNote: string | null = null;
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
    const attached = await userBrowserAvailable();
    if (attached.ok) return { ok: true, message: attached.message };
    if (this.opts.transport === 'user-browser') return { ok: false, message: howToEnable() };

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

    // Preferred path: one navigation to establish the session, then every page of
    // results queried as JSON from inside that loaded page — which is what Zillow's own
    // app does when you turn a page, and means a human clears a verification prompt at
    // most once per search rather than once per page.
    if (this.opts.transport === 'auto' || this.opts.transport === 'user-browser') {
      try {
        return await this.fetchPageViaApi(opts, page);
      } catch (err) {
        if (this.opts.transport === 'user-browser') throw err;
        this.apiNote = err instanceof Error ? err.message : String(err);
      }
    }

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

    // The user's own browser first: it is the transport that was measured to work.
    if (this.opts.transport === 'auto' || this.opts.transport === 'user-browser') {
      try {
        return await this.getViaUserBrowser(url, signal);
      } catch (err) {
        if (err instanceof ZillowBlockedError) throw err;
        if (this.opts.transport === 'user-browser') throw err;
        this.browserNote = err instanceof Error ? err.message : String(err);
      }
    }

    if (this.opts.transport === 'auto' || this.opts.transport === 'browser') {
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
  /**
   * Fetches one page of results as JSON, from inside a loaded Zillow page.
   *
   * The navigation happens once per provider instance. Every later page reuses that
   * same document, so a multi-page search is one page load and N in-page requests
   * rather than N page loads.
   */
  private async fetchPageViaApi(
    opts: FetchOptions,
    pageNumber: number,
  ): Promise<ProviderPage<NormalizedListing>> {
    this.session ??= new UserBrowserSession();

    const landingUrl = buildSearchUrl(opts.area, 1, Boolean(opts.filters?.openHouseOnly));

    if (!this.landedOn || this.landedOn !== landingUrl) {
      await this.session.openPage(landingUrl, {
        challengeTimeoutMs: Number(process.env.ZILLOW_CHALLENGE_TIMEOUT_MS ?? 180_000),
        signal: opts.signal,
        onChallenge: () => {
          this.challengeNote =
            'Zillow is asking your browser to confirm a human. Switch to that Chrome ' +
            'window and press and hold the button — the search continues by itself, and ' +
            'the rest of this search will not ask again.';
          console.log(`[zillow] ${this.challengeNote}`);
        },
      });
      this.landedOn = landingUrl;
    }

    const page = await this.session.openPage(landingUrl, { signal: opts.signal });
    const openHouseOnly = Boolean(opts.filters?.openHouseOnly);

    /*
     * One harvest, not one page.
     *
     * Zillow will not page past a fixed number of pages for a single map box, so asking
     * a metro in one rectangle returns the cap and stops — no error, no gap marker. A
     * measured example: an area holding 1,737 for-sale homes yields exactly 800 through
     * a flat 20-page scan, and all 1,737 when the box is quartered until each piece fits.
     * `harvestArea` owns that traversal and its stopping conditions; this closure is only
     * the transport.
     */
    const report = await harvestArea(
      async (mapBounds, pageNo) => {
        const state: SearchQueryState = {
          isMapVisible: true,
          isListVisible: true,
          mapBounds,
          pagination: pageNo > 1 ? { currentPage: pageNo } : undefined,
          filterState: openHouseOnly ? { isOpenHousesOnly: { value: true } } : undefined,
        };
        const r = await querySearchApi(page, state);
        return { results: r.results, total: r.total, totalPages: r.totalPages };
      },
      boundsOf(opts.area),
      {
        maxPagesPerBox: Number(process.env.ZILLOW_MAX_PAGES_PER_BOX ?? 20),
        maxPageReads: Number(process.env.ZILLOW_MAX_PAGE_READS ?? 400),
        // Same lesson as the websearch sweep: return a partial harvest rather than let
        // the caller time out holding nothing.
        deadlineMs: Number(process.env.ZILLOW_TIME_BUDGET_MS ?? 120_000),
        signal: opts.signal,
      },
    );

    const ctx = this.ctx();
    const listings: NormalizedListing[] = [];
    let skipped = 0;
    for (const row of report.rows) {
      try {
        listings.push(normalizeZillowResult(row, ctx));
      } catch {
        skipped++;
      }
    }
    if (skipped > 0) console.warn(`[zillow] skipped ${skipped} unparseable result(s)`);

    this.lastHarvest = report;
    console.log(
      `[zillow] harvested ${listings.length} homes from ${report.pageReads} page reads ` +
      `(${report.boxesCompleted} areas, ${report.boxesSubdivided} split` +
      `${report.boxesTruncated > 0 ? `, ${report.boxesTruncated} left incomplete` : ''}) ` +
      `- ${report.stopReason}` +
      (report.sourceTotal ? `; Zillow reports ${report.sourceTotal} for the area` : ''),
    );

    // The traversal is exhaustive, so there is no next page to ask for. `lastHarvest`
    // carries whether it finished, which is the honest answer to "is this everything?".
    return { raw: listings, requestsUsed: report.pageReads };
  }

  /**
   * Reads the page through the browser the person already has open.
   *
   * A 403 here means something quite different from a 403 anywhere else: it would mean
   * Zillow is refusing this person's own browser, which is exactly what they would see
   * by typing the address in themselves. That is a fact about their access rather than
   * about this app, and the message says so instead of blaming the transport.
   */
  private async getViaUserBrowser(url: string, signal?: AbortSignal): Promise<string> {
    // One session per provider instance, so a multi-page search is one tab navigating
    // rather than a new connection and a new tab per page.
    this.session ??= new UserBrowserSession();

    const { html, status, solvedChallenge } = await this.session.fetch(url, {
      signal,
      // Long enough for a person to notice the tab and hold the button. Only the first
      // fetch normally needs this: solving sets a cookie in that browser profile, and
      // subsequent pages in the same profile go straight through.
      challengeTimeoutMs: Number(process.env.ZILLOW_CHALLENGE_TIMEOUT_MS ?? 180_000),
      onChallenge: () => {
        this.challengeNote =
          'Zillow is asking your browser to confirm a human. Switch to the Chrome window ' +
          'that just opened and press and hold the button — the search continues by itself ' +
          'once you do.';
        console.log(`[zillow] ${this.challengeNote}`);
      },
    });

    if (solvedChallenge && status < 400) this.challengeNote = null;

    if (status === 403 || status === 429) {
      throw new ZillowBlockedError(
        `Zillow returned HTTP ${status} to your own browser and no listings appeared` +
        (solvedChallenge
          ? ' after waiting for the human-verification challenge to be solved. If the ' +
            'challenge is still on screen, solve it and search again — the answer is ' +
            'remembered for a while.'
          : `. Open ${url} in that same browser window; if you see the same refusal by ` +
            'hand, this is about your connection rather than about this app.'),
        status,
      );
    }
    if (status >= 400) throw new Error(`Zillow returned HTTP ${status} for ${url}`);
    return html;
  }

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
