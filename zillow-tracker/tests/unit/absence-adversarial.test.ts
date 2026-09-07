import { describe, it, expect } from 'vitest';
import {
  runCanEvictListings, evaluateAbsence, checkCanary, ABSENCE_RULES, type RunContext,
} from '@/lib/ingest/absence';

/**
 * Adversarial probes of the delisting rules.
 *
 * The module's own docstring states the goal: "absence is treated as evidence, not
 * proof" so that truncated responses, provider blips and filter changes do not produce
 * false DELISTED events. These tests drive multi-run sequences at that claim.
 */

/**
 * Replays a sequence of runs exactly the way pipeline.pollArea does:
 *   - previousListingsSeen = listingsSeen of the previous run
 *   - every listing tracked for the area is fed through evaluateAbsence
 */
function replay(runs: Array<{ present: string[]; status?: RunContext['status'] }>, tracked: string[]) {
  const state = new Map(tracked.map((id) => [id, { missedRunCount: 0, removedAt: null as Date | null }]));
  const delistedIn: Array<string[]> = [];
  let previousListingsSeen: number | null = null;
  const recent: number[] = [];

  runs.forEach((r, i) => {
    const ctx: RunContext = {
      status: r.status ?? 'SUCCESS',
      listingsSeen: r.present.length,
      previousListingsSeen,
      recentListingsSeen: [...recent],
      // Mirrors pollArea: canary ids are drawn from listings we already track, so a run
      // that returns none of them fails the canary.
      canaryOk: tracked.length === 0 || tracked.some((id) => r.present.includes(id)),
      startedAt: new Date(2026, 0, 1, i),
    };
    const delisted: string[] = [];
    for (const [id, cur] of state) {
      const d = evaluateAbsence(cur, r.present.includes(id), ctx);
      cur.missedRunCount = d.missedRunCount;
      if (d.shouldMarkDelisted) {
        cur.removedAt = ctx.startedAt;
        delisted.push(id);
      }
    }
    delistedIn.push(delisted);
    // pipeline records listingsSeen for SUCCESS runs; the next run compares against it.
    if (ctx.status === 'SUCCESS') {
      previousListingsSeen = r.present.length;
      recent.unshift(r.present.length);
      recent.splice(5); // same window pollArea uses
    }
  });

  return { state, delistedIn };
}

