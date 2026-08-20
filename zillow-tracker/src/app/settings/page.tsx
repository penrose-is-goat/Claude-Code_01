import { getRuns } from '@/lib/db/queries';
import { getProvider, ALL_PROVIDER_IDS } from '@/lib/providers/registry';
import { Empty, PageHeader, humanize } from '@/components/ui';
import { PollButton } from '@/components/actions';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const runs = await getRuns(20);

  const providers = await Promise.all(
    ALL_PROVIDER_IDS.map(async (id) => {
      const p = getProvider(id);
      // A health check must never take the settings page down with it.
      let health: { ok: boolean; message: string };
      try {
        health = id === 'zillow'
          ? { ok: false, message: 'Not checked automatically — press Check below to make a live request' }
          : await p.healthCheck();
      } catch (err) {
        health = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      return { id, displayName: p.displayName, capabilities: p.capabilities, health };
    }),
  );

  return (
    <>
      <PageHeader title="Settings" subtitle="Providers, capabilities, and the poll log" actions={<PollButton />} />

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Data providers</h2>
        <div className="card table-scroll">
          <table>
            <thead>
              <tr><th>Provider</th><th>Open houses</th><th>Photos</th><th>Polygon query</th><th>Rate limit</th><th>Status</th></tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.displayName}</td>
                  <td>{p.capabilities.supportsOpenHouses ? <span className="good">Yes</span> : <span className="muted">No</span>}</td>
                  <td>{p.capabilities.supportsPhotos ? 'Yes' : <span className="muted">No</span>}</td>
                  <td>{p.capabilities.supportsPolygonQuery ? 'Yes' : <span className="muted">No</span>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {p.capabilities.rateLimit
                      ? `${p.capabilities.rateLimit.requestsPerRun} req/run, ${p.capabilities.rateLimit.minIntervalMs}ms apart`
                      : 'Unmetered'}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{p.health.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Recent polls</h2>
        {runs.length === 0 ? (
          <Empty title="No polls yet" hint="Press “Run poll now”." />
        ) : (
          <div className="card table-scroll">
            <table>
              <thead>
                <tr><th>Started</th><th>Search</th><th>Provider</th><th>Result</th><th>Seen</th><th>New</th><th>Events</th><th>Requests</th><th>Canary</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{r.startedAt.toLocaleString('en-US')}</td>
                    <td>{r.search?.name ?? '—'}</td>
                    <td>{humanize(r.providerId)}</td>
                    <td className={r.status === 'SUCCESS' ? 'good' : r.status === 'FAILED' ? 'bad' : undefined}>
                      {humanize(r.status)}
                      {r.errorMessage && <div className="muted" style={{ fontSize: 11 }}>{r.errorMessage}</div>}
                    </td>
                    <td>{r.listingsSeen}</td>
                    <td>{r.listingsNew}</td>
                    <td>{r.eventsCreated}</td>
                    <td>{r.requestsUsed}</td>
                    <td>{r.canaryOk ? <span className="good">OK</span> : <span className="bad" title={r.canaryReason ?? ''}>Warn</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, marginTop: 0 }}>About the data sources</h2>
        <p className="muted" style={{ marginBottom: 8 }}>
          <strong>Mock</strong> is the default and needs no credentials — it replays a
          deterministic three-run scenario so every feature here is exercisable offline.
        </p>
        <p className="muted" style={{ marginBottom: 8 }}>
          <strong>Zillow</strong> reads public, logged-out pages. It is off by default.
          Zillow&rsquo;s Terms of Use disallow automated access, and the site actively
          challenges automated requests, so treat it as best-effort: it stops at the first
          refusal rather than retrying, and never touches an account.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          <strong>CSV import</strong> is the durable fallback. Export a search yourself and
          drop the file in; it depends on nobody and cannot be blocked. It carries no
          open-house times, which is why the open-house column will be empty for it.
        </p>
      </section>
    </>
  );
}
