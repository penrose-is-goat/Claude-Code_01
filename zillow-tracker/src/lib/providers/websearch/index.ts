import type { NormalizedListing } from '../normalized';
import type {
  AreaQuery, FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import { resolveBackend, type SearchBackend } from './backends';
import { sweep, type SweepReport, type SweepTarget } from './sweep';

/**
 * Reads listings out of the public web-search index.
 *
 * Zillow publishes a crawler-facing summary of every home it lists — address, price,
 * beds, baths, square footage, home type, year built — because it wants those pages
 * found. This provider reads that published summary through an ordinary search API. It
 * never requests a page from zillow.com, holds no account, and sends no cookie: the only
 * host it contacts is the search backend the user configured.
 *
 * That makes it the provider that actually works. The direct `zillow` provider has been
 * refused with an HTTP 403 from a residential IP, so a search index — which Zillow
 * deliberately feeds — is not a workaround, it is the supported public interface.
 *
 * What it cannot do is as important as what it can. Search results carry no coordinates
 * and no open-house times, so this provider reports neither rather than approximating
 * them. Open-house windows come from the `snapshot` provider, which captures the pages
 * that do pair a time to an address.
 */
export class WebSearchProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'websearch' as const;
  readonly displayName = 'Public web search (Zillow indexed pages)';
  readonly capabilities: ProviderCapabilities = {
    // A search snippet states the facts of the home, never its open-house schedule.
    supportsOpenHouses: false,
    // Search backends take words, not geometry. A drawn shape needs a place name.
    supportsPolygonQuery: false,
    supportsRadiusQuery: true,
    supportsPhotos: false,
    supportsPriceHistory: false,
    /*
     * Pacing.
     *
     * The default backend is a keyless engine's own results page, requested the way a
     * browser requests it. Two and a half seconds between queries is slower than a
     * person clicking through pages, which is the point: the failure mode of going
     * faster is a challenge page, and a challenge page parses to zero results and reads
     * as an empty housing market. Set SEARCH_MIN_INTERVAL_MS lower only with a keyed
     * backend, where the quota is the limit rather than etiquette.
     */
    rateLimit: {
      requestsPerRun: Number(process.env.SEARCH_QUERY_BUDGET ?? 40),
      minIntervalMs: Number(process.env.SEARCH_MIN_INTERVAL_MS ?? 2500),
    },
  };

  /** The most recent sweep, so the UI can show coverage against Zillow's own count. */
  lastReport: SweepReport | null = null;

  constructor(private backend: SearchBackend | null = resolveBackend().backend) {}

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.backend) {
      const { hints } = resolveBackend();
      return {
        ok: false,
        message: 'No search backend available. ' + hints.join(' '),
      };
    }
    return {
      ok: true,
      message: `${this.backend.displayName} configured (budget ${this.capabilities.rateLimit!.requestsPerRun} queries/run).`,
    };
  }

  async fetchPage(opts: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    if (!this.backend) {
      const { hints } = resolveBackend();
      throw new Error(`No search backend configured. ${hints.join(' ')}`);
    }

    const target = toSweepTarget(opts.area, opts.placeHint);

    const report = await sweep(this.backend, target, {
      queryBudget: this.capabilities.rateLimit!.requestsPerRun,
      minIntervalMs: this.capabilities.rateLimit!.minIntervalMs,
      openHouseOnly: opts.filters?.openHouseOnly,
      signal: opts.signal,
    });
    this.lastReport = report;

    // Filters are applied after the sweep rather than folded into the queries: a search
    // backend has no price operator, so narrowing has to happen on parsed facts.
    const raw = applyFilters(report.listings, opts);

    // Every query the sweep intended to run has run, or the budget stopped it. Either
    // way there is no further page to ask for — `coverage` in the report, not a cursor,
    // is what tells the caller whether the market was fully covered.
    return { raw, requestsUsed: report.queriesSpent };
  }

  normalize(raw: NormalizedListing): NormalizedListing {
    return raw;
  }
}

/**
 * A search backend needs a place name. `cityRadius` has one; a drawn shape does not,
 * which is why `SearchLocation.drawn` carries an optional label and the failure message
 * below asks for it explicitly instead of silently returning nothing.
 */
export function toSweepTarget(area: AreaQuery, placeHint?: string): SweepTarget {
  if (area.kind === 'cityRadius' && area.city) {
    return { city: area.city, state: area.state };
  }

  const hint = placeHint?.trim();
  if (hint) {
    // "Boulder, CO" / "Boulder CO" / "Boulder"
    const m = hint.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
    if (m) return { city: m[1].trim(), state: m[2].toUpperCase() };
    return { city: hint, state: '' };
  }

  throw new Error(
    area.kind === 'cityRadius'
      ? 'The place could not be resolved to a city name, so there is nothing to search for.'
      : 'A drawn shape has no place name. Web search needs one — name the area when you draw it, ' +
        'or search by place and radius instead.',
  );
}

function applyFilters(listings: NormalizedListing[], opts: FetchOptions): NormalizedListing[] {
  const f = opts.filters;
  if (!f) return listings;

  return listings.filter((l) => {
    // A listing whose price the index did not publish is kept when a bound is set:
    // dropping it would silently hide homes for the sin of a terse snippet.
    if (f.minPrice != null && l.listPrice != null && l.listPrice < f.minPrice) return false;
    if (f.maxPrice != null && l.listPrice != null && l.listPrice > f.maxPrice) return false;
    if (f.minBeds != null && l.beds != null && l.beds < f.minBeds) return false;
    if (f.minBaths != null && l.bathsTotal != null && l.bathsTotal < f.minBaths) return false;
    if (f.propertyTypes?.length && !f.propertyTypes.includes(l.propertyType)) return false;
    return true;
  });
}