const ids = (n: number, prefix = 'L') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// ---------------------------------------------------------------------------
// A1 — the truncation guard only looks one run back, so a truncation that
// persists becomes the new baseline and mass false delisting follows.
// ---------------------------------------------------------------------------
describe('A1 a sustained truncation defeats the minCountRatio guard', () => {
  it('BUG: 100 listings, provider truncates to the first 50 from run 2 on — 50 false DELISTED', () => {
    const all = ids(100);
    const half = all.slice(0, 50);
    const { delistedIn } = replay(
      [{ present: all }, { present: half }, { present: half }, { present: half }],
      all,
    );

    // run 2 is correctly distrusted (50/100 = 0.5)...
    expect(delistedIn[1]).toEqual([]);
    // ...but run 3 compares 50 against run 2's 50, ratio 1.0, so it is trusted, and
    // run 4 reaches the two-miss threshold. Every one of the 50 still-for-sale homes
    // gets a "No longer listed" event and disappears from the default listing view.
    expect(delistedIn[2].length + delistedIn[3].length).toBe(0);
  });

  it('BUG: same failure from fetchAll()\'s silent 20-page cap or from editing an area filter', () => {
    // absence.ts names both of these as the cases it exists to protect against.
    const all = ids(40);
    const kept = all.slice(0, 30); // an area filter change drops 10 listings permanently
    const { delistedIn } = replay(
      [{ present: all }, { present: kept }, { present: kept }, { present: kept }],
      all,
    );
    expect(delistedIn.flat()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2 — the ratio boundary itself.
// ---------------------------------------------------------------------------
describe('A2 the 0.8 boundary', () => {
  it('OK: exactly 0.8 is trusted, a hair under is not', () => {
    const at = (seen: number, prev: number): RunContext =>
      ({ status: 'SUCCESS', listingsSeen: seen, previousListingsSeen: prev, startedAt: new Date() });
    expect(runCanEvictListings(at(80, 100))).toBe(true);
    expect(runCanEvictListings(at(79, 100))).toBe(false);
    expect(ABSENCE_RULES.minCountRatio).toBe(0.8);
  });

  it('BUG: a run that GREW is trusted even when its growth hides a swap-out', () => {
    // 100 -> 200 listings passes the ratio trivially, but if the provider silently
    // switched to a neighbouring market the 100 originals are all "absent" and trusted.
    const orig = ids(100);
    const other = ids(200, 'X');
    const { delistedIn } = replay([{ present: orig }, { present: other }, { present: other }], orig);
    expect(delistedIn.flat()).toEqual([]);
  });

  it('OK: a one-run blip never delists anything', () => {
    const all = ids(50);
    const { delistedIn } = replay(
      [{ present: all }, { present: all.slice(0, 10) }, { present: all }, { present: all }],
      all,
    );
    expect(delistedIn.flat()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A3 — missedRunCount / removedAt interaction.
// ---------------------------------------------------------------------------
describe('A3 missedRunCount and removedAt', () => {
  it('OK: an already-removed listing is not re-delisted', () => {
    const d = evaluateAbsence(
      { missedRunCount: 5, removedAt: new Date() }, false,
      { status: 'SUCCESS', listingsSeen: 40, previousListingsSeen: 40, startedAt: new Date() },
    );
    expect(d.shouldMarkDelisted).toBe(false);
  });

  it('OK: an isolated blip does not accumulate — being seen resets the counter', () => {
    // Run 1 truncates (untrusted, counter frozen at 0). Run 2 recovers fully.
    // The listing is present in every run except two unrelated single-run blips —
    // but because `seenThisRun` is the only thing that resets the counter and the
    // counter never expires, absences separated by weeks still accumulate...
    const all = ids(20);
    const target = 'L0';
    const withoutTarget = all.filter((x) => x !== target);
    const { state } = replay(
      [
        { present: all },
        { present: withoutTarget },      // blip 1 -> counter 1
        { present: all }, { present: all }, { present: all }, // present for 3 runs
        { present: all },
      ],
      all,
    );
    // This one is handled correctly: being seen resets the counter.
    expect(state.get(target)!.missedRunCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A4 — the canary.
// ---------------------------------------------------------------------------
describe('A4 canary', () => {
  it('BUG: pipeline.pollArea always passes expectedSourceIds: [] so the canary check is dead', () => {
    // checkCanary's docstring calls the known-good-ids check the point of the canary,
    // but the only caller hardcodes an empty list, leaving only the zero/50% heuristics.
    const r = checkCanary({
      listingsSeen: 40, previousListingsSeen: 40,
      expectedSourceIds: [], seenSourceIds: new Set(['nothing-we-expected']),
    });
    expect(r.ok).toBe(false);
  });

  it('BUG: small areas get no drop-detection at all (the check needs prev >= 10)', () => {
    const r = checkCanary({
      listingsSeen: 4, previousListingsSeen: 9,
      expectedSourceIds: [], seenSourceIds: new Set(),
    });
    expect(r.ok).toBe(false); // previousListingsSeen must be >= 10 to trip the check
  });

  it('OK: a partial canary miss is tolerated but a total miss is flagged', () => {
    const base = { listingsSeen: 40, previousListingsSeen: 40 };
    expect(checkCanary({ ...base, expectedSourceIds: ['a', 'b'], seenSourceIds: new Set(['a']) }).ok).toBe(true);
    expect(checkCanary({ ...base, expectedSourceIds: ['a', 'b'], seenSourceIds: new Set() }).ok).toBe(false);
  });
});
