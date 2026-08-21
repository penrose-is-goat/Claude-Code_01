/**
 * Harvest current Zillow listings from the public search index.
 *
 *   npm run harvest -- --place "Boulder, CO"
 *   npm run harvest -- --place "Boulder, CO" --budget 60 --open-houses
 *   npm run harvest -- --place "Boulder, CO" --from captures/boulder-raw.json
 *
 * This is the repeatable refresh. It runs the same sweep the app runs, writes the result
 * to `snapshots/` with full provenance, and prints how the harvest compares to the
 * count Zillow itself publishes for that market.
 *
 * `--from` replays raw search results captured elsewhere through the identical parser.
 * That exists because the environment this project is developed in blocks outbound
 * HTTPS to search APIs, while the search tooling available to the developer is not
 * blocked — so a real harvest can still be performed and then fed in. It is a transport
 * for real results, not a fixture: the capture file records what was searched and when,
 * and the provenance written into the snapshot says the data arrived this way.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedListing } from '../src/lib/providers/normalized';
import { CapturedBackend, resolveBackend, type SearchBackend } from '../src/lib/providers/websearch/backends';
import type { SearchResult } from '../src/lib/providers/websearch/parse';
import { sweep, streetOf, type SweepReport } from '../src/lib/providers/websearch/sweep';
import { RentCastAddressIndex } from '../src/lib/address-index';

interface CaptureFile {
  /** How and when these results were obtained. Copied into the snapshot's provenance. */
  capturedAt: string;
  method: string;
  /** One entry per query actually run. */
  queries: Array<{ query: string; results: SearchResult[] }>;
  /**
   * Facts that the search response stated but that did not arrive as a raw meta
   * description — e.g. a tool that answers in prose rather than returning the snippet
   * verbatim.
   *
   * These are kept OUT of `results[].description` on purpose. Writing them into a
   * synthetic description would launder a paraphrase into something indistinguishable
   * from a capture; keeping them here means every merged field is attributable, carries
   * its own `note`, and is listed in the snapshot's provenance as separately observed.
   * A field absent here stays null. Nothing is inferred from a neighbouring listing.
   */
  observations?: Observation[];
}

interface Observation {
  /** The listing URL these facts belong to. Matched exactly. */
  url: string;
  /** How this was observed. Written into the snapshot provenance verbatim. */
  note: string;
  listPrice?: number;
  beds?: number;
  bathsTotal?: number;
  livingAreaSqft?: number;
  yearBuilt?: number;
  propertyType?: NormalizedListing['propertyType'];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const place = args.place;
  if (!place) {
    console.error(
      'Usage: npm run harvest -- --place "City, ST" [--budget N] [--open-houses]\n' +
      '                          [--address-index] [--radius MILES] [--from file.json]',
    );
    process.exit(2);
  }

  const m = place.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  if (!m) {
    console.error(`Could not read a city and state from "${place}". Use the form "City, ST".`);
    process.exit(2);
  }
  const target = { city: m[1].trim(), state: m[2].toUpperCase() };

  let backend: SearchBackend;
  let method: string;
  let observations: Observation[] = [];
  let replayQueries: string[] = [];

  if (args.from) {
    const capture = JSON.parse(await readFile(args.from, 'utf8')) as CaptureFile;
    observations = capture.observations ?? [];
    const table = new Map(capture.queries.map((q) => [q.query, q.results]));
    backend = new CapturedBackend(table);
    replayQueries = capture.queries.map((q) => q.query);
    method = `${capture.method} (captured ${capture.capturedAt}, ${capture.queries.length} queries)`;
    console.log(`Replaying ${capture.queries.length} captured queries through the live parser.\n`);
    // A replay must ask the questions that were actually asked. With no explicit budget
    // it asks exactly those and stops: letting the planner's own phases run against a
    // capture only spends budget on queries the capture cannot answer, and reports
    // "40 of 40 spent" for a 7-query file.
    if (!args.budgetExplicit) args.budget = replayQueries.length;
    else if (args.budget < replayQueries.length) args.budget = replayQueries.length;
  } else {
    const resolved = resolveBackend();
    if (!resolved.backend) {
      console.error('No search backend is configured. Set one of:\n');
      for (const hint of resolved.hints) console.error(`  • ${hint}`);
      console.error('\nOr replay a capture with --from <file.json>.');
      process.exit(1);
    }
    backend = resolved.backend;
    method = `live ${resolved.backend.displayName}`;
    console.log(`Sweeping ${target.city}, ${target.state} via ${resolved.backend.displayName}.\n`);
  }

