import { getUpcomingOpenHouses } from '@/lib/db/queries';
import { AddressCell, Empty, PageHeader, StatusBadge, usd } from '@/components/ui';
import { FavoriteButton } from '@/components/actions';

export const dynamic = 'force-dynamic';

/** Groups by calendar day, because that's how you actually plan a Saturday. */
export default async function OpenHousesPage() {
  const openHouses = await getUpcomingOpenHouses(21);

  const byDay = new Map<string, typeof openHouses>();
  for (const oh of openHouses) {
    const key = oh.startsAt.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: oh.timezone,
    });
    const bucket = byDay.get(key) ?? [];
    bucket.push(oh);
    byDay.set(key, bucket);
  }

  return (
    <>
      <PageHeader
        title="Open Houses"
        subtitle={`${openHouses.length} scheduled over the next 3 weeks`}
      />

      {openHouses.length === 0 ? (
        <Empty
          title="No upcoming open houses"
          hint="Open-house times only appear if your data source publishes them. The CSV import path does not carry them; the mock and Zillow providers do."
        />
      ) : (
        [...byDay.entries()].map(([day, items]) => (
          <section key={day} style={{ marginBottom: 22 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              {day} <span className="muted" style={{ fontWeight: 400 }}>({items.length})</span>
            </h2>
            <div className="card table-scroll">
              <table>
                <thead>
                  <tr><th /><th>Time</th><th>Address</th><th>Price</th><th>Beds</th><th>Baths</th><th>SqFt</th><th>Status</th><th>Kind</th></tr>
                </thead>
                <tbody>
                  {items.map((oh) => (
                    <tr key={oh.id}>
                      <td><FavoriteButton listingId={oh.listing.id} initial={oh.listing.saved?.favorite ?? false} /></td>
                      <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {oh.startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: oh.timezone })}
                        {' – '}
                        {oh.endsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: oh.timezone })}
                      </td>
                      <td><AddressCell listing={oh.listing} /></td>
                      <td style={{ fontWeight: 600 }}>{usd(oh.listing.listPrice)}</td>
                      <td>{oh.listing.beds ?? '—'}</td>
                      <td>{oh.listing.bathsTotal ?? '—'}</td>
                      <td>{oh.listing.livingAreaSqft?.toLocaleString() ?? '—'}</td>
                      <td><StatusBadge status={oh.listing.status} /></td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {[oh.appointmentOnly && 'By appt', oh.virtual && 'Virtual'].filter(Boolean).join(', ') || 'Open'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </>
  );
}
