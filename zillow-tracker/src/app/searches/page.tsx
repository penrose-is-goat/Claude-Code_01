import Link from 'next/link';
import { PageHeader, Empty } from '@/components/ui';
import { SavedSearchRow } from '@/components/search/SavedSearchRow';
import type { SavedSearchSummary } from '@/components/search/types';
// TODO(backend): see the TODO in src/app/page.tsx — same `getSavedSearches` expectation.
import { getSavedSearches } from '@/lib/db/searches';

export const dynamic = 'force-dynamic';

export default async function SearchesPage() {
  let searches: SavedSearchSummary[] = [];
  let loadError = false;
  try {
    searches = (await getSavedSearches()) as SavedSearchSummary[];
  } catch {
    loadError = true;
  }

  return (
    <>
      <PageHeader
        title="Saved Searches"
        subtitle="What gets tracked, how often, and what you're notified about"
        actions={<Link href="/" className="btn-link">New search</Link>}
      />

      {loadError ? (
        <Empty title="Couldn't load saved searches" hint="The database may not be migrated yet — run `npm run db:push`." />
      ) : searches.length === 0 ? (
        <Empty
          title="No saved searches yet"
          hint={'Run a search from the dashboard, then press "Track this search" to have it show up here.'}
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {searches.map((s) => (
            <SavedSearchRow key={s.id} search={s} />
          ))}
        </div>
      )}
    </>
  );
}
