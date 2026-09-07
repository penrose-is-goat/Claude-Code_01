'use client';

import { useState } from 'react';
import type { SearchQuery, SearchOutcome } from '@/lib/search/types';
import { applyFilters, locationFingerprint } from '@/lib/search/applyFilters';
import { SearchForm } from './SearchForm';
import { SearchResults } from './SearchResults';
import { SavedSearchCard } from './SavedSearchCard';
import type { SavedSearchSummary } from './types';

/**
 * The dashboard is the empty state. Nothing renders here until a search runs — no
 * seeded listings, no stats, no default city. See CLAUDE.md / the PR description for
 * why: the previous build hardcoded Boulder ZIPs and showed data unasked, which the
 * user was right to reject.
 *
 * Filter re-apply is local. When the user changes only a filter and hits Search again,
 * we do NOT re-fetch — Zillow's Press & Hold challenge fires on every fresh fetch, and
 * the user was right that a min-price change should not cost three of them in a row. We
 * cache the raw fetched listings for the current location, run the new filters over them,
 * and only re-fetch when the *place* changes.
 */
export function Dashboard({ savedSearches }: { savedSearches: SavedSearchSummary[] }) {
  const [query, setQuery] = useState<SearchQuery | null>(null);
  // The full, unfiltered outcome from the last real fetch. What we filter locally against.
  const [rawOutcome, setRawOutcome] = useState<SearchOutcome | null>(null);
  // The fingerprint of the location that produced rawOutcome. Change the location → re-fetch.
  const [rawFingerprint, setRawFingerprint] = useState<string | null>(null);
  // The outcome the UI is currently showing (filtered from rawOutcome).
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [reappliedLocally, setReappliedLocally] = useState(false);

  async function runSearch(q: SearchQuery) {
    setError(null);
    setQuery(q);

    const fingerprint = locationFingerprint(q.location);
    // Same place as last time AND we already have listings for it → filter locally, no fetch.
    if (rawOutcome && rawFingerprint === fingerprint) {
      const filtered: SearchOutcome = {
        ...rawOutcome,
        listings: applyFilters(rawOutcome.listings, q.filters),
      };
      setOutcome(filtered);
      setReappliedLocally(true);
      return;
    }

    setLoading(true);
    setOutcome(null);
    setReappliedLocally(false);
    try {
      // Server-side, we want the raw list so it can be re-filtered without another fetch.
      // Send an empty filters object; the local applier owns filtering from here on.
      const fetchQuery: SearchQuery = { ...q, filters: {}, openHouseOnly: false };
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fetchQuery),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Search failed (HTTP ${res.status})`);
        return;
      }
      const raw = json as SearchOutcome;
      setRawOutcome(raw);
      setRawFingerprint(fingerprint);
      setOutcome({ ...raw, listings: applyFilters(raw.listings, q.filters) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function runSaved(s: SavedSearchSummary) {
    setRunningId(s.id);
    setLoading(true);
    setError(null);
    setOutcome(null);
    setReappliedLocally(false);
    setQuery(s.query);
    try {
      const res = await fetch(`/api/searches/${s.id}/run`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? `Search failed (HTTP ${res.status})`);
        return;
      }
      const raw = json as SearchOutcome;
      setRawOutcome(raw);
      setRawFingerprint(locationFingerprint(s.query.location));
      setOutcome({ ...raw, listings: applyFilters(raw.listings, s.query.filters) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
      setRunningId(null);
    }
  }

  const hasRun = query !== null;

  return (
    <div className={hasRun ? undefined : 'dashboard-hero'}>
      {!hasRun && (
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: '0 0 8px' }}>Find, save, and track homes near you</h1>
          <p className="muted" style={{ fontSize: 15, margin: 0 }}>
            Type a place or draw an area, and we&rsquo;ll pull what&rsquo;s for sale right now.
          </p>
        </div>
      )}

      <SearchForm onSubmit={runSearch} submitting={loading} compact={hasRun} />

      {error && (
        <div className="card" style={{ padding: 14, marginTop: 16, borderColor: 'var(--bad)' }}>
          <strong className="bad">Search failed</strong>
          <div className="muted" style={{ marginTop: 4 }}>{error}</div>
        </div>
      )}

      {loading && !outcome && (
        <div className="muted" style={{ marginTop: 16, textAlign: 'center' }}>Searching…</div>
      )}

      {reappliedLocally && outcome && (
        <div className="muted" style={{ fontSize: 12, marginTop: 10, textAlign: 'center' }}>
          Applied to your last search — no new fetch.
        </div>
      )}

      {outcome && query && <SearchResults outcome={outcome} query={query} />}

      {!hasRun && savedSearches.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Your saved searches</h2>
          <div className="saved-search-grid">
            {savedSearches.map((s) => (
              <SavedSearchCard key={s.id} search={s} onRun={() => runSaved(s)} running={runningId === s.id} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
