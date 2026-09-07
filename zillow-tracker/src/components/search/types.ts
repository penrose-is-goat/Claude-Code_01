import type { SearchQuery } from '@/lib/search/types';
import type { SavedSearchRecord } from '@/lib/db/searches';

/**
 * UI-facing view of a saved search — a direct alias of the backend's `SavedSearchRecord`
 * (src/lib/db/searches.ts), which already comes back with `query`/`resolved` parsed out
 * of their stored JSON text. Kept as a local alias rather than spelling that import
 * everywhere so the rest of these components have one name to depend on.
 */
export type SavedSearchSummary = SavedSearchRecord;

/** Property types a person can filter by. Mirrors `PropertyType` in providers/normalized.ts. */
export const PROPERTY_TYPES = [
  'SINGLE_FAMILY',
  'CONDO',
  'TOWNHOUSE',
  'MULTI_FAMILY',
  'LAND',
  'MANUFACTURED',
  'OTHER',
] as const;

/** Cadence choices for a tracked search. Value is the cron the API stores; null = manual. */
export const CADENCE_OPTIONS: Array<{ label: string; cron: string | null }> = [
  { label: 'Manual refresh only', cron: null },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily', cron: '0 8 * * *' },
];

export function describeLocation(q: SearchQuery): string {
  return q.location.kind === 'place'
    ? `${q.location.query} · within ${q.location.radiusMiles} mi`
    : q.location.label || `Drawn area (${q.location.ring.length} points)`;
}
