'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Triggers a poll on demand — the "does this thing actually work" button. */
export function PollButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setMsg(null);
    try {
      const res = await fetch('/api/jobs/poll', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const totals = (json.results ?? []).reduce(
        (acc: { seen: number; events: number }, r: { listingsSeen: number; eventsCreated: number }) => ({
          seen: acc.seen + r.listingsSeen, events: acc.events + r.eventsCreated,
        }), { seen: 0, events: 0 },
      );
      setMsg(`Saw ${totals.seen} listings, ${totals.events} update(s)`);
      start(() => router.refresh());
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Poll failed');
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={run} disabled={pending}>{pending ? 'Polling…' : 'Run poll now'}</button>
      {msg && <span className="muted" style={{ fontSize: 12 }}>{msg}</span>}
    </span>
  );
}

export function MarkSeenButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  async function run() {
    await fetch('/api/events/seen', { method: 'POST' });
    start(() => router.refresh());
  }

  return (
    <button onClick={run} disabled={disabled || pending}>
      {pending ? 'Marking…' : 'Mark all seen'}
    </button>
  );
}

export function FavoriteButton({ listingId, initial }: { listingId: string; initial: boolean }) {
  const router = useRouter();
  const [fav, setFav] = useState(initial);
  const [, start] = useTransition();

  async function toggle() {
    const next = !fav;
    setFav(next); // optimistic — a favourite toggle should feel instant
    const res = await fetch(`/api/listings/${listingId}/favorite`, { method: 'POST' });
    if (!res.ok) setFav(!next);
    start(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      aria-pressed={fav}
      aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
      title={fav ? 'Remove from favorites' : 'Add to favorites'}
      style={{ color: fav ? '#e0a800' : 'var(--muted)', fontSize: 16, lineHeight: 1, padding: '4px 8px' }}
    >
      {fav ? '★' : '☆'}
    </button>
  );
}

const USER_STATUSES = ['NEW', 'WATCHING', 'TOURED', 'CONTACTED', 'REJECTED', 'OFFER'];

export function SavedNotesEditor({ listingId, initial }: {
  listingId: string;
  initial: { notes: string; rating: number | null; userStatus: string; tags: string[] };
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [, start] = useTransition();

  async function save() {
    setSaving(true);
    setSaved(false);
    await fetch(`/api/listings/${listingId}/saved`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    setSaving(false);
    setSaved(true);
    start(() => router.refresh());
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>My status</span>
        <select value={state.userStatus} onChange={(e) => setState({ ...state, userStatus: e.target.value })}>
          {USER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>Rating (1–5)</span>
        <select
          value={state.rating ?? ''}
          onChange={(e) => setState({ ...state, rating: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">—</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>Tags (comma separated)</span>
        <input
          value={state.tags.join(', ')}
          onChange={(e) => setState({ ...state, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          placeholder="good schools, needs work"
        />
      </label>

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="muted" style={{ fontSize: 12 }}>Notes</span>
        <textarea
          rows={5}
          value={state.notes}
          onChange={(e) => setState({ ...state, notes: e.target.value })}
          placeholder="Kitchen was smaller than the photos suggest…"
        />
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {saved && <span className="good" style={{ fontSize: 12 }}>Saved</span>}
      </div>
    </div>
  );
}
