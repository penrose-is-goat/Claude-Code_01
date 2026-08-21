import type { ListingProvider, ProviderId } from './types';
import { WebSearchProvider } from './websearch';
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
 * one expected to carry the market. `zillow` leads now that it drives a real browser
 * rather than a plain fetch: the 403 that demoted it was a refusal of an obvious
 * non-browser client, and a rendered page carries coordinates, open-house times and
 * price history that a search snippet never does. `websearch` follows as the fallback
 * for when Zillow still refuses, or when no browser is installed — it reads the same
 * listings from the public search index Zillow publishes them to.
 */
export const ALL_PROVIDER_IDS: ProviderId[] = ['zillow', 'websearch', 'snapshot', 'csv'];
