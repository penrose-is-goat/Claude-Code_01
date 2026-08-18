import type { ListingProvider, ProviderId } from './types';
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

export const ALL_PROVIDER_IDS: ProviderId[] = ['zillow', 'snapshot', 'csv'];
