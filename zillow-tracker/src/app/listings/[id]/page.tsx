import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getListing } from '@/lib/db/queries';
import { PageHeader, PriceDelta, StatusBadge, formatDate, formatOpenHouse, humanize, usd } from '@/components/ui';
import { FavoriteButton, SavedNotesEditor } from '@/components/actions';

export const dynamic = 'force-dynamic';

export default async function ListingDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const listing = await getListing(id);
  if (!listing) notFound();

  const photos = JSON.parse(listing.photos) as Array<{ url: string; order: number }>;
  const tags = listing.saved ? (JSON.parse(listing.saved.tags) as string[]) : [];
  const priceEvents = listing.events.filter((e) => e.type === 'PRICE_CHANGE');
  const upcomingOh = listing.openHouses.filter((o) => !o.cancelledAt && o.startsAt >= new Date());
  const daysTracked = Math.max(1, Math.round((Date.now() - listing.firstSeenAt.getTime()) / 864e5));

  return (
    <>
      <div style={{ marginBottom: 12 }}><Link href="/listings">← Back to listings</Link></div>

      <PageHeader
        title={listing.addressLine1}
        subtitle={`${listing.city}, ${listing.state} ${listing.postalCode}`}
        actions={
          <>
            <FavoriteButton listingId={listing.id} initial={listing.saved?.favorite ?? false} />
            {listing.listingUrl && (
              <a href={listing.listingUrl} target="_blank" rel="noopener noreferrer">
                <button>View on source ↗</button>
              </a>
            )}
          </>
        }
      />

      {listing.removedAt && (
        <div className="card" style={{ padding: 12, marginBottom: 16, borderColor: 'var(--bad)' }}>
          <strong className="bad">No longer listed</strong>
          <span className="muted"> — last seen {formatDate(listing.lastSeenAt)}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
          <section className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 28, fontWeight: 700 }}>{usd(listing.listPrice)}</span>
              <StatusBadge status={listing.status} />
              {listing.listPrice && listing.livingAreaSqft && (
                <span className="muted">{usd(Math.round(listing.listPrice / listing.livingAreaSqft))}/sqft</span>
              )}
            </div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12, margin: '16px 0 0' }}>
              <Fact label="Beds" value={listing.beds ?? '—'} />
              <Fact label="Baths" value={listing.bathsTotal ?? '—'} />
              <Fact label="Living area" value={listing.livingAreaSqft ? `${listing.livingAreaSqft.toLocaleString()} sqft` : '—'} />
              <Fact label="Lot" value={listing.lotSizeSqft ? `${listing.lotSizeSqft.toLocaleString()} sqft` : '—'} />
              <Fact label="Year built" value={listing.yearBuilt ?? '—'} />
              <Fact label="Type" value={humanize(listing.propertyType)} />
              <Fact label="HOA" value={listing.hoaFeeMonthly ? `${usd(listing.hoaFeeMonthly)}/mo` : '—'} />
              <Fact label="Days tracked" value={daysTracked} />
            </dl>
            {listing.description && <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>{listing.description}</p>}
          </section>

          {photos.length > 0 && (
            <section>
              <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Photos</h2>
              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                {/* Hotlinked, never rehosted — listing photos carry their own copyright. */}
                {photos.map((p) => (
                  <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={p.url}
                      alt=""
                      style={{ height: 130, width: 190, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
                    />
                  </a>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              Open houses {upcomingOh.length > 0 && <span className="muted">({upcomingOh.length} upcoming)</span>}
            </h2>
            {listing.openHouses.length === 0 ? (
              <div className="card" style={{ padding: 14 }} ><span className="muted">None announced.</span></div>
            ) : (
              <div className="card table-scroll">
                <table>
                  <thead><tr><th>When</th><th>Kind</th><th>State</th></tr></thead>
                  <tbody>
                    {listing.openHouses.map((oh) => (
                      <tr key={oh.id} style={oh.cancelledAt ? { opacity: 0.55, textDecoration: 'line-through' } : undefined}>
                        <td>{formatOpenHouse(oh.startsAt, oh.endsAt, oh.timezone)}</td>
                        <td>{[oh.appointmentOnly && 'By appointment', oh.virtual && 'Virtual'].filter(Boolean).join(', ') || 'Open'}</td>
                        <td>{oh.cancelledAt ? <span className="bad">Cancelled</span> : oh.startsAt < new Date() ? <span className="muted">Past</span> : <span className="good">Scheduled</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Price history</h2>
            {priceEvents.length === 0 ? (
              <div className="card" style={{ padding: 14 }}>
                <span className="muted">No price changes since tracking began ({formatDate(listing.firstSeenAt)}).</span>
              </div>
            ) : (
              <div className="card table-scroll">
                <table>
                  <thead><tr><th>Date</th><th>From</th><th>To</th><th>Change</th></tr></thead>
                  <tbody>
                    {priceEvents.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDate(e.occurredAt)}</td>
                        <td>{usd(e.oldValue ? Number(e.oldValue) : null)}</td>
                        <td>{usd(e.newValue ? Number(e.newValue) : null)}</td>
                        <td><PriceDelta deltaAbs={e.deltaAbs} deltaPct={e.deltaPct} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Full activity</h2>
            <div className="card table-scroll">
              <table>
                <thead><tr><th>When</th><th>Type</th><th>Detail</th></tr></thead>
                <tbody>
                  {listing.events.map((e) => (
                    <tr key={e.id}>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(e.occurredAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{humanize(e.type)}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside style={{ display: 'grid', gap: 16, position: 'sticky', top: 16 }}>
          <section className="card" style={{ padding: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginTop: 0, marginBottom: 12 }}>My notes</h2>
            <SavedNotesEditor
              listingId={listing.id}
              initial={{
                notes: listing.saved?.notes ?? '',
                rating: listing.saved?.rating ?? null,
                userStatus: listing.saved?.userStatus ?? 'NEW',
                tags,
              }}
            />
          </section>

          <section className="card" style={{ padding: 16 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, marginTop: 0, marginBottom: 10 }}>Provenance</h2>
            <dl style={{ display: 'grid', gap: 8, margin: 0, fontSize: 13 }}>
              <Fact label="Source" value={humanize(listing.providerId)} />
              <Fact label="Source ID" value={listing.sourceListingId} />
              {listing.mlsId && <Fact label="MLS #" value={listing.mlsId} />}
              <Fact label="First seen" value={formatDate(listing.firstSeenAt)} />
              <Fact label="Last seen" value={formatDate(listing.lastSeenAt)} />
              <Fact label="Areas" value={listing.areas.map((a) => a.area.name).join(', ') || '—'} />
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</dt>
      <dd style={{ margin: '2px 0 0', fontWeight: 600 }}>{value}</dd>
    </div>
  );
}
