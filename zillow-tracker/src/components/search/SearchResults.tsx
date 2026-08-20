'use client';

import { useState } from 'react';
import type { SearchOutcome } from '@/lib/search/types';
import { usd, humanize, formatOpenHouse, StatusBadge } from '@/components/ui';
import { TrackSearchPanel } from './TrackSearchPanel';
import type { SearchQuery } from '@/lib/search/types';

export function SearchResults({ outcome, query }: { outcome: SearchOutcome; query: SearchQuery }) {
  const [showTrack, setShowTrack] = useState(false);

  const placeLabel = outcome.resolved
    ? query.location.kind === 'place'
      ? `Showing homes within ${query.location.radiusMiles} mile${query.location.radiusMiles === 1 ? '' : 's'} of ${outcome.resolved.displayName}`
      : `Showing homes in ${outcome.resolved.displayName}`
    : query.location.kind === 'drawn'
      ? 'Showing homes inside the area you drew'
      : null;

  return (
    <div style={{ marginTop: 20, display: 'grid', gap: 14 }}>
      {placeLabel && (
        <div className="card" style={{ padding: '10px 14px', fontSize: 13 }}>
          {placeLabel}
        </div>
      )}

      {outcome.allProvidersFailed ? (
        // Critical: never say "no homes found" here — that reads as a fact about the
        // market when it is actually a fact about our data source being down, and the
        // user would act on the lie by concluding nothing is for sale.
        <div className="card" style={{ padding: 16, borderColor: 'var(--bad)' }}>
          <strong className="bad">The data source couldn&rsquo;t be reached</strong>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            Every provider failed, so this is not "no homes" — it&rsquo;s "we don&rsquo;t know yet."
          </p>
          <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
            {outcome.providers.map((p) => (
              <li key={p.providerId} className="muted" style={{ fontSize: 13 }}>
                <strong>{humanize(p.providerId)}:</strong> {p.message ?? 'failed'}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="muted" style={{ fontSize: 13 }}>
              {outcome.listings.length} home{outcome.listings.length === 1 ? '' : 's'} found
            </span>
            <button type="button" onClick={() => setShowTrack((s) => !s)}>
              {showTrack ? 'Cancel' : 'Track this search'}
            </button>
          </div>

          {showTrack && <TrackSearchPanel query={query} onDone={() => setShowTrack(false)} />}

          {outcome.listings.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ fontWeight: 600 }}>No homes matched</div>
              <div className="muted" style={{ marginTop: 6 }}>
                The search ran successfully — the source just doesn&rsquo;t have anything matching right now.
                Try a wider radius or looser filters.
              </div>
            </div>
          ) : (
            <div className="listing-grid">
              {outcome.listings.map((l, i) => {
                const nextOh = l.openHouses[0];
                return (
                  <a
                    key={`${l.providerId}-${l.sourceListingId}-${i}`}
                    href={l.listingUrl ?? undefined}
                    target={l.listingUrl ? '_blank' : undefined}
                    rel={l.listingUrl ? 'noopener noreferrer' : undefined}
                    className="card listing-card"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 700 }}>{usd(l.listPrice)}</span>
                      <StatusBadge status={l.status} />
                    </div>
                    <div style={{ marginTop: 4 }}>{l.addressLine1}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{l.city}, {l.state} {l.postalCode}</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                      {[l.beds != null && `${l.beds} bd`, l.bathsTotal != null && `${l.bathsTotal} ba`, l.livingAreaSqft != null && `${l.livingAreaSqft.toLocaleString()} sqft`]
                        .filter(Boolean)
                        .join(' · ') || humanize(l.propertyType)}
                    </div>
                    {nextOh && (
                      <div className="good" style={{ fontSize: 12, marginTop: 6, fontWeight: 600 }}>
                        Open house: {formatOpenHouse(nextOh.startsAt, nextOh.endsAt, nextOh.timezone)}
                      </div>
                    )}
                  </a>
                );
              })}
            </div>
          )}

          <div className="muted" style={{ fontSize: 11 }}>
            {outcome.providers.map((p) => (
              <span key={p.providerId} style={{ marginRight: 12 }}>
                {humanize(p.providerId)}: {p.ok ? `${p.count} result${p.count === 1 ? '' : 's'}` : `failed (${p.message ?? 'unknown error'})`}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
