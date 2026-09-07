'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';

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
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  // Seeding useState once meant the star could not be corrected by a refresh — saving a
  // note creates the SavedListing row as a favorite, so the star kept claiming "not
  // favorited" while /saved listed it, and its label offered the opposite of what it did.
  useEffect(() => {
    setFav(initial);
  }, [initial]);

  async function toggle() {
    const next = !fav;
    setFav(next); // optimistic — a star should feel instant
    setError(null);
    try {
      const res = await fetch(`/api/listings/${listingId}/favorite`, { method: 'POST' });
      if (!res.ok) {
        setFav(!next);
        // A silent revert is indistinguishable from a mis-click, so the user just
        // clicks again and gets the same nothing.
        setError('Could not update');
        return;
      }
      start(() => router.refresh());
    } catch {
      setFav(!next);
      setError('Could not update');
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={toggle}
        aria-pressed={fav}
        aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
        title={fav ? 'Remove from favorites' : 'Add to favorites'}
        style={{ color: fav ? '#e0a800' : 'var(--muted)', fontSize: 16, lineHeight: 1, padding: '4px 8px' }}
      >
        {fav ? '★' : '☆'}
      </button>
      {error && <span className="bad" role="status" style={{ fontSize: 11 }}>{error}</span>}
    </span>
  );
}

const USER_STATUSES = ['NEW', 'WATCHING', 'TOURED', 'CONTACTED', 'REJECTED', 'OFFER'];

export function SavedNotesEditor({ listingId, initial }: {
  listingId: string;
  initial: { notes: string; rating: number | null; userStatus: string; tags: string[] };
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  /**
   * The tags input keeps its RAW text.
   *
   * Deriving the field's value from `tags.join(', ')` while re-parsing on every keystroke
   * deleted the comma the instant it was typed — "alpha, beta" became "alphabeta" — so
   * the comma-separated format the placeholder asks for was impossible to type. Parsing
   * happens once, on save.
   */
  const [tagsText, setTagsText] = useState(initial.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [, start] = useTransition();

  const parsedTags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);

  async function save() {
    setSaving(true);
    setResult(null);

    const payload = { ...state, tags: parsedTags };

    try {
      const res = await fetch(`/api/listings/${listingId}/saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);

      // Reporting "Saved" without checking the response meant a rejected save looked
      // identical to a successful one — and because all four fields travel together, one
      // over-long tag silently discarded the notes, rating and status too.
      if (!res.ok) {
        setResult({
          ok: false,
          message: json?.error ? `Not saved: ${json.error}` : `Not saved (HTTP ${res.status})`,
        });
        return;
      }

      setState({ ...state, tags: parsedTags });
      setResult({ ok: true, message: 'Saved' });
      start(() => router.refresh());
    } catch (err) {
      setResult({
        ok: false,
        message: `Not saved: ${err instanceof Error ? err.message : 'request failed'}`,
      });
    } finally {
      setSaving(false);
    }
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
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="good schools, needs work"
          aria-describedby="tags-hint"
        />
        <span id="tags-hint" className="muted" style={{ fontSize: 11 }}>
          {parsedTags.length} tag{parsedTags.length === 1 ? '' : 's'}
          {parsedTags.some((t) => t.length > 60) && ' — one is over the 60-character limit'}
        </span>
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

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        {result && (
          <span
            role="status"
            className={result.ok ? 'good' : 'bad'}
            style={{ fontSize: 12, fontWeight: result.ok ? 400 : 600 }}
          >
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}
