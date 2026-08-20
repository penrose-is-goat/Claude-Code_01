import Link from 'next/link';
import { getUnseenEventCount } from '@/lib/db/queries';
import { getSavedSearches } from '@/lib/db/searches';
import { PageHeader, Empty } from '@/components/ui';
import { MarkSeenButton } from '@/components/actions';
import { SavedSearchRow } from '@/components/search/SavedSearchRow';
import type { SavedSearchSummary } from '@/components/search/types';

export const dynamic = 'force-dynamic';

export default async function SearchesPage() {
  let searches: SavedSearchSummary[] = [];
  let loadError = false;
  let unseen = 0;
  try {
    searches = await getSavedSearches();
  } catch {
    loadError = true;
  }
  try {
    unseen = await getUnseenEventCount();
  } catch {
    // Non-fatal — same reasoning as loadError above.
  }

  return (
    <>
      <PageHeader
        title="Saved Searches"
        subtitle="What gets tracked, how often, and what you're notified about"
        actions={
          <>
            <MarkSeenButton disabled={unseen === 0} />
            <Link href="/" className="btn-link">New search</Link>
          </>
        }
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
