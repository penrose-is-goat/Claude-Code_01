'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SavedSearchSummary } from './types';
import { CADENCE_OPTIONS, describeLocation } from './types';

export function SavedSearchRow({ search }: { search: SavedSearchSummary }) {
  const router = useRouter();
  const [name, setName] = useState(search.name);
  const [cron, setCron] = useState<string | null>(search.pollCron ?? null);
  const [notifyOnNew, setNotifyOnNew] = useState(search.notifyOnNew);
  const [notifyOnPriceDrop, setNotifyOnPriceDrop] = useState(search.notifyOnPriceDrop);
  const [notifyOnOpenHouse, setNotifyOnOpenHouse] = useState(search.notifyOnOpenHouse);
  const [active, setActive] = useState(search.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/searches/${search.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? `Could not save (HTTP ${res.status})`);
        return false;
      }
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/searches/${search.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(json?.error ?? `Could not delete (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== search.name && patch({ name: name.trim() })}
          style={{ fontWeight: 700, fontSize: 15, border: 'none', background: 'transparent', padding: '2px 0', minWidth: 200 }}
        />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={active}
            disabled={busy}
            onChange={async (e) => {
              const next = e.target.checked;
              setActive(next);
              const ok = await patch({ active: next });
              if (!ok) setActive(!next);
            }}
            style={{ width: 'auto' }}
          />
          Active
        </label>
      </div>

      <span className="muted" style={{ fontSize: 12 }}>{describeLocation(search.query)}</span>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="muted" style={{ fontSize: 11 }}>Refresh</span>
          <select
            value={cron ?? ''}
            disabled={busy}
            onChange={async (e) => {
              const next = e.target.value || null;
              setCron(next);
              patch({ cron: next });
            }}
          >
            {CADENCE_OPTIONS.map((c) => (
              <option key={c.label} value={c.cron ?? ''}>{c.label}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnNew} disabled={busy} onChange={(e) => { setNotifyOnNew(e.target.checked); patch({ notifyOnNew: e.target.checked }); }} style={{ width: 'auto' }} />
          New listings
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnPriceDrop} disabled={busy} onChange={(e) => { setNotifyOnPriceDrop(e.target.checked); patch({ notifyOnPriceDrop: e.target.checked }); }} style={{ width: 'auto' }} />
          Price drops
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={notifyOnOpenHouse} disabled={busy} onChange={(e) => { setNotifyOnOpenHouse(e.target.checked); patch({ notifyOnOpenHouse: e.target.checked }); }} style={{ width: 'auto' }} />
          Open houses
        </label>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span className="muted" style={{ fontSize: 11 }}>
          {search.lastRunAt ? `Last ran ${new Date(search.lastRunAt).toLocaleString('en-US')}` : 'Never run yet'}
        </span>
        {confirmDelete ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="bad" style={{ fontSize: 12 }}>Delete this search?</span>
            <button type="button" onClick={del} disabled={busy}>Yes, delete</button>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>
        )}
      </div>

      {error && <span className="bad" role="alert" style={{ fontSize: 12 }}>{error}</span>}
    </div>
  );
}
