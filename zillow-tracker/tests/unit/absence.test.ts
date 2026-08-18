import { describe, it, expect } from 'vitest';
import { runCanEvictListings, evaluateAbsence, checkCanary, type RunContext } from '@/lib/ingest/absence';

const run = (over: Partial<RunContext> = {}): RunContext => ({
  status: 'SUCCESS', listingsSeen: 40, previousListingsSeen: 40, startedAt: new Date(), ...over,
});

describe('runCanEvictListings', () => {
  it('trusts a healthy successful run', () => {
    expect(runCanEvictListings(run())).toBe(true);
  });

  it('never trusts a failed or partial run', () => {
    expect(runCanEvictListings(run({ status: 'FAILED' }))).toBe(false);
    expect(runCanEvictListings(run({ status: 'PARTIAL' }))).toBe(false);
    expect(runCanEvictListings(run({ status: 'RUNNING' }))).toBe(false);
  });

  it('distrusts a run that returned nothing', () => {
    expect(runCanEvictListings(run({ listingsSeen: 0 }))).toBe(false);
  });

  it('distrusts a truncated run — the mass-false-positive guard', () => {
    expect(runCanEvictListings(run({ listingsSeen: 20, previousListingsSeen: 40 }))).toBe(false);
  });

  it('accepts a run right at the ratio threshold', () => {
    expect(runCanEvictListings(run({ listingsSeen: 32, previousListingsSeen: 40 }))).toBe(true);
  });

  it('trusts the very first run, which has no baseline', () => {
    expect(runCanEvictListings(run({ previousListingsSeen: null }))).toBe(true);
  });
});

describe('evaluateAbsence', () => {
  const present = { missedRunCount: 0, removedAt: null };

  it('resets the counter when the listing is seen', () => {
    expect(evaluateAbsence({ missedRunCount: 1, removedAt: null }, true, run()))
      .toEqual({ missedRunCount: 0, shouldMarkDelisted: false });
  });

  it('does not delist on a single miss', () => {
    expect(evaluateAbsence(present, false, run()))
      .toEqual({ missedRunCount: 1, shouldMarkDelisted: false });
  });

  it('delists on the second consecutive miss', () => {
    expect(evaluateAbsence({ missedRunCount: 1, removedAt: null }, false, run()))
      .toEqual({ missedRunCount: 2, shouldMarkDelisted: true });
  });

  it('does not advance the counter on an untrustworthy run', () => {
    const decision = evaluateAbsence({ missedRunCount: 1, removedAt: null }, false, run({ status: 'FAILED' }));
    expect(decision).toEqual({ missedRunCount: 1, shouldMarkDelisted: false });
  });

  it('does not re-delist something already delisted', () => {
    const decision = evaluateAbsence({ missedRunCount: 5, removedAt: new Date() }, false, run());
    expect(decision.shouldMarkDelisted).toBe(false);
  });

  it('a reappearance fully resets, requiring two fresh misses again', () => {
    let state = { missedRunCount: 1, removedAt: null as Date | null };
    state = { ...state, missedRunCount: evaluateAbsence(state, true, run()).missedRunCount };
    expect(state.missedRunCount).toBe(0);
    expect(evaluateAbsence(state, false, run()).shouldMarkDelisted).toBe(false);
  });
});

describe('checkCanary', () => {
  it('passes a normal run', () => {
    expect(checkCanary({
      listingsSeen: 40, previousListingsSeen: 42, expectedSourceIds: [], seenSourceIds: new Set(),
    }).ok).toBe(true);
  });

  it('flags a zero-result run as a likely schema break', () => {
    const r = checkCanary({ listingsSeen: 0, previousListingsSeen: 40, expectedSourceIds: [], seenSourceIds: new Set() });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zero listings/);
  });

  it('flags a suspicious collapse in volume', () => {
    expect(checkCanary({
      listingsSeen: 5, previousListingsSeen: 40, expectedSourceIds: [], seenSourceIds: new Set(),
    }).ok).toBe(false);
  });

  it('flags when every known-good canary listing vanished', () => {
    const r = checkCanary({
      listingsSeen: 30, previousListingsSeen: 30,
      expectedSourceIds: ['a', 'b'], seenSourceIds: new Set(['x']),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/canary/);
  });

  it('passes when at least one canary is present', () => {
    expect(checkCanary({
      listingsSeen: 30, previousListingsSeen: 30,
      expectedSourceIds: ['a', 'b'], seenSourceIds: new Set(['a']),
    }).ok).toBe(true);
  });

  it('does not flag small absolute numbers as a collapse', () => {
    expect(checkCanary({
      listingsSeen: 3, previousListingsSeen: 8, expectedSourceIds: [], seenSourceIds: new Set(),
    }).ok).toBe(true);
  });
});
