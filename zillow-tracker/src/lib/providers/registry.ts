import type { ListingProvider, ProviderId } from './types';
import { WebSearchProvider } from './websearch';
import { RentCastProvider } from './rentcast';
import { SnapshotProvider } from './snapshot';
import { ZillowPublicProvider } from './zillow';
import { CsvImportProvider } from './csv';

/**
 * Single place that knows which providers exist. Everything else takes a
 * ListingProvider, so adding a licensed MLS feed later means adding one file and one
 * line here — not touching the pipeline, the UI, or the exporter.
 */
const registry = new Map<ProviderId, ListingProvider<any>>();

export function getProvider(id: ProviderId): ListingProvider<any> {
  const existing = registry.get(id);
  if (existing) return existing;

  const created = create(id);
  registry.set(id, created);
  return created;
}

function create(id: ProviderId): ListingProvider<any> {
  switch (id) {
    case 'websearch':
      return new WebSearchProvider();
    case 'rentcast':
      return new RentCastProvider();
    case 'snapshot':
      return new SnapshotProvider();
    case 'zillow':
      return new ZillowPublicProvider();
    case 'csv':
      return new CsvImportProvider();
    default:
      throw new Error(`Unknown provider: ${id}`);
  }
}

export function resetRegistry(): void {
  registry.clear();
}

/**
 * Order matters: this is the order a search runs providers in, and the first one is the
 * one expected to carry the market. `websearch` leads because it is the only provider
 * that reaches live Zillow data from an ordinary machine — the direct `zillow` provider
 * is refused with a 403 even from a residential IP. `zillow` stays registered behind it
 * so a licensed or otherwise-permitted deployment can still use it, and `snapshot`
 * follows to contribute the open-house windows search results do not carry.
 */
export const ALL_PROVIDER_IDS: ProviderId[] = ['websearch', 'rentcast', 'zillow', 'snapshot', 'csv'];
