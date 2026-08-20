import type { PrismaClient, SavedSearch } from '@prisma/client';
import type { ResolvedPlace, SavedSearchInput, SearchQuery } from '../search/types';

/**
 * The saved-search repository — CRUD for the thing this app is actually organized
 * around now that there is no built-in area. `SavedSearch.query` stores the whole
 * `SearchQuery` as JSON rather than being split across columns, precisely so a saved
 * search can be replayed exactly as the user expressed it (a typed place + radius, or a
 * drawn ring) without lossy reconstruction from separate fields.
 */

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

export async function listSavedSearches(
  db: PrismaClient,
  opts: { activeOnly?: boolean } = {},
): Promise<SavedSearch[]> {
  return db.savedSearch.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getSavedSearch(db: PrismaClient, id: string): Promise<SavedSearch | null> {
  return db.savedSearch.findUnique({ where: { id } });
}

export async function createSavedSearch(
  db: PrismaClient,
  input: SavedSearchInput,
): Promise<SavedSearch> {
  return db.savedSearch.create({
    data: {
      name: input.name,
      query: JSON.stringify(input.query),
      pollCron: input.cron ?? null,
      notifyOnNew: input.notifyOnNew ?? true,
      notifyOnPriceDrop: input.notifyOnPriceDrop ?? true,
      notifyOnOpenHouse: input.notifyOnOpenHouse ?? true,
    },
  });
}

export interface UpdateSavedSearchInput {
  name?: string;
  query?: SearchQuery;
  cron?: string | null;
  notifyOnNew?: boolean;
  notifyOnPriceDrop?: boolean;
  notifyOnOpenHouse?: boolean;
}

export async function updateSavedSearch(
  db: PrismaClient,
  id: string,
  patch: UpdateSavedSearchInput,
): Promise<SavedSearch> {
  return db.savedSearch.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      // Changing what the search actually looks for invalidates any cached geocode of
      // the OLD place — keeping it would let a renamed/redrawn search silently poll the
      // wrong location until the next scheduled refresh happens to overwrite it.
      ...(patch.query !== undefined ? { query: JSON.stringify(patch.query), resolved: null } : {}),
      ...(patch.cron !== undefined ? { pollCron: patch.cron } : {}),
      ...(patch.notifyOnNew !== undefined ? { notifyOnNew: patch.notifyOnNew } : {}),
      ...(patch.notifyOnPriceDrop !== undefined ? { notifyOnPriceDrop: patch.notifyOnPriceDrop } : {}),
      ...(patch.notifyOnOpenHouse !== undefined ? { notifyOnOpenHouse: patch.notifyOnOpenHouse } : {}),
    },
  });
}

export async function renameSavedSearch(db: PrismaClient, id: string, name: string): Promise<SavedSearch> {
  return db.savedSearch.update({ where: { id }, data: { name } });
}

export async function deleteSavedSearch(db: PrismaClient, id: string): Promise<void> {
  await db.savedSearch.delete({ where: { id } });
}

export async function toggleActive(db: PrismaClient, id: string): Promise<boolean> {
  const row = await db.savedSearch.findUniqueOrThrow({ where: { id } });
  const next = !row.active;
  await db.savedSearch.update({ where: { id }, data: { active: next } });
  return next;
}

/** Caches a geocode result on the search so polling doesn't re-resolve it every run. */
export async function cacheResolvedPlace(
  db: PrismaClient,
  id: string,
  place: ResolvedPlace,
): Promise<void> {
  await db.savedSearch.update({ where: { id }, data: { resolved: JSON.stringify(place) } });
}

export async function markSearchRun(db: PrismaClient, id: string, at: Date): Promise<void> {
  await db.savedSearch.update({ where: { id }, data: { lastRunAt: at } });
}
