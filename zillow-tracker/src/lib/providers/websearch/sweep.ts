import type { NormalizedListing } from '../normalized';
import type { SearchBackend, SearchBackendOptions } from './backends';
import {
  parseHomedetailsUrl, parseIndexPage, toListing,
  type IndexPageFacts, type SearchResult,
} from './parse';

/**
 * Enumerating a market from the public search index.
 *
 * The problem: a search backend returns ten or twenty results per query, and a city has
 * hundreds of listings. Asking "homes for sale in Boulder" once and reporting what comes
 * back is how you end up claiming a city of 774 listings has 28.
 *
 * The fix is to partition the market into slices small enough that one query can return
 * a whole slice, and to run one query per slice. Three axes do that here, in order of
 * how much they pay for what they cost:
 *
 *  1. AREA — Zillow publishes its own subdivision of every city (ZIPs, and named
 *     neighborhoods like `central-boulder-boulder-co`) as indexed pages whose titles
 *     state how many homes each contains. Those pages are both the partition and the
 *     denominator to check the harvest against.
 *
 *  2. FACET — bed count and home type are exact tokens in every indexed description
 *     ("3 beds", "condo home"), so they partition cleanly and cheaply.
 *
 *  3. STREET — the user's own observation: type an address into a search engine and its
 *     Zillow page comes up. A city has a finite list of streets, every address contains
 *     exactly one, and a street is usually small enough to fit in a single page of
 *     results. Street names do not need to be known in advance: each harvested address
 *     yields one, so the sweep discovers its own frontier and converges on the streets
 *     that actually have listings.
 *
 * Slices overlap, which is fine and in fact wanted — overlap is the evidence that a
 * slice was fully covered. Deduplication is by zpid, which is exact.
 */

export interface SweepTarget {
  /** "Boulder", as the user typed it. */
  city: string;
  /** Two-letter state code. */
  state: string;
  /**
   * Postal codes are never asked of the user — the product takes a place or a drawn
   * shape. These arrive from the geocoder or from Zillow's own indexed area pages, and
   * exist only as query-partitioning detail inside this file.
   */
  postalCodes?: string[];
  /** Zillow area slugs discovered in phase 1, e.g. `central-boulder-boulder-co`. */
  areaSlugs?: string[];
}

export interface SweepOptions {
  /** Hard ceiling on queries spent. The single most important knob: search APIs meter. */
  queryBudget?: number;
  /** Milliseconds between queries. Free tiers are usually 1 query/second. */
  minIntervalMs?: number;
  /** Only homes with an upcoming open house. */
  openHouseOnly?: boolean;
  now?: () => Date;
  signal?: AbortSignal;
  /** Called after each query so a long sweep can report progress. */
  onProgress?: (progress: SweepProgress) => void;
  /**
   * Queries to run before the planned phases, spending from the same budget.
   *
   * Two uses: pinning a query the planner would not have thought of, and replaying a
   * capture exactly — a captured harvest is a set of specific query strings, and
   * replaying it has to ask those strings rather than whatever the planner would
   * generate today.
   */
  extraQueries?: string[];
  /**
   * Streets to sweep, known up front instead of discovered.
   *
   * Phase 3 normally learns streets from whatever addresses earlier phases happened to
   * surface, which means coverage depends on luck: a street with no home in the first
   * few result pages is never queried. An address index (see lib/address-index) can hand
   * over the complete street list for an area in one request, turning the frontier from
   * a guess into a checklist.
   *
   * These are only ever STREET NAMES used to build Zillow queries. No price, status or
   * property fact from another source enters the harvest — every displayed fact still
   * comes from the Zillow page the search returns.
   */
  seedStreets?: string[];
}

export interface SweepProgress {
  queriesSpent: number;
  queryBudget: number;
  listingsFound: number;
  lastQuery: string;
}

export interface SweepReport {
  listings: NormalizedListing[];
  queriesSpent: number;
  queryBudget: number;
  /** Every query run, with what it returned. The audit trail for a harvest. */
  queries: Array<{ query: string; results: number; newListings: number; error?: string }>;
  /** Zillow's own published counts for the area, when index pages were found. */
  published: IndexPageFacts[];
  /** Results seen and rejected, by reason. Sums to (results seen - listings kept). */
  dropped: Record<string, number>;
  /**
   * Found vs. what Zillow publishes. Undefined when no index page stated a count —
   * in which case the harvest reports its size and explicitly says the denominator is
   * unknown, rather than implying completeness.
   */
  coverage?: { found: number; published: number; ratio: number; scope: string };
}

const DEFAULT_BUDGET = Number(process.env.SEARCH_QUERY_BUDGET ?? 40);

/**
 * Phase 1: ask what Zillow itself says exists.
 *
 * These queries hit index pages rather than homes, so they yield no listings. They earn
 * their budget by returning the denominator and the neighborhood slugs that make the
 * rest of the sweep partition properly.
 */
