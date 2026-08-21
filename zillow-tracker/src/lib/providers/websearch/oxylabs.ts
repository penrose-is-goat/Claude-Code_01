import type { SearchResult } from './parse';

/**
 * Oxylabs Web Scraper API.
 *
 * This is the paid path, and it is the only one that solves the actual problem rather
 * than working around it. Zillow refuses direct page fetches with a 403 — confirmed from
 * an ordinary residential connection, not just from a sandbox — so every other approach
 * in this project reads Zillow second-hand through a search index. Oxylabs fetches the
 * Zillow page itself, handling the anti-bot layer that produced the 403.
 *
 * That matters beyond convenience. A search snippet carries an address, a price and a
 * bed count. A Zillow PAGE carries coordinates, the full open-house schedule, price
 * history and status — the things this app was asked for and has been approximating.
 *
 * Two capabilities are used, and they are genuinely different:
 *
 *   - `universal` + a Zillow URL returns that page's HTML, which the existing Zillow
 *     parser already knows how to read. It has never had a real page to read until now.
 *   - `google_search` + `parse: true` returns Google's organic results as structured
 *     JSON, which feeds the same websearch harvest as any other backend.
 *
 * It needs credentials. There is no way around that and no point pretending otherwise:
 * an unblocking service is a service. What it buys is the difference between tracking
 * Zillow and guessing at it.
 */

const REALTIME_ENDPOINT = 'https://realtime.oxylabs.io/v1/queries';

export interface OxylabsOptions {
  username?: string;
  password?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Country/state for search-engine geo-targeting, e.g. "Maryland,United States". */
  geoLocation?: string;
}

export class OxylabsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'OxylabsError';
  }
}

export class OxylabsClient {
  private readonly username: string;
  private readonly password: string;
  private readonly endpoint: string;
  private readonly doFetch: typeof fetch;
  readonly geoLocation?: string;

  constructor(opts: OxylabsOptions = {}) {
    this.username = opts.username ?? process.env.OXY_WSA_USERNAME ?? '';
    this.password = opts.password ?? process.env.OXY_WSA_PASSWORD ?? '';
    this.endpoint = opts.endpoint ?? process.env.OXY_WSA_ENDPOINT ?? REALTIME_ENDPOINT;
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
    this.geoLocation = opts.geoLocation ?? process.env.OXY_GEO_LOCATION;
  }

  isConfigured(): boolean {
    return this.username.trim().length > 0 && this.password.trim().length > 0;
  }

  /** Runs one job and returns the `results[0]` entry, or throws with a usable message. */
  async query(payload: Record<string, unknown>, signal?: AbortSignal): Promise<OxylabsResult> {
    if (!this.isConfigured()) {
      throw new OxylabsError('Set OXY_WSA_USERNAME and OXY_WSA_PASSWORD (oxylabs.io).');
    }

    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const res = await this.doFetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(payload),
      signal,
    });

    if (res.status === 401) throw new OxylabsError('Oxylabs rejected the credentials (HTTP 401).', 401);
    if (res.status === 403) throw new OxylabsError('Oxylabs denied this request (HTTP 403).', 403);
    if (res.status === 429) throw new OxylabsError('Oxylabs rate limit reached (HTTP 429).', 429);
    if (!res.ok) throw new OxylabsError(`Oxylabs returned HTTP ${res.status}.`, res.status);

    const body = (await res.json()) as { results?: OxylabsResult[] };
    const first = body.results?.[0];
    if (!first) throw new OxylabsError('Oxylabs returned no results entry.');

    // A job can succeed at the API level and still have failed at the target.
    if (typeof first.status_code === 'number' && first.status_code >= 400) {
      throw new OxylabsError(
        `The target returned HTTP ${first.status_code} through Oxylabs.`,
        first.status_code,
      );
    }
    return first;
  }

  /**
   * Fetches a page as HTML.
   *
   * `render: 'html'` runs a real browser, which Zillow's listing pages need — the data
   * this project parses lives in a script blob written during hydration.
   */
  async fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
    const result = await this.query(
      { source: 'universal', url, render: 'html', user_agent_type: 'desktop_chrome' },
      signal,
    );

    const content = result.content;
    if (typeof content !== 'string') {
      throw new OxylabsError('Expected HTML from Oxylabs but received structured content.');
    }
    return content;
  }

  /** Runs a Google search and returns its organic results, already structured. */
  async googleSearch(query: string, page = 1, signal?: AbortSignal): Promise<SearchResult[]> {
    const payload: Record<string, unknown> = {
      source: 'google_search',
      query,
      parse: true,
      start_page: page,
    };
    // Search engines take country/state here, not a ZIP.
    if (this.geoLocation) payload.geo_location = this.geoLocation;

    const result = await this.query(payload, signal);
    return extractOrganic(result.content);
  }
}

export interface OxylabsResult {
  content?: unknown;
  status_code?: number;
  url?: string;
}

/**
 * Pulls organic results out of Oxylabs' parsed Google payload.
 *
 * Shape is `content.results.organic[]` with `url`, `title` and `desc`. Written
 * defensively because a parser upstream of this one changing shape must degrade to "no
 * results" rather than to wrong results — and because paid ad slots live alongside the
 * organic ones and must never be read as listings.
 */
export function extractOrganic(content: unknown): SearchResult[] {
  if (!content || typeof content !== 'object') return [];

  const results = (content as { results?: unknown }).results;
  if (!results || typeof results !== 'object') return [];

  const organic = (results as { organic?: unknown }).organic;
  if (!Array.isArray(organic)) return [];

  const out: SearchResult[] = [];
  for (const row of organic) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;

    const url = typeof r.url === 'string' ? r.url : '';
    const title = typeof r.title === 'string' ? r.title : '';
    if (!url || !title) continue;

    // `desc` is Google's rendering of the page's meta description — the string this
    // project reads price, beds, baths and square footage out of.
    const description = typeof r.desc === 'string' ? r.desc : undefined;
    out.push({ url, title, description });
  }
  return out;
}
