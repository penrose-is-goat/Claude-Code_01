import type { SearchResult } from './parse';

/**
 * Pluggable web-search backends.
 *
 * The provider needs one capability: "run this query, give me back the indexed
 * {url, title, description} triples". Every general search API offers exactly that, so
 * the interface is deliberately tiny and the app is not married to any one vendor.
 *
 * None of these talk to Zillow. They talk to a search index that has already crawled
 * Zillow's public pages — which is the entire point: the data being read is the data
 * Zillow publishes for crawlers to read.
 */
export interface SearchBackend {
  readonly id: string;
  readonly displayName: string;
  /** How this backend is configured, shown when it isn't. */
  readonly setupHint: string;
  /** True when the necessary environment variables are present. */
  isConfigured(): boolean;
  search(query: string, opts?: SearchBackendOptions): Promise<SearchResult[]>;
}

export interface SearchBackendOptions {
  /** Results wanted. Backends cap this; the sweep paginates rather than assuming.  */
  count?: number;
  /** Zero-based offset for paging deeper into one query's results. */
  offset?: number;
  signal?: AbortSignal;
}

export class SearchBackendError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SearchBackendError';
  }
}

/**
 * Brave Search API. The default recommendation: it has a free tier, it indexes Zillow
 * deeply, and it returns the raw meta description in `description` rather than a
 * re-written summary.
 */
export class BraveBackend implements SearchBackend {
  readonly id = 'brave';
  readonly displayName = 'Brave Search API';
  readonly setupHint = 'Set BRAVE_SEARCH_API_KEY at brave.com/search/api (a credit card is required as of 2026).';

  constructor(private key = process.env.BRAVE_SEARCH_API_KEY ?? '') {}

  isConfigured(): boolean {
    return this.key.trim().length > 0;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    if (!this.isConfigured()) throw new SearchBackendError(this.setupHint);

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(opts.count ?? 20, 20)));
    if (opts.offset) url.searchParams.set('offset', String(opts.offset));

    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.key },
      signal: opts.signal,
    });

    if (!res.ok) {
      throw new SearchBackendError(`Brave Search returned HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as { web?: { results?: Array<Record<string, unknown>> } };
    return (body.web?.results ?? []).flatMap((r) => {
      const url = typeof r.url === 'string' ? r.url : '';
      if (!url) return [];
      return [{
        url,
        title: stripTags(typeof r.title === 'string' ? r.title : ''),
        description: stripTags(typeof r.description === 'string' ? r.description : ''),
      }];
    });
  }
}

/**
 * Google Programmable Search Engine. 100 queries/day free. Configure the engine to
 * search the entire web, otherwise it only returns sites you explicitly listed.
 */
export class GoogleCseBackend implements SearchBackend {
  readonly id = 'google-cse';
  readonly displayName = 'Google Programmable Search';
  readonly setupHint =
    'Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX (closed to new customers since 2026; existing keys still work; ' +
    'the engine must have "Search the entire web" enabled).';

  constructor(
    private key = process.env.GOOGLE_CSE_KEY ?? '',
    private cx = process.env.GOOGLE_CSE_CX ?? '',
  ) {}

  isConfigured(): boolean {
    return this.key.trim().length > 0 && this.cx.trim().length > 0;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    if (!this.isConfigured()) throw new SearchBackendError(this.setupHint);

    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', this.key);
    url.searchParams.set('cx', this.cx);
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(opts.count ?? 10, 10)));
    // The API is 1-indexed and rejects start > 91.
    if (opts.offset) url.searchParams.set('start', String(Math.min(opts.offset + 1, 91)));

    const res = await fetch(url, { signal: opts.signal });
    if (!res.ok) {
      throw new SearchBackendError(`Google CSE returned HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
    return (body.items ?? []).flatMap((r) => {
      const link = typeof r.link === 'string' ? r.link : '';
      if (!link) return [];
      return [{
        url: link,
        title: stripTags(typeof r.title === 'string' ? r.title : ''),
        // `snippet` is Google's rendering of the meta description.
        description: stripTags(typeof r.snippet === 'string' ? r.snippet : ''),
      }];
    });
  }
}

