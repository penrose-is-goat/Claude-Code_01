import { findListings } from '@/lib/db/queries';
import { AddressCell, Empty, PageHeader, StatusBadge, formatDate, humanize, usd } from '@/components/ui';
import { FavoriteButton } from '@/components/actions';

export const dynamic = 'force-dynamic';

export default async function SavedPage() {
  const listings = await findListings({ favoritesOnly: true, includeRemoved: true, sort: 'recently-changed' });

  return (
    <>
      <PageHeader
        title="Saved"
        subtitle={`${listings.length} favorite${listings.length === 1 ? '' : 's'}`}
        actions={<a href="/api/export/xlsx?favorites=1"><button>Export favorites to Excel</button></a>}
      />

      {listings.length === 0 ? (
        <Empty title="Nothing saved yet" hint="Star a listing from the Listings page and it will appear here with your notes." />
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th /><th>Address</th><th>Price</th><th>My status</th><th>Rating</th><th>Tags</th><th>Notes</th><th>Listing status</th><th>Saved</th></tr>
            </thead>
            <tbody>
              {listings.map((l) => {
                const tags = l.saved ? (JSON.parse(l.saved.tags) as string[]) : [];
                return (
                  <tr key={l.id} style={l.removedAt ? { opacity: 0.6 } : undefined}>
                    <td><FavoriteButton listingId={l.id} initial={l.saved?.favorite ?? false} /></td>
                    <td><AddressCell listing={l} /></td>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{usd(l.listPrice)}</td>
                    <td>{humanize(l.saved?.userStatus)}</td>
                    <td>{l.saved?.rating ? '★'.repeat(l.saved.rating) : <span className="muted">—</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{tags.join(', ') || '—'}</td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 260 }}>{l.saved?.notes || '—'}</td>
                    <td>{l.removedAt ? <span className="bad" style={{ fontSize: 12 }}>Delisted</span> : <StatusBadge status={l.status} />}</td>
                    <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDate(l.saved?.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
