import type { NormalizedListing } from '../normalized';
import type {
  FetchOptions, HealthCheckResult, ListingProvider, ProviderCapabilities, ProviderPage,
} from '../types';
import { RUNS } from './fixtures';

/**
 * Replays the fixture scenario. Advances one run per fetch, then holds on the last run
 * so repeated polling is idempotent (and absence counters keep incrementing, which is
 * exactly what we want to test).
 *
 * The run counter is injected rather than global so tests can drive it explicitly.
 */
export class MockProvider implements ListingProvider<NormalizedListing> {
  readonly id = 'mock' as const;
  readonly displayName = 'Mock (demo data)';
  readonly capabilities: ProviderCapabilities = {
    supportsOpenHouses: true,
    supportsPolygonQuery: true,
    supportsRadiusQuery: true,
    supportsPostalCodeQuery: true,
    supportsPhotos: true,
    supportsPriceHistory: false,
    rateLimit: null,
  };

  constructor(private runIndex = 0) {}

  /** 0-based. Values past the end clamp to the final run. */
  setRun(i: number): void {
    this.runIndex = i;
  }

  getRun(): number {
    return this.runIndex;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true, message: `Mock provider ready (run ${this.runIndex + 1}/${RUNS.length})` };
  }

  async fetchPage(opts: FetchOptions): Promise<ProviderPage<NormalizedListing>> {
    const idx = Math.min(this.runIndex, RUNS.length - 1);
    let raw = RUNS[idx]();

    // Honour the prefilter so filter behaviour is exercised in the demo too.
    const f = opts.filters;
    if (f) {
      raw = raw.filter((l) => {
        if (f.minPrice != null && (l.listPrice ?? 0) < f.minPrice) return false;
        if (f.maxPrice != null && (l.listPrice ?? Infinity) > f.maxPrice) return false;
        if (f.minBeds != null && (l.beds ?? 0) < f.minBeds) return false;
        if (f.minBaths != null && (l.bathsTotal ?? 0) < f.minBaths) return false;
        if (f.propertyTypes?.length && !f.propertyTypes.includes(l.propertyType)) return false;
        if (f.openHouseOnly && l.openHouses.length === 0) return false;
        return true;
      });
    }

    this.runIndex = Math.min(this.runIndex + 1, RUNS.length - 1);
    return { raw, requestsUsed: 0 };
  }

  /** Fixtures are already normalized; cloning keeps callers from mutating the fixture. */
  normalize(raw: NormalizedListing): NormalizedListing {
    return { ...raw, photos: [...raw.photos], openHouses: [...raw.openHouses] };
  }
}