  // Optional: ask an address index for the streets in this area, so the Zillow sweep
  // starts from the full list instead of discovering it a few results at a time. The
  // index supplies STREET NAMES ONLY — every fact in the harvest still comes from the
  // Zillow page a search returns.
  let seedStreets: string[] = [];
  if (args.addressIndex) {
    const index = new RentCastAddressIndex();
    if (!index.isConfigured()) {
      console.error(`${index.displayName} is not configured. ${index.setupHint}\n`);
      process.exit(1);
    }
    process.stdout.write(`Asking ${index.displayName} for streets in ${target.city}, ${target.state}... `);
    const { seeds, requestsUsed, truncated } = await index.addresses({
      kind: 'cityRadius', city: target.city, state: target.state, radiusMiles: args.radius,
    });
    const streets = new Set<string>();
    for (const seed of seeds) {
      const street = streetOf(seed.addressLine1);
      if (street) streets.add(street);
    }
    seedStreets = [...streets];
    console.log(`${seeds.length} addresses on ${seedStreets.length} streets (${requestsUsed} request(s)).`);
    if (truncated.length > 0) {
      console.log(`  ${truncated.length} sub-area(s) came back at the cap and are incompletely indexed.`);
    }
    console.log();
  }

  const report = await sweep(backend, target, {
    seedStreets,
    queryBudget: args.budget,
    // A replay has no rate limit to respect; a live backend does.
    minIntervalMs: args.from ? 0 : 1100,
    openHouseOnly: args.openHouses,
    extraQueries: replayQueries,
    onProgress: (p) => {
      process.stdout.write(
        `\r  query ${p.queriesSpent}/${p.queryBudget} — ${p.listingsFound} listings so far`.padEnd(78),
      );
    },
  });
  process.stdout.write('\n\n');

  const merged = mergeObservations(report.listings, observations);
  if (merged.applied > 0) {
    console.log(
      `Merged ${merged.applied} separately-observed fact set(s) into ${merged.matched} listing(s).`,
    );
  }
  if (merged.unmatched.length > 0) {
    console.log(`${merged.unmatched.length} observation(s) matched no harvested listing:`);
    for (const u of merged.unmatched.slice(0, 5)) console.log(`  ${u}`);
  }

  printReport(report, target);

  const outDir = args.out ?? join(process.cwd(), 'snapshots');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = `${target.city.toLowerCase().replace(/\s+/g, '-')}-${target.state.toLowerCase()}`;
  const file = join(outDir, `${slug}-websearch-${stamp}.json`);

  await writeFile(file, JSON.stringify(toSnapshot(report, target, method, observations), null, 2) + '\n');
  console.log(`\nWrote ${report.listings.length} listings to ${file}`);

  // A harvest that found nothing is a failure, not an empty market. Exit non-zero so a
  // scheduled refresh surfaces it instead of silently overwriting good data with none.
  if (report.listings.length === 0) {
    console.error('\nNo listings were harvested. Nothing was overwritten in the database.');
    process.exit(1);
  }
}

/**
 * Applies separately-observed facts to the listings they belong to.
 *
 * Only fills fields the sweep left undefined — a fact parsed from the indexed snippet
 * always wins over one relayed second-hand, so a live backend's data is never
 * overwritten by a capture's paraphrase.
 */
function mergeObservations(
  listings: NormalizedListing[],
  observations: Observation[],
): { applied: number; matched: number; unmatched: string[] } {
  const byUrl = new Map(listings.map((l) => [l.listingUrl ?? '', l]));
  const unmatched: string[] = [];
  const matchedListings = new Set<NormalizedListing>();
  let applied = 0;

  for (const obs of observations) {
    const listing = byUrl.get(obs.url);
    if (!listing) {
      unmatched.push(obs.url);
      continue;
    }

    let touched = false;
    for (const key of ['listPrice', 'beds', 'bathsTotal', 'livingAreaSqft', 'yearBuilt'] as const) {
      const value = obs[key];
      if (value != null && listing[key] == null) {
        listing[key] = value;
        touched = true;
      }
    }
    if (obs.propertyType && listing.propertyType === 'OTHER') {
      listing.propertyType = obs.propertyType;
      touched = true;
    }

    if (touched) {
      applied++;
      matchedListings.add(listing);
      const raw = listing.raw as Record<string, unknown> | undefined;
      if (raw) raw.observation = obs.note;
    }
  }

  return { applied, matched: matchedListings.size, unmatched };
}

