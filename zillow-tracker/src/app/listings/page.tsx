import Link from 'next/link';
import { findListings, getAreas } from '@/lib/db/queries';
import { parseFilters, describeFilters, type SearchParams } from '@/lib/filters';
import {
  AddressCell, Empty, PageHeader, PriceDelta, StatusBadge, formatOpenHouse, humanize, usd,
} from '@/components/ui';
import { FavoriteButton } from '@/components/actions';

export const dynamic = 'force-dynamic';

const STATUSES = ['ACTIVE', 'COMING_SOON', 'PENDING', 'CONTINGENT', 'SOLD'];
const TYPES = ['SINGLE_FAMILY', 'CONDO', 'TOWNHOUSE', 'MULTI_FAMILY', 'LAND'];

export default async function ListingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const [listings, areas] = await Promise.all([findListings(filters), getAreas()]);

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v[0] : v;
    if (val) qs.set(k, val);
  }
  const exportUrl = `/api/export/xlsx?${qs.toString()}`;
  const summary = describeFilters(filters);

  return (
    <>
      <PageHeader
        title="Listings"
        subtitle={`${listings.length} match${listings.length === 1 ? '' : 'es'}${summary ? ` — ${summary}` : ''}`}
        actions={<a href={exportUrl}><button>Export to Excel</button></a>}
      />

      <form className="card" style={{ padding: 14, marginBottom: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="Search"><input name="q" defaultValue={filters.q ?? ''} placeholder="Address, city, ZIP" style={{ width: 180 }} /></Field>
        <Field label="Min price"><input name="minPrice" type="number" defaultValue={filters.minPrice ?? ''} style={{ width: 110 }} /></Field>
        <Field label="Max price"><input name="maxPrice" type="number" defaultValue={filters.maxPrice ?? ''} style={{ width: 110 }} /></Field>
        <Field label="Beds"><input name="minBeds" type="number" min="0" defaultValue={filters.minBeds ?? ''} style={{ width: 70 }} /></Field>
        <Field label="Baths"><input name="minBaths" type="number" min="0" step="0.5" defaultValue={filters.minBaths ?? ''} style={{ width: 70 }} /></Field>
        <Field label="Status">
          <select name="status" defaultValue={filters.status?.[0] ?? ''}>
            <option value="">Any</option>
            {STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select name="type" defaultValue={filters.propertyType?.[0] ?? ''}>
            <option value="">Any</option>
            {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
          </select>
        </Field>
        {areas.length > 0 && (
          <Field label="Area">
            <select name="areaId" defaultValue={filters.areaId ?? ''}>
              <option value="">All</option>
              {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Sort">
          <select name="sort" defaultValue={filters.sort}>
            <option value="newest">Newest</option>
            <option value="price-asc">Price ↑</option>
            <option value="price-desc">Price ↓</option>
            <option value="recently-changed">Recently changed</option>
          </select>
        </Field>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 7 }}>
          <input type="checkbox" name="openHouse" value="1" defaultChecked={filters.openHouseOnly} style={{ width: 'auto' }} />
          <span style={{ fontSize: 13 }}>Open house</span>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 7 }}>
          <input type="checkbox" name="favorites" value="1" defaultChecked={filters.favoritesOnly} style={{ width: 'auto' }} />
          <span style={{ fontSize: 13 }}>Favorites</span>
        </label>
        <button type="submit">Apply</button>
        <Link href="/listings"><button type="button">Reset</button></Link>
      </form>

      {listings.length === 0 ? (
        <Empty title="No listings match" hint="Loosen the filters, or run a poll to bring in data." />
      ) : (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th /><th>Address</th><th>Price</th><th>Last change</th><th>Beds</th>
                <th>Baths</th><th>SqFt</th><th>$/SqFt</th><th>Year</th><th>Status</th>
                <th>Next open house</th>
              </tr>
            </thead>
            <tbody>
              {listings.map((l) => {
                const lastPrice = l.events[0];
                const nextOh = l.openHouses[0];
                return (
                  <tr key={l.id}>
                    <td><FavoriteButton listingId={l.id} initial={l.saved?.favorite ?? false} /></td>
                    <td><AddressCell listing={l} /></td>
                    <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{usd(l.listPrice)}</td>
                    <td>{lastPrice ? <PriceDelta deltaAbs={lastPrice.deltaAbs} deltaPct={lastPrice.deltaPct} /> : <span className="muted">—</span>}</td>
                    <td>{l.beds ?? '—'}</td>
                    <td>{l.bathsTotal ?? '—'}</td>
                    <td>{l.livingAreaSqft?.toLocaleString() ?? '—'}</td>
                    <td>{l.listPrice && l.livingAreaSqft ? usd(Math.round(l.listPrice / l.livingAreaSqft)) : '—'}</td>
                    <td>{l.yearBuilt ?? '—'}</td>
                    <td><StatusBadge status={l.status} /></td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                      {nextOh ? formatOpenHouse(nextOh.startsAt, nextOh.endsAt, nextOh.timezone) : <span className="muted">—</span>}
                    </td>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</span>
      {children}
    </label>
  );
}
