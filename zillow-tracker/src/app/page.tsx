import { Dashboard } from '@/components/search/Dashboard';
import type { SavedSearchSummary } from '@/components/search/types';
// TODO(backend): src/lib/db/searches.ts should export `getSavedSearches(): Promise<...>`
// resolving to records with at least the fields in SavedSearchSummary (src/components/
// search/types.ts) — id, name, parsed `query`, `active`, notification flags, etc.
// `query` and `resolved` are stored as JSON text in the DB; callers here expect them
// already parsed back into objects, not raw strings.
import { getSavedSearches } from '@/lib/db/searches';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let savedSearches: SavedSearchSummary[] = [];
  try {
    savedSearches = (await getSavedSearches()) as SavedSearchSummary[];
  } catch {
    // Saved-search storage may not exist yet (fresh DB). The dashboard is designed to
    // work with zero saved searches — that's the default first-run state, not an error.
  }

  return <Dashboard savedSearches={savedSearches} />;
}
