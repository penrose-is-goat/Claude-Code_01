import Link from 'next/link';

export function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  return s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatOpenHouse(startsAt: Date, endsAt: Date, timezone = 'America/Denver'): string {
  const day = startsAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone });
  const from = startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const to = endsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  return `${day}, ${from}–${to}`;
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card" style={{ padding: '14px 16px', minWidth: 130, flex: '1 1 130px' }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, lineHeight: 1.1 }}>{value}</div>
      {hint && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'var(--good)',
  COMING_SOON: 'var(--accent)',
  PENDING: 'var(--warn)',
  CONTINGENT: 'var(--warn)',
  SOLD: 'var(--muted)',
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? 'var(--muted)';
  return (
    <span style={{
      color, border: `1px solid ${color}`, borderRadius: 20, padding: '1px 8px',
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {humanize(status)}
    </span>
  );
}

export function PriceDelta({ deltaAbs, deltaPct }: { deltaAbs: number | null; deltaPct: number | null }) {
  if (deltaAbs == null) return <span className="muted">—</span>;
  const isDrop = deltaAbs < 0;
  return (
    <span className={isDrop ? 'good' : 'bad'} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
      {isDrop ? '▼' : '▲'} {usd(Math.abs(deltaAbs))}
      {deltaPct != null && ` (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`}
    </span>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card" style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {hint && <div className="muted" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

export function AddressCell({ listing }: {
  listing: { id: string; addressLine1: string; city: string; state: string; postalCode: string; listingUrl: string | null };
}) {
  return (
    <div>
      <Link href={`/listings/${listing.id}`} style={{ fontWeight: 600, textDecoration: 'none' }}>
        {listing.addressLine1}
      </Link>
      <div className="muted" style={{ fontSize: 12 }}>
        {listing.city}, {listing.state} {listing.postalCode}
        {listing.listingUrl && (
          <>
            {' · '}
            <a href={listing.listingUrl} target="_blank" rel="noopener noreferrer">source ↗</a>
          </>
        )}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: string; actions?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{title}</h1>
        {subtitle && <p className="muted" style={{ margin: '4px 0 0' }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}
