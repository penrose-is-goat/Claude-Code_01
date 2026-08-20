import { getSavedSearches } from '@/lib/db/searches';
import { Dashboard } from '@/components/search/Dashboard';
import type { SavedSearchSummary } from '@/components/search/types';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let savedSearches: SavedSearchSummary[] = [];
  try {
    savedSearches = await getSavedSearches();
  } catch {
    // Saved-search storage may not exist yet (fresh DB). The dashboard is designed to
    // work with zero saved searches — that's the default first-run state, not an error.
  }

  return <Dashboard savedSearches={savedSearches} />;
}
