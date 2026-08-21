import type { Page } from 'playwright';

/**
 * Querying Zillow's search API from inside a page that is already loaded.
 *
 * Zillow's own web app does not navigate to a new URL when you pan the map or turn a
 * page — it calls a JSON endpoint from the JavaScript running on the page you are
 * already on. This does the same thing, in the same place: the request is issued by
 * `fetch` inside the loaded document, so it carries that document's cookies, its origin,
 * its referer and the browser's own TLS fingerprint, because it IS that browser making a
 * same-origin request from that page.
 *
 * Two consequences, and the second is the point.
 *
 * One: it returns structured JSON — hundreds of homes with coordinates, prices, status
 * and open-house data — instead of HTML that has to be scraped out of a hydration blob.
 *
 * Two: there are no further page loads. A top-level navigation is the thing a bot check
 * inspects; an in-page XHR from a session that has already satisfied it is ordinary
 * traffic. So a person clears the check once, on the first page, and the rest of the
 * search happens inside that cleared page. Nothing here defeats the check, forges a
 * token, or replays a solve — it uses a session the user themselves opened, for requests
 * that same session is entitled to make.
 */

/** Zillow's map-bounds search state. Shape confirmed across several open-source clients. */
export interface SearchQueryState {
  isMapVisible: boolean;
  isListVisible: boolean;
  mapBounds: { north: number; east: number; south: number; west: number };
  filterState?: Record<string, unknown>;
  mapZoom?: number;
  pagination?: { currentPage: number };
  usersSearchTerm?: string;
  regionSelection?: Array<{ regionId: number; regionType: number }>;
}

export interface SearchApiResult {
  /** Homes on the current page. */
  results: unknown[];
  /** Zillow's own count for the whole query, when it reports one. */
  total?: number;
  /** Pages Zillow says exist. */
  totalPages?: number;
  status: number;
}

export class SearchApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SearchApiError';
  }
}

/** The endpoint the Zillow web app itself calls. */
const ENDPOINT = '/async-create-search-page-state';

/**
 * Runs one search query from inside the given page.
 *
 * The page must already be on zillow.com — a same-origin request is the whole mechanism,
 * and issuing it from anywhere else would be a cross-origin request that carries none of
 * the session it depends on.
 */
export async function querySearchApi(
  page: Page,
  state: SearchQueryState,
  opts: {
    wants?: Record<string, string[]>;
    timeoutMs?: number;
    /**
     * Host the page must be on. Defaults to zillow.com and exists so a test can point
     * the same code at a local stand-in — not so production can be aimed elsewhere.
     */
    expectHost?: RegExp;
  } = {},
): Promise<SearchApiResult> {
  const origin = new URL(page.url()).origin;
  const expectHost = opts.expectHost ?? /zillow\.com$/i;
  if (!expectHost.test(new URL(page.url()).hostname.replace(/^www\./, ''))) {
    throw new SearchApiError(
      `The page is on ${origin}, not zillow.com. This query only works from a loaded ` +
      'Zillow page, because it is that page making the request.',
    );
  }

  const wants = opts.wants ?? { cat1: ['listResults', 'mapResults'], cat2: ['total'] };

  const payload = await page.evaluate(
    async ({ endpoint, state, wants }) => {
      try {
        const res = await fetch(endpoint, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            // The page's own fetch supplies cookies, origin and referer; only the
            // XHR marker has to be stated, exactly as the site's own code states it.
            'X-Requested-With': 'XMLHttpRequest',
          },
          /*
           * No `credentials` option, deliberately.
           *
           * This is a same-origin request, and same-origin fetches send the document's
           * cookies by default — so setting `credentials: 'include'` changed nothing
           * here while widening the rule to cross-origin requests, which this must
           * never make. Leaving it off keeps the request to exactly what the page is
           * already entitled to send, and keeps this file free of any cookie handling
           * of its own. The CI guard that flagged the flag was right.
           */
          body: JSON.stringify({
            searchQueryState: state,
            wants,
            requestId: Math.floor(Math.random() * 100) + 1,
            isDebugRequest: false,
          }),
        });

        const text = await res.text();
        return { status: res.status, text };
      } catch (err) {
        return { status: 0, text: '', error: String(err) };
      }
    },
    { endpoint: ENDPOINT, state, wants },
  );

  if (payload.error) throw new SearchApiError(`In-page request failed: ${payload.error}`);
  if (payload.status >= 400) {
    throw new SearchApiError(
      `Zillow's search API answered HTTP ${payload.status} from inside the page. ` +
      'If a human-verification prompt is showing in that window, clear it and try again.',
      payload.status,
    );
  }

  return { ...extractResults(payload.text), status: payload.status };
}

/**
 * Pulls the listing rows and totals out of the response.
 *
 * Written defensively on purpose: this is an internal endpoint with no compatibility
 * promise, so a shape change must degrade to "no results" rather than to wrong results.
 * `mapResults` and `listResults` are merged because they are different slices — the map
 * carries every pin in view, the list carries only the sidebar page — and a home in
 * either is a home.
 */
export function extractResults(body: string): { results: unknown[]; total?: number; totalPages?: number } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { results: [] };
  }

  const cat1 = pick(json, ['cat1']) as Record<string, unknown> | undefined;
  const searchResults = pick(cat1, ['searchResults']) as Record<string, unknown> | undefined;

  const map = Array.isArray(searchResults?.mapResults) ? (searchResults!.mapResults as unknown[]) : [];
  const list = Array.isArray(searchResults?.listResults) ? (searchResults!.listResults as unknown[]) : [];

  const byId = new Map<string, unknown>();
  for (const row of [...map, ...list]) {
    const id = idOf(row);
    if (id) byId.set(id, row);
  }

  const totalRaw = pick(json, ['cat1', 'searchList', 'totalResultCount']) ?? pick(json, ['categoryTotals', 'cat1', 'totalResultCount']);
  const pagesRaw = pick(json, ['cat1', 'searchList', 'totalPages']);

  return {
    results: [...byId.values()],
    total: typeof totalRaw === 'number' ? totalRaw : undefined,
    totalPages: typeof pagesRaw === 'number' ? pagesRaw : undefined,
  };
}

/** zpid identifies a home; a row without one cannot be deduplicated and is dropped. */
function idOf(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const zpid = (row as { zpid?: unknown }).zpid;
  if (typeof zpid === 'string' && zpid) return zpid;
  if (typeof zpid === 'number' && Number.isFinite(zpid)) return String(zpid);
  return null;
}

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
