import { getAreas } from '@/lib/db/queries';
import { Empty, PageHeader, humanize } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AreasPage() {
  const areas = await getAreas();

  return (
    <>
      <PageHeader
        title="Areas"
        subtitle="The neighborhoods being watched. Providers are queried coarsely, then results are filtered to the exact shape."
      />

      {areas.length === 0 ? (
        <Empty title="No areas defined" hint="Run `npm run seed` to create the demo areas." />
      ) : (
        <div className="card table-scroll" style={{ marginBottom: 20 }}>
          <table>
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Definition</th><th>Providers</th><th>Schedule</th><th>Active</th></tr>
            </thead>
            <tbody>
              {areas.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.name}</td>
                  <td>{humanize(a.kind)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{describeArea(a)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{safeList(a.providerIds)}</td>
                  <td className="muted" style={{ fontSize: 12, fontFamily: 'ui-monospace, monospace' }}>{a.pollCron}</td>
                  <td>{a.active ? <span className="good">Yes</span> : <span className="muted">No</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, marginTop: 0 }}>How areas work</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          No listing source accepts a hand-drawn polygon, so the fetch uses the coarsest
          query the provider understands — a city slug or a ZIP — and the precise shape is
          applied locally with a point-in-polygon test. At this scale that filtering takes
          microseconds, which is why there is no spatial database here.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          A listing that arrives without coordinates is kept rather than dropped: seeing a
          house you then dismiss is a cheaper mistake than never seeing it at all.
        </p>
      </div>
    </>
  );
}

function describeArea(a: { kind: string; postalCodes: string | null; city: string | null; state: string | null; radiusMiles: number | null; polygon: string | null }): string {
  if (a.kind === 'POSTAL_CODES') return safeList(a.postalCodes) || '—';
  if (a.kind === 'CITY_RADIUS') return `${a.city ?? '?'}, ${a.state ?? '?'} within ${a.radiusMiles ?? '?'} mi`;
  if (a.kind === 'POLYGON') {
    try {
      const ring = JSON.parse(a.polygon ?? '[]') as unknown[];
      return `Drawn polygon, ${ring.length} points`;
    } catch {
      return 'Drawn polygon';
    }
  }
  return '—';
}

/** Area JSON columns are user-editable, so never let a malformed one crash the page. */
function safeList(json: string | null): string {
  if (!json) return '';
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.join(', ');
    if (parsed && typeof parsed === 'object' && 'codes' in parsed) {
      return (parsed.codes as string[]).join(', ');
    }
    return String(json);
  } catch {
    return String(json);
  }
}