/**
 * A self-hosted SearXNG instance. No API key, no quota, no vendor — the option for
 * someone who would rather run the search themselves. Point SEARXNG_URL at an instance
 * with the JSON format enabled.
 */
export class SearxngBackend implements SearchBackend {
  readonly id = 'searxng';
  readonly displayName = 'SearXNG';
  readonly setupHint =
    'Set SEARXNG_URL to an instance with `formats: [json]` enabled in its settings.yml.';

  constructor(private base = process.env.SEARXNG_URL ?? '') {}

  isConfigured(): boolean {
    return this.base.trim().length > 0;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    if (!this.isConfigured()) throw new SearchBackendError(this.setupHint);

    const url = new URL('/search', this.base.replace(/\/+$/, '') + '/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    // SearXNG pages in tens; translate an offset into its 1-based page number.
    if (opts.offset) url.searchParams.set('pageno', String(Math.floor(opts.offset / 10) + 1));

    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: opts.signal });
    if (!res.ok) {
      throw new SearchBackendError(`SearXNG returned HTTP ${res.status}`, res.status);
    }

    const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return (body.results ?? []).flatMap((r) => {
      const link = typeof r.url === 'string' ? r.url : '';
      if (!link) return [];
      return [{
        url: link,
        title: stripTags(typeof r.title === 'string' ? r.title : ''),
        description: stripTags(typeof r.content === 'string' ? r.content : ''),
      }];
    });
  }
}

/**
 * Mojeek's web-search API.
 *
 * The one no-credit-card option that remains in 2026: 2,000 queries a month, up to one
 * per second, no card on file. Mojeek runs its own crawl rather than reselling somebody
 * else's, so its Zillow coverage differs from Google's and Bing's — narrower on tail
 * queries, still substantial on the head. It is the default when nothing else is
 * configured because it is the one thing a fresh install can turn on in two minutes.
 *
 * Response shape is written DEFENSIVELY. I could not reach mojeek.com from this project's
 * container to confirm the exact field names against a live response, so this reads the
 * shape it expects and degrades to an empty array on anything else. The two names most
 * likely to shift — the results array location and the snippet field — are tolerated in
 * every form the docs and community examples have used. If Mojeek adds a field or renames
 * one, wrong shape becomes "no results", never wrong results.
 *
 * To confirm the contract against the real API, one query returned to stderr is enough:
 *   curl -sS 'https://www.mojeek.com/search?q=test&fmt=json&api_key=$MOJEEK_API_KEY' | jq
 */
export class MojeekBackend implements SearchBackend {
  readonly id = 'mojeek';
  readonly displayName = 'Mojeek Search API';
  readonly setupHint = 'Set MOJEEK_API_KEY at mojeek.com/services/search/web-search-api (2,000 queries/month, no credit card).';