export function planDiscoveryQueries(t: SweepTarget): string[] {
  const place = `${t.city}, ${t.state}`;
  return [
    `Zillow ${place} homes for sale`,
    `Zillow ${place} open houses`,
    `Zillow ${place} neighborhoods homes for sale`,
  ];
}

/** Phase 2: area x facet slices. */
export function planFacetQueries(t: SweepTarget, opts: { openHouseOnly?: boolean } = {}): string[] {
  const place = `${t.city}, ${t.state}`;
  const areas = [
    ...(t.postalCodes ?? []).map((z) => `"${t.city}, ${t.state} ${z}"`),
    ...(t.areaSlugs ?? []).map((s) => `"${slugToLabel(s)}"`),
  ];
  // With no discovered subdivision the city itself is the only area slice available.
  const areaTerms = areas.length > 0 ? areas : [`"${place}"`];

  const queries: string[] = [];

  if (opts.openHouseOnly) {
    for (const area of areaTerms) {
      queries.push(`site:zillow.com/homedetails ${area} open house`);
    }
    return queries;
  }

  const bedFacets = ['2 beds', '3 beds', '4 beds', '5 beds'];
  const typeFacets = ['single family home', 'condo home', 'townhouse'];

  for (const area of areaTerms) {
    for (const beds of bedFacets) queries.push(`site:zillow.com/homedetails ${area} "${beds}"`);
    for (const type of typeFacets) queries.push(`site:zillow.com/homedetails ${area} "${type}"`);
  }

  return queries;
}

/**
 * The query that asks Zillow's index what an area is made of.
 *
 * The answer comes back as index pages — neighborhoods, ZIPs — each with its own count
 * in its title, which is what makes the next split decision.
 */
export function planSubAreaQuery(label: string, openHouseOnly = false): string {
  return `Zillow "${label}" ${openHouseOnly ? 'open houses' : 'homes for sale neighborhoods'}`;
}

/**
 * Phase 3: one query per street already known to have listings.
 *
 * This is the address-shaped query the user described, generalized: rather than needing
 * the full address up front, it asks the index for every Zillow home page on a street
 * that a previous slice already proved exists.
 */
export function planStreetQueries(t: SweepTarget, streets: string[]): string[] {
  const place = `${t.city}, ${t.state}`;
  return streets.map((s) => `site:zillow.com/homedetails "${s}" "${place}"`);
}

/**
 * The street portion of an address: "1655 Walnut St UNIT 106" -> "Walnut St".
 *
 * Returns null rather than guessing when the address has no recognizable street type —
 * a bad street token would spend a query on nothing.
 */
