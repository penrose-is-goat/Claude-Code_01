'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { SearchQuery, SearchLocation } from '@/lib/search/types';
import type { ListingFilters } from '@/lib/providers/types';
import { humanize } from '@/components/ui';
import { PROPERTY_TYPES } from './types';

// Leaflet touches `window` at import time, so the map only ever loads in the browser.
const DrawMap = dynamic(() => import('./DrawMap'), {
  ssr: false,
  loading: () => <div className="muted" style={{ padding: 16 }}>Loading map…</div>,
});

const RADIUS_OPTIONS = [1, 2, 5, 10, 20, 50];

export interface SearchFormProps {
  onSubmit: (query: SearchQuery) => void;
  submitting?: boolean;
  submitLabel?: string;
  /** Compact mode for the top-of-page bar once results already exist. */
  compact?: boolean;
}

/**
 * The search box IS the app. Filters live here — as inputs to the query — rather than
 * as a client-side filter over an already-fetched list, which is what the user
 * explicitly rejected as "terrible" about the previous build.
 */
export function SearchForm({ onSubmit, submitting, submitLabel = 'Search', compact }: SearchFormProps) {
  const [mode, setMode] = useState<'place' | 'drawn'>('place');
  const [placeText, setPlaceText] = useState('');
  const [radiusMiles, setRadiusMiles] = useState(5);
  const [ring, setRing] = useState<Array<[number, number]>>([]);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minBeds, setMinBeds] = useState('');
  const [minBaths, setMinBaths] = useState('');
  const [propertyTypes, setPropertyTypes] = useState<string[]>([]);
  const [openHouseOnly, setOpenHouseOnly] = useState(false);
  const [showFilters, setShowFilters] = useState(!compact);
  const [error, setError] = useState<string | null>(null);

  const hasDrawn = ring.length >= 3;
  const canSubmit = mode === 'place' ? placeText.trim().length > 0 : hasDrawn;

  function togglePropertyType(t: string) {
    setPropertyTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!canSubmit) {
      setError(mode === 'place' ? 'Type a city, neighborhood, or address.' : 'Draw a polygon with at least 3 points.');
      return;
    }

    const location: SearchLocation =
      mode === 'place'
        ? { kind: 'place', query: placeText.trim(), radiusMiles }
        : { kind: 'drawn', ring };

    const filters: ListingFilters = {
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      minBeds: minBeds ? Number(minBeds) : undefined,
      minBaths: minBaths ? Number(minBaths) : undefined,
      propertyTypes: propertyTypes.length ? (propertyTypes as ListingFilters['propertyTypes']) : undefined,
      openHouseOnly: openHouseOnly || undefined,
    };

    onSubmit({ location, filters, openHouseOnly });
  }

  return (
    <form onSubmit={handleSubmit} className="card search-form" style={{ padding: compact ? 14 : 24 }}>
      <div className="search-mode-tabs">
        <button
          type="button"
          className={mode === 'place' ? 'search-tab search-tab-active' : 'search-tab'}
          onClick={() => setMode('place')}
        >
          City or address
        </button>
        <button
          type="button"
          className={mode === 'drawn' ? 'search-tab search-tab-active' : 'search-tab'}
          onClick={() => setMode('drawn')}
        >
          Draw on map
        </button>
      </div>

      {mode === 'place' ? (
        <div className="search-place-row">
          <input
            value={placeText}
            onChange={(e) => setPlaceText(e.target.value)}
            placeholder="City, neighborhood, or address"
            aria-label="City, neighborhood, or address"
            className="search-place-input"
          />
          <label className="search-radius-field">
            <span className="muted" style={{ fontSize: 11 }}>Within</span>
            <select value={radiusMiles} onChange={(e) => setRadiusMiles(Number(e.target.value))}>
              {RADIUS_OPTIONS.map((r) => (
                <option key={r} value={r}>{r} mi</option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <DrawMap onRingChange={(r) => setRing(r ?? [])} />
          <span className="muted" style={{ fontSize: 12 }}>
            {hasDrawn ? `Polygon with ${ring.length} points` : 'Draw a polygon on the map to search inside it.'}
          </span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowFilters((s) => !s)}
        className="btn-link"
        style={{ marginTop: 12, fontSize: 12 }}
      >
        {showFilters ? 'Hide filters' : 'Filters'}
      </button>

      {showFilters && (
        <div className="search-filters">
          <Field label="Min price"><input type="number" min="0" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} style={{ width: 110 }} /></Field>
          <Field label="Max price"><input type="number" min="0" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} style={{ width: 110 }} /></Field>
          <Field label="Beds"><input type="number" min="0" value={minBeds} onChange={(e) => setMinBeds(e.target.value)} style={{ width: 70 }} /></Field>
          <Field label="Baths"><input type="number" min="0" step="0.5" value={minBaths} onChange={(e) => setMinBaths(e.target.value)} style={{ width: 70 }} /></Field>
          <div className="search-type-chips">
            {PROPERTY_TYPES.map((t) => (
              <label key={t} className={propertyTypes.includes(t) ? 'chip chip-active' : 'chip'}>
                <input
                  type="checkbox"
                  checked={propertyTypes.includes(t)}
                  onChange={() => togglePropertyType(t)}
                  style={{ display: 'none' }}
                />
                {humanize(t)}
              </label>
            ))}
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={openHouseOnly} onChange={(e) => setOpenHouseOnly(e.target.checked)} style={{ width: 'auto' }} />
            <span style={{ fontSize: 13 }}>Open house only</span>
          </label>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <button type="submit" className="search-submit" disabled={submitting}>
          {submitting ? 'Searching…' : submitLabel}
        </button>
        {error && <span className="bad" role="alert" style={{ fontSize: 12 }}>{error}</span>}
      </div>
    </form>
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