function printReport(report: SweepReport, target: { city: string; state: string }): void {
  console.log(`Queries spent : ${report.queriesSpent} of ${report.queryBudget}`);
  console.log(`Listings found: ${report.listings.length}`);

  if (report.coverage) {
    const { found, published, ratio, scope } = report.coverage;
    console.log(
      `Coverage      : ${found} of ${published} that Zillow publishes for "${scope}" ` +
      `(${(ratio * 100).toFixed(1)}%)`,
    );
    if (ratio < 0.9) {
      console.log(
        '                Raise --budget to close the gap; the sweep stops when the budget runs out.',
      );
    }
  } else {
    console.log(
      `Coverage      : unknown — no Zillow index page for ${target.city} stated a total, so there ` +
      'is no denominator to check this harvest against.',
    );
  }

  if (report.published.length > 0) {
    console.log('\nWhat Zillow publishes for this market:');
    for (const p of dedupePublished(report.published)) {
      console.log(`  ${String(p.count).padStart(6)}  ${p.scopeLabel}`);
    }
  }

  const drops = Object.entries(report.dropped).sort((a, b) => b[1] - a[1]);
  if (drops.length > 0) {
    console.log('\nResults seen but not kept:');
    for (const [reason, n] of drops) console.log(`  ${String(n).padStart(6)}  ${reason}`);
  }

  const failed = report.queries.filter((q) => q.error);
  if (failed.length > 0) {
    console.log(`\n${failed.length} quer${failed.length === 1 ? 'y' : 'ies'} failed:`);
    for (const q of failed.slice(0, 5)) console.log(`  ${q.query}\n    ${q.error}`);
  }
}

function dedupePublished(published: SweepReport['published']) {
  const byScope = new Map<string, (typeof published)[number]>();
  for (const p of published) {
    if (p.count == null) continue;
    const existing = byScope.get(p.scopeLabel);
    if (!existing || (p.count ?? 0) > (existing.count ?? 0)) byScope.set(p.scopeLabel, p);
  }
  return [...byScope.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
}

/**
 * Writes the `snapshots/` format so the existing SnapshotProvider can serve this
 * harvest, with the gaps recorded honestly rather than left for someone to discover.
 */
function toSnapshot(
  report: SweepReport,
  target: { city: string; state: string },
  method: string,
  observations: Observation[] = [],
) {
  const knownGaps = [
    'Coordinates: search results carry none, so every listing has null lat/lng and is placed by address.',
    'Open-house times: not published in a search snippet. Captured separately from Zillow open-house pages.',
    'Photos and descriptions: intentionally not stored.',
  ];

  if (report.coverage && report.coverage.ratio < 0.99) {
    knownGaps.push(
      `Coverage: ${report.coverage.found} of the ${report.coverage.published} homes Zillow publishes ` +
      `for "${report.coverage.scope}". This capture is a subset of the market, not all of it.`,
    );
  } else if (!report.coverage) {
    knownGaps.push('Coverage: no published total was found, so completeness is unverified.');
  }

  for (const note of new Set(observations.map((o) => o.note))) {
    knownGaps.push(`Separately observed: ${note}`);
  }

  return {
    provenance: {
      capturedAt: new Date().toISOString(),
      method: `Public web search index (${method}); parsed from Zillow's crawler-facing title and meta description.`,
      sources: dedupePublished(report.published).map((p) => p.url),
      knownGaps,
      marketContext: {
        place: `${target.city}, ${target.state}`,
        queriesSpent: report.queriesSpent,
        queryBudget: report.queryBudget,
        publishedCounts: dedupePublished(report.published).map((p) => ({
          scope: p.scopeLabel, count: p.count, url: p.url,
        })),
        coverage: report.coverage,
        droppedResults: report.dropped,
      },
    },
    listings: report.listings.map(toSnapshotRow),
  };
}

function toSnapshotRow(l: NormalizedListing) {
  return {
    sourceListingId: l.sourceListingId,
    addressLine1: l.addressLine1,
    city: l.city,
    state: l.state,
    postalCode: l.postalCode,
    listPrice: l.listPrice ?? null,
    beds: l.beds ?? null,
    bathsTotal: l.bathsTotal ?? null,
    livingAreaSqft: l.livingAreaSqft ?? null,
    propertyType: l.propertyType,
    // Explicitly null, not omitted: the source did not publish these.
    lat: null,
    lng: null,
    yearBuilt: l.yearBuilt ?? null,
    listingUrl: l.listingUrl ?? null,
  };
}

interface Args {
  place?: string;
  addressIndex: boolean;
  radius: number;
  budget: number;
  /** Distinguishes an explicit --budget from the default, which replay overrides. */
  budgetExplicit: boolean;
  openHouses: boolean;
  from?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    addressIndex: false,
    radius: 10,
    budget: Number(process.env.SEARCH_QUERY_BUDGET ?? 40),
    budgetExplicit: false,
    openHouses: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--place') args.place = argv[++i];
    else if (a === '--budget') { args.budget = Number(argv[++i]); args.budgetExplicit = true; }
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--open-houses') args.openHouses = true;
    else if (a === '--address-index') args.addressIndex = true;
    else if (a === '--radius') args.radius = Number(argv[++i]);
  }
  if (!Number.isFinite(args.budget) || args.budget <= 0) args.budget = 40;
  return args;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