export function streetOf(addressLine1: string): string | null {
  const cleaned = addressLine1
    .replace(/\b(?:apt|unit|ste|suite|#)\s*[\w-]+$/i, '')
    .replace(/\s*#\s*[\w-]+$/i, '')
    .trim();

  // Greedy, so the LAST street-type word wins. Lazy matching stopped at the first one
  // and turned "718 Emerson Gulch Road" into "Emerson Gulch" — a different street, and
  // a wasted query.
  const m = cleaned.match(
    /^\d+[A-Za-z]?\s+(.*\b(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Blvd|Boulevard|Pl|Place|Ter|Terrace|Way|Trl|Trail|Pkwy|Parkway|Hwy|Highway|Loop|Run|Row|Path|Ridge|Gulch|Canyon|Mesa|Vista))\b/i,
  );
  if (!m) return null;

  const street = m[1].trim();
  return street.length >= 3 ? street : null;
}

/** `central-boulder-boulder-co` -> `Central Boulder Boulder`. */
export function slugToLabel(slug: string): string {
  return slug
    .replace(/-[a-z]{2}$/i, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Runs the three phases against a backend until the market is covered or the budget is
 * spent, whichever comes first.
 *
 * A spent budget is reported, never hidden: the report says how many queries were used
 * and how the harvest compares to Zillow's published count, so a partial sweep reads as
 * a partial sweep.
 */
export async function sweep(
  backend: SearchBackend,
  target: SweepTarget,
  opts: SweepOptions = {},
): Promise<SweepReport> {
  const queryBudget = opts.queryBudget ?? DEFAULT_BUDGET;
  const fetchedAt = opts.now?.() ?? new Date();
  const minIntervalMs = opts.minIntervalMs ?? 1100;

  const byZpid = new Map<string, NormalizedListing>();
  const queries: SweepReport['queries'] = [];
  const published: IndexPageFacts[] = [];
  const dropped: Record<string, number> = {};
  const seenQueries = new Set<string>();
  const streetsSeen = new Set<string>();
  const streetsQueried = new Set<string>();

  let spent = 0;

  const run = async (query: string): Promise<void> => {
    if (spent >= queryBudget || seenQueries.has(query)) return;
    seenQueries.add(query);

    if (spent > 0 && minIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, minIntervalMs));
    }

    spent++;
    let results: SearchResult[] = [];
    try {
      results = await backend.search(query, { count: 20, signal: opts.signal } as SearchBackendOptions);
    } catch (err) {
      queries.push({
        query, results: 0, newListings: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let added = 0;
    for (const result of results) {
      // An index page is not a listing, but its title carries the published count.
      if (!parseHomedetailsUrl(result.url)) {
        const index = parseIndexPage(result);
        if (index?.count != null) published.push(index);
        if (index) recordDrop(dropped, 'index or non-home page');
        else recordDrop(dropped, 'off-site or unrecognized result');
        continue;
      }

      const { listing, dropped: rejection } = toListing(result, { fetchedAt });
      if (rejection) {
        recordDrop(dropped, rejection.reason);
        continue;
      }
      if (!listing) continue;

      const street = streetOf(listing.addressLine1);
      if (street) streetsSeen.add(street);

      if (!byZpid.has(listing.sourceListingId)) added++;
      byZpid.set(listing.sourceListingId, listing);
    }

    queries.push({ query, results: results.length, newListings: added });
    opts.onProgress?.({
      queriesSpent: spent, queryBudget, listingsFound: byZpid.size, lastQuery: query,
    });
  };

  // Seeded streets join the frontier before anything runs, so phase 3 starts with a
  // checklist rather than whatever phases 1 and 2 happened to turn up.
  for (const street of opts.seedStreets ?? []) streetsSeen.add(street);

  // Phase 0 — caller-supplied queries, if any.
  for (const q of opts.extraQueries ?? []) await run(q);

  // Phase 1 — what does Zillow say is here?
  for (const q of planDiscoveryQueries(target)) await run(q);

  // Fold discovered areas into the target so phase 2 partitions by Zillow's own
  // subdivision rather than by a guess about the city's shape.
  const discovered = mergeDiscoveredAreas(target, published);

  // Phase 2 — area x facet.
  for (const q of planFacetQueries(discovered, { openHouseOnly: opts.openHouseOnly })) await run(q);

  // Phase 3 — streets, newest discoveries first, until the budget runs out. Re-read
  // `streetsSeen` each pass because every street query can reveal more streets.
  while (spent < queryBudget) {
    const next = [...streetsSeen].filter((s) => !streetsQueried.has(s));
    if (next.length === 0) break;
    for (const street of next) {
      if (spent >= queryBudget) break;
      streetsQueried.add(street);
      await run(planStreetQueries(discovered, [street])[0]);
    }
  }

  return {
    listings: [...byZpid.values()],
    queriesSpent: spent,
    queryBudget,
    queries,
    published,
    dropped,
    coverage: computeCoverage(byZpid.size, published, opts.openHouseOnly ?? false, target),
  };
}

function recordDrop(dropped: Record<string, number>, reason: string): void {
  dropped[reason] = (dropped[reason] ?? 0) + 1;
}

function mergeDiscoveredAreas(target: SweepTarget, published: IndexPageFacts[]): SweepTarget {
  const postalCodes = new Set(target.postalCodes ?? []);
  const areaSlugs = new Set(target.areaSlugs ?? []);

  for (const page of published) {
    const slug = page.areaSlug;
    if (!slug) continue;

    // A slug ending in five digits is a ZIP page (`boulder-co-80301`, or a bare
    // `80301`). It becomes a postal code and NOT a neighborhood label — counting it as
    // both would spend two queries on one slice.
    const zip = slug.match(/(?:^|-)(\d{5})$/);
    if (zip) postalCodes.add(zip[1]);
    else if (slug.includes('-')) areaSlugs.add(slug);
  }

  return { ...target, postalCodes: [...postalCodes], areaSlugs: [...areaSlugs] };
}

/**
 * Compares the harvest to what Zillow publishes for the city being searched.
 *
 * Choosing the denominator matters more than it looks. Neighborhood counts overlap, so
 * summing them overstates the market. The largest count is usually the surrounding
 * COUNTY, which understates coverage for a city search — "21 of 1042" when the city
 * holds 406. So a page scoped to the searched city itself wins when one exists, and the
 * maximum is only the fallback. Either way the scope is reported alongside the number,
 * so the reader can see which market the percentage is against.
 */
function computeCoverage(
  found: number,
  published: IndexPageFacts[],
  openHouseOnly: boolean,
  target: SweepTarget,
): SweepReport['coverage'] {
  const wanted = openHouseOnly ? 'openHouse' : 'forSale';
  const candidates = published.filter((p) => p.kind === wanted && (p.count ?? 0) > 0);
  if (candidates.length === 0) return undefined;

  const citySlug = `${target.city.toLowerCase().replace(/\s+/g, '-')}-${target.state.toLowerCase()}`;
  const cityScoped = candidates.filter((p) => p.areaSlug === citySlug);
  const pool = cityScoped.length > 0 ? cityScoped : candidates;

  const best = pool.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a));
  const total = best.count ?? 0;

  return { found, published: total, ratio: found / total, scope: best.scopeLabel };
}
