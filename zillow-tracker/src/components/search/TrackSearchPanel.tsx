'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchQuery } from '@/lib/search/types';
import { CADENCE_OPTIONS, describeLocation } from './types';

/** Posted to POST /api/searches, which maps 1:1 onto `SavedSearchInput` (lib/search/types.ts). */
export function TrackSearchPanel({ query, onDone }: { query: SearchQuery; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(describeLocation(query));
  const [cron, setCron] = useState<string | null>(null);
  const [notifyOnNew, setNotifyOnNew] = useState(true);
  const [notifyOnPriceDrop, setNotifyOnPriceDrop] = useState(true);
  const [notifyOnOpenHouse, setNotifyOnOpenHouse] = useState(true);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    if (!name.trim()) {
      setResult({ ok: false, message: 'Give this search a name.' });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch('/api/searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          query,
          cron,
          notifyOnNew,
          notifyOnPriceDrop,
          notifyOnOpenHouse,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ ok: false, message: json?.error ?? `Could not save (HTTP ${res.status})` });
        return;
      }
      setResult({ ok: true, message: 'Saved — it will show on the dashboard from now on.' });
      router.refresh();
      setTimeout(onDone, 900);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: 14, display: 'grid', gap: 10 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Downtown, 3+ beds" />
      </label>

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 11 }}>Refresh</span>
        <select value={cron ?? ''} onChange={(e) => setCron(e.target.value || null)}>
          {CADENCE_OPTIONS.map((c) => (
            <option key={c.label} value={c.cron ?? ''}>{c.label}</option>
          ))}
        </select>
      </label>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnNew} onChange={(e) => setNotifyOnNew(e.target.checked)} style={{ width: 'auto' }} />
          New listings
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnPriceDrop} onChange={(e) => setNotifyOnPriceDrop(e.target.checked)} style={{ width: 'auto' }} />
          Price drops
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnOpenHouse} onChange={(e) => setNotifyOnOpenHouse(e.target.checked)} style={{ width: 'auto' }} />
          Open houses
        </label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save search'}</button>
        {result && (
          <span role="status" className={result.ok ? 'good' : 'bad'} style={{ fontSize: 12 }}>{result.message}</span>
        )}
      </div>
    </div>
  );
}
