'use client';

import Link from 'next/link';
import type { SavedSearchSummary } from './types';
import { describeLocation } from './types';

export function SavedSearchCard({
  search, onRun, running,
}: { search: SavedSearchSummary; onRun: () => void; running: boolean }) {
  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <strong>{search.name}</strong>
        {!search.active && <span className="muted" style={{ fontSize: 11 }}>Paused</span>}
      </div>
      <span className="muted" style={{ fontSize: 12 }}>{describeLocation(search.query)}</span>
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <button type="button" onClick={onRun} disabled={running}>{running ? 'Searching…' : 'Run'}</button>
        <Link href="/searches" className="btn-link">Manage</Link>
      </div>
    </div>
  );
}