  constructor(
    private key = process.env.MOJEEK_API_KEY ?? '',
    private fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  isConfigured(): boolean {
    return this.key.trim().length > 0;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    if (!this.isConfigured()) throw new SearchBackendError(this.setupHint);

    const url = new URL('https://www.mojeek.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('api_key', this.key);
    if (opts.count) url.searchParams.set('t', String(Math.min(opts.count, 50)));
    if (opts.offset) url.searchParams.set('s', String(opts.offset));

    const res = await this.fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    });

    // Distinct messages for each failure class, so a support answer is one line instead
    // of "HTTP 429" left for the user to look up. No key value is ever interpolated —
    // an error message that echoes a secret is a leak.
    if (res.status === 401 || res.status === 403) {
      throw new SearchBackendError(`Mojeek rejected the API key (HTTP ${res.status}).`, res.status);
    }
    if (res.status === 429) {
      throw new SearchBackendError(
        'Mojeek rate limit or monthly quota reached (HTTP 429). ' +
        'The free tier is 2,000 queries a month; wait or reduce the query budget.',
        429,
      );
    }
    if (res.status >= 500) {
      throw new SearchBackendError(`Mojeek server error (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok) throw new SearchBackendError(`Mojeek returned HTTP ${res.status}.`, res.status);

    const body: unknown = await res.json().catch(() => null);
    return extractMojeekResults(body);
  }
}

/** Reads Mojeek's results array without trusting any one field name. */
export function extractMojeekResults(body: unknown): SearchResult[] {
  if (!body || typeof body !== 'object') return [];

  // `response.results` is the documented location; a bare `results` at the top level
  // has been observed in older examples. Neither being present is a real answer — the
  // query legitimately returned nothing — and NOT the same failure as a shape change.
  const outer = body as Record<string, unknown>;
  const response = outer.response as Record<string, unknown> | undefined;
  const raw = pickArray(response?.results) ?? pickArray(outer.results);
  if (!raw) return [];

  const out: SearchResult[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const url = str(r.url) ?? str(r.link);
    const title = str(r.title);
    if (!url || !title) continue;

    // `desc` in current examples; `description` and `snippet` accepted in case the
    // field is renamed. Absent snippet is fine — the URL and title alone still identify
    // a listing and the parser handles a missing description.
    const description = str(r.desc) ?? str(r.description) ?? str(r.snippet);
    out.push({ url, title, description });
  }
  return out;
}

function pickArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Replays results captured earlier into the same parser.
 *
 * This is how a harvest run performed with a search tool outside the app — see
 * `scripts/harvest.ts` — reaches the identical code path as a live backend. It is a
 * transport, not a fixture generator: every result it returns was really returned by a
 * real search of the real public index, and the capture file records when and how.
 */
export class CapturedBackend implements SearchBackend {
  readonly id = 'captured';
  readonly displayName = 'Captured search results';
  readonly setupHint = 'Provide captured results in the constructor.';

  constructor(private byQuery: Map<string, SearchResult[]>) {}

  isConfigured(): boolean {
    return this.byQuery.size > 0;
  }

  async search(query: string): Promise<SearchResult[]> {
    return this.byQuery.get(query) ?? [];
  }
}

/**
 * Picks the first configured backend, honouring an explicit SEARCH_BACKEND override.
 * Returns null when nothing is configured — the caller reports that as a setup problem
 * with instructions, never as "no homes found".
 */
export function defaultBackends(): SearchBackend[] {
  // Mojeek first: it is the only option here that a fresh install can turn on without a
  // credit card or a prior Google account. The others are kept for anyone who already
  // has those keys, but nobody should be sent to sign up for them in 2026.
  return [new MojeekBackend(), new BraveBackend(), new GoogleCseBackend(), new SearxngBackend()];
}

export function resolveBackend(
  available: SearchBackend[] = defaultBackends(),
  preferred = process.env.SEARCH_BACKEND,
): { backend: SearchBackend | null; hints: string[] } {
  if (preferred) {
    const chosen = available.find((b) => b.id === preferred);
    if (!chosen) {
      return { backend: null, hints: [`SEARCH_BACKEND=${preferred} is not a known backend.`] };
    }
    return chosen.isConfigured()
      ? { backend: chosen, hints: [] }
      : { backend: null, hints: [chosen.setupHint] };
  }

  const configured = available.find((b) => b.isConfigured());
  if (configured) return { backend: configured, hints: [] };

  // A fresh install has nothing set. Naming Mojeek first is the difference between "here
  // is the two-minute answer" and a wall of signup links to services that have retired,
  // gone paywalled, or closed to new customers.
  const mojeek = available.find((b) => b.id === 'mojeek');
  const rest = available.filter((b) => b.id !== 'mojeek');
  const hints = [
    ...(mojeek ? [`${mojeek.displayName}: ${mojeek.setupHint}`] : []),
    ...rest.map((b) => `${b.displayName}: ${b.setupHint}`),
  ];
  return { backend: null, hints };
}

/** Search APIs return titles with <strong> around the matched terms. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
