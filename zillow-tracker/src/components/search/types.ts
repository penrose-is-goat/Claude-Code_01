import type { SearchQuery } from '@/lib/search/types';

/**
 * UI-facing view of a saved search.
 *
 * Deliberately NOT imported from `@/lib/db/searches` — that module is owned by the
 * backend agent and may still be in flux. Keeping this shape local and structural means
 * these components compile against "whatever has at least these fields" rather than a
 * specific exported type name, so the two halves of the rebuild don't have to land in
 * the same commit. `query` and `resolved` are expected already parsed back from their
 * stored JSON text (the DB stores them as strings; the UI never wants to know that).
 */
export interface SavedSearchSummary {
  id: string;
  name: string;
  query: SearchQuery;
  /** Cached geocode of a typed place; absent for drawn-polygon searches. */
  resolved?: { displayName: string } | null;
  active: boolean;
  /** null/undefined = manual refresh only. */
  pollCron?: string | null;
  lastRunAt?: string | Date | null;
  notifyOnNew: boolean;
  notifyOnPriceDrop: boolean;
  notifyOnOpenHouse: boolean;
  createdAt?: string | Date;
}

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
