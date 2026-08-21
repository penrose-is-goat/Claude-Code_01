import type { SearchResult } from './parse';
import { detectBlockPage, parseDuckDuckGoHtml, parseMojeekHtml } from './html';

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
 * DuckDuckGo, with no API key.
 *
 * This is the default, and it is the default because the alternative was a product that
 * did nothing until its owner registered for a search API. Someone typed in their own
 * town, got zero results and a wall of setup instructions, and was right to call that
 * broken.
 *
 * It requests the same public no-JavaScript results page a browser would, from the
 * user's own machine and their own IP, at human pace. There is no key, no account, no
 * quota, and nothing to configure.
 *
 * A refusal is reported as a refusal. A challenge page parses to zero results, which is
 * indistinguishable from "this town has no houses for sale" unless it is named — so it
 * is named, and the sweep stops rather than grinding out an empty market.
 */
export class DuckDuckGoBackend implements SearchBackend {
  readonly id = 'duckduckgo';
  readonly displayName = 'DuckDuckGo (no API key)';
  readonly setupHint = 'Nothing to set up — this works out of the box.';

  constructor(private doFetch: typeof fetch = globalThis.fetch) {}

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    // POST, not GET: the HTML endpoint expects a form submission, which is what the
    // no-JS page itself sends. Pagination is DuckDuckGo's own `s` offset.
    const body = new URLSearchParams({ q: query, b: '' });
    if (opts.offset) body.set('s', String(opts.offset));

    const res = await this.doFetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_UA,
      },
      body,
      signal: opts.signal,
    });

    if (!res.ok) {
      throw new SearchBackendError(`DuckDuckGo returned HTTP ${res.status}`, res.status);
    }

    const html = await res.text();
    const blocked = detectBlockPage(html);
    if (blocked) {
      throw new SearchBackendError(
        `DuckDuckGo served a ${blocked} instead of results. Wait a few minutes and retry, ` +
        'or lower the query budget so the sweep asks less often.',
      );
    }

    return parseDuckDuckGoHtml(html);
  }
}

/**
 * Mojeek, with no API key.
 *
 * An independent crawler rather than a front-end onto someone else's index, which makes
 * it a genuine second opinion when DuckDuckGo is rate-limiting.
 */
export class MojeekBackend implements SearchBackend {
  readonly id = 'mojeek';
  readonly displayName = 'Mojeek (no API key)';
  readonly setupHint = 'Nothing to set up — this works out of the box.';

  constructor(private doFetch: typeof fetch = globalThis.fetch) {}

  isConfigured(): boolean {
    return true;
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    const url = new URL('https://www.mojeek.com/search');
    url.searchParams.set('q', query);
    if (opts.offset) url.searchParams.set('s', String(opts.offset));

    const res = await this.doFetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': BROWSER_UA,
      },
      signal: opts.signal,
    });

    if (!res.ok) throw new SearchBackendError(`Mojeek returned HTTP ${res.status}`, res.status);

    const html = await res.text();
    const blocked = detectBlockPage(html);
    if (blocked) throw new SearchBackendError(`Mojeek served a ${blocked} instead of results.`);

    return parseMojeekHtml(html);
  }
}

/**
 * Tries each backend in turn and returns the first that answers with results.
 *
 * Keyless engines rate-limit, and one that is throttling right now should not end a
 * harvest when another is willing to answer. Only when every backend fails does the
 * error surface, and it names each failure rather than reporting an empty market.
 */
export class FallbackBackend implements SearchBackend {
  readonly id = 'fallback';
  readonly displayName: string;
  readonly setupHint = 'Nothing to set up — this works out of the box.';

  constructor(private backends: SearchBackend[]) {
    this.displayName = backends.map((b) => b.displayName).join(' -> ');
  }

  isConfigured(): boolean {
    return this.backends.some((b) => b.isConfigured());
  }

  async search(query: string, opts: SearchBackendOptions = {}): Promise<SearchResult[]> {
    const failures: string[] = [];

    for (const backend of this.backends) {
      if (!backend.isConfigured()) continue;
      try {
        const results = await backend.search(query, opts);
        if (results.length > 0) return results;
        // Zero results is a legitimate answer for a narrow query, so remember it and
        // try the next engine rather than treating it as success or as failure.
        failures.push(`${backend.displayName}: no results`);
      } catch (err) {
        failures.push(`${backend.displayName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failures.length === this.backends.length && failures.every((f) => !f.endsWith('no results'))) {
      throw new SearchBackendError(`Every search backend failed.\n  ${failures.join('\n  ')}`);
    }
    return [];
  }
}

/** A current, ordinary desktop browser string. Not a disguise: this IS a browser request
 * for a page meant to be read by browsers, and sending a blank or scripted-looking agent
 * gets a challenge page rather than the results the same person would see by hand. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

/**
 * Brave Search API. The default recommendation: it has a free tier, it indexes Zillow
 * deeply, and it returns the raw meta description in `description` rather than a
 * re-written summary.
 */
export class BraveBackend implements SearchBackend {
  readonly id = 'brave';
  readonly displayName = 'Brave Search API';
  readonly setupHint = 'Set BRAVE_SEARCH_API_KEY (free tier at brave.com/search/api).';

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
    'Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX (console.cloud.google.com + programmablesearchengine.google.com). ' +
    'The engine must have "Search the entire web" enabled.';

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
  return [
    // Keyed backends first when the user configured one: they are faster, higher-limit
    // and not subject to scraping etiquette. But nothing REQUIRES one.
    new BraveBackend(),
    new GoogleCseBackend(),
    new SearxngBackend(),
    // The fallback that always works, with nothing to configure. Last in the list but
    // first in practice, because the keyed ones report themselves unconfigured.
    new FallbackBackend([new DuckDuckGoBackend(), new MojeekBackend()]),
  ];
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
  return configured
    ? { backend: configured, hints: [] }
    : { backend: null, hints: available.map((b) => `${b.displayName}: ${b.setupHint}`) };
}

/** Search APIs return titles with <strong> around the matched terms. */
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
