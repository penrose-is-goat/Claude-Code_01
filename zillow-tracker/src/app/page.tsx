import Link from 'next/link';
import { getRecentEvents, getStats, getUpcomingOpenHouses } from '@/lib/db/queries';
import { AddressCell, Empty, PageHeader, PriceDelta, Stat, formatOpenHouse, usd } from '@/components/ui';
import { PollButton, MarkSeenButton } from '@/components/actions';

export const dynamic = 'force-dynamic';

const EVENT_LABELS: Record<string, string> = {
  NEW_LISTING: 'New', PRICE_CHANGE: 'Price', STATUS_CHANGE: 'Status',
  BACK_ON_MARKET: 'Back on market', OPEN_HOUSE_ADDED: 'Open house',
  OPEN_HOUSE_CHANGED: 'Open house changed', OPEN_HOUSE_CANCELLED: 'Open house cancelled',
  PHOTOS_ADDED: 'Photos', DESCRIPTION_CHANGED: 'Description', DELISTED: 'Delisted',
};

export default async function Dashboard() {
  let stats, events, openHouses;
  try {
    [stats, events, openHouses] = await Promise.all([
      getStats(), getRecentEvents(60), getUpcomingOpenHouses(7),
    ]);
  } catch {
    return (
      <Empty
        title="Database not ready"
        hint="Run `npm run db:push && npm run seed` to create and populate the database."
      />
    );
  }

  return (
    <>
      <PageHeader
        title="What's New"
        subtitle={
          stats.lastRun
            ? `Last checked ${stats.lastRun.startedAt.toLocaleString('en-US')} — ${stats.lastRun.status.toLowerCase()}`
            : 'No polls yet'
        }
        actions={<><PollButton /><MarkSeenButton disabled={stats.unseen === 0} /></>}
      />

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Stat label="Tracking" value={stats.total} hint={`${stats.active} active`} />
        <Stat label="Unseen updates" value={stats.unseen} />
        <Stat label="Favorites" value={stats.favorites} />
        <Stat label="Open houses" value={stats.upcomingOpenHouses} hint="upcoming" />
      </div>

      {stats.lastRun && !stats.lastRun.canaryOk && (
        <div className="card" style={{ padding: 14, marginBottom: 20, borderColor: 'var(--bad)' }}>
          <strong className="bad">Data quality warning</strong>
          <div className="muted" style={{ marginTop: 4 }}>{stats.lastRun.canaryReason}</div>
          <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            A source that silently returns nothing looks identical to a quiet market. This
            check exists so that difference is visible.
          </div>
        </div>
      )}

      {openHouses.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Open houses in the next 7 days</h2>
          <div className="card table-scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Address</th><th>Price</th><th /></tr>
              </thead>
              <tbody>
                {openHouses.slice(0, 8).map((oh) => (
                  <tr key={oh.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatOpenHouse(oh.startsAt, oh.endsAt, oh.timezone)}</td>
                    <td><AddressCell listing={oh.listing} /></td>
                    <td>{usd(oh.listing.listPrice)}</td>
                    <td>{oh.listing.saved?.favorite ? '★' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {openHouses.length > 8 && (
            <div style={{ marginTop: 8 }}><Link href="/open-houses">See all {openHouses.length} →</Link></div>
          )}
        </section>
      )}

      <section>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Recent activity</h2>
        {events.length === 0 ? (
          <Empty title="Nothing yet" hint="Run a poll to populate the feed." />
        ) : (
          <div className="card table-scroll">
            <table>
              <thead>
                <tr><th>When</th><th>Type</th><th>Address</th><th>What changed</th><th>Delta</th></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} style={e.seenAt == null ? { fontWeight: 600 } : undefined}>
                    <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      {e.occurredAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{EVENT_LABELS[e.type] ?? e.type}</td>
                    <td><AddressCell listing={e.listing} /></td>
                    <td className="muted">{e.message}</td>
                    <td>{e.type === 'PRICE_CHANGE' ? <PriceDelta deltaAbs={e.deltaAbs} deltaPct={e.deltaPct} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
