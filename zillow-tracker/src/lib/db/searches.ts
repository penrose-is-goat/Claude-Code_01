import type { PrismaClient, SavedSearch } from '@prisma/client';
import { prisma } from './client';
import type { ResolvedPlace, SavedSearchInput, SearchQuery } from '../search/types';

/**
 * The saved-search repository — CRUD for the thing this app is actually organized
 * around now that there is no built-in area. Follows `db/queries.ts`'s existing
 * convention: the public functions below import the module-singleton `prisma` rather
 * than taking a client, and return a parsed `SavedSearchRecord` (query/resolved decoded
 * from their stored JSON text) rather than the raw row — callers never see the string.
 *
 * The ingest runner is the one exception. It carries its own `PrismaClient` (the
 * worker's long-lived instance, or a test's temp-SQLite one) rather than the singleton,
 * so `parseSavedSearchQuery` / `parseResolvedPlace` / `cacheResolvedPlace` stay
 * standalone and client-agnostic (or explicitly client-taking) for it to compose with.
 */

export interface SavedSearchRecord {
  id: string;
  name: string;
  query: SearchQuery;
  resolved: ResolvedPlace | null;
  active: boolean;
  /** null = manual refresh only. */
  pollCron: string | null;
  notifyOnNew: boolean;
  notifyOnPriceDrop: boolean;
  notifyOnOpenHouse: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
}

export function parseSavedSearchQuery(row: Pick<SavedSearch, 'query'>): SearchQuery {
  return JSON.parse(row.query) as SearchQuery;
}

export function parseResolvedPlace(row: Pick<SavedSearch, 'resolved'>): ResolvedPlace | undefined {
  if (!row.resolved) return undefined;
  try {
    return JSON.parse(row.resolved) as ResolvedPlace;
  } catch {
    // A corrupted cache entry should degrade to "re-geocode on next poll", not break
    // the search it belongs to.
    return undefined;
  }
}

function toRecord(row: SavedSearch): SavedSearchRecord {
  return {
    id: row.id,
    name: row.name,
    query: parseSavedSearchQuery(row),
    resolved: parseResolvedPlace(row) ?? null,
    active: row.active,
    pollCron: row.pollCron,
    notifyOnNew: row.notifyOnNew,
    notifyOnPriceDrop: row.notifyOnPriceDrop,
    notifyOnOpenHouse: row.notifyOnOpenHouse,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRunAt: row.lastRunAt,
  };
}

export async function getSavedSearches(): Promise<SavedSearchRecord[]> {
  const rows = await prisma.savedSearch.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toRecord);
}

export async function getSavedSearch(id: string): Promise<SavedSearchRecord | null> {
  const row = await prisma.savedSearch.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
}

export async function createSavedSearch(input: SavedSearchInput): Promise<SavedSearchRecord> {
  const row = await prisma.savedSearch.create({
    data: {
      name: input.name,
      query: JSON.stringify(input.query),
      pollCron: input.cron ?? null,
      notifyOnNew: input.notifyOnNew ?? true,
      notifyOnPriceDrop: input.notifyOnPriceDrop ?? true,
      notifyOnOpenHouse: input.notifyOnOpenHouse ?? true,
    },
  });
  return toRecord(row);
}

export interface UpdateSavedSearchPatch {
  name?: string;
  active?: boolean;
  /** null = manual refresh only. */
  cron?: string | null;
  notifyOnNew?: boolean;
  notifyOnPriceDrop?: boolean;
  notifyOnOpenHouse?: boolean;
}

export async function updateSavedSearch(
  id: string,
  patch: UpdateSavedSearchPatch,
): Promise<SavedSearchRecord> {
  const row = await prisma.savedSearch.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.cron !== undefined ? { pollCron: patch.cron } : {}),
      ...(patch.notifyOnNew !== undefined ? { notifyOnNew: patch.notifyOnNew } : {}),
      ...(patch.notifyOnPriceDrop !== undefined ? { notifyOnPriceDrop: patch.notifyOnPriceDrop } : {}),
      ...(patch.notifyOnOpenHouse !== undefined ? { notifyOnOpenHouse: patch.notifyOnOpenHouse } : {}),
    },
  });
  return toRecord(row);
}

export async function renameSavedSearch(id: string, name: string): Promise<SavedSearchRecord> {
  return updateSavedSearch(id, { name });
}

export async function deleteSavedSearch(id: string): Promise<void> {
  await prisma.savedSearch.delete({ where: { id } });
}

export async function toggleActive(id: string): Promise<boolean> {
  const row = await prisma.savedSearch.findUniqueOrThrow({ where: { id } });
  const next = !row.active;
  await prisma.savedSearch.update({ where: { id }, data: { active: next } });
  return next;
}

/** Stamps when a search was last actually run — a manual "Run now" and a scheduled poll
 * both want to set this, so /searches shows one honest timestamp regardless of which
 * fired. */
export async function markSearchRun(id: string, at: Date): Promise<void> {
  await prisma.savedSearch.update({ where: { id }, data: { lastRunAt: at } });
}

/**
 * Caches a geocode result on the search so polling doesn't re-resolve it every run.
 * Takes an explicit client, unlike everything else in this file — called from the
 * ingest runner, which owns its own `PrismaClient` rather than this module's singleton.
 */
export async function cacheResolvedPlace(
  db: PrismaClient,
  id: string,
  place: ResolvedPlace,
): Promise<void> {
  await db.savedSearch.update({ where: { id }, data: { resolved: JSON.stringify(place) } });
}
