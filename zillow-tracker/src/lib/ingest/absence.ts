/**
 * Delisting detection.
 *
 * The naive rule — "it wasn't in this poll, so it's gone" — is wrong and produces
 * constant false DELISTED events. A listing can vanish from a response because the
 * fetch partially failed, because pagination truncated, because the provider had a
 * blip, or because you changed the area's filters.
 *
 * So absence is treated as evidence, not proof, and we require it to accumulate.
 */

export const ABSENCE_RULES = {
  /**
   * If a run returns dramatically fewer listings than the run before it, we distrust the
   * whole run for delisting purposes. This is the guard against truncated responses,
   * which are the most common cause of mass false positives.
   */
  minCountRatio: 0.8,
  /** Consecutive trustworthy runs a listing must be missing from before we call it. */
  requiredConsecutiveMisses: 2,
} as const;

export interface RunContext {
  status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
  listingsSeen: number;
  previousListingsSeen: number | null;
  startedAt: Date;
}

/**
 * Can this run be trusted to say something is gone?
 *
 * Note the asymmetry: a run we don't trust for ABSENCE is still perfectly good for
 * everything it positively reports. A short run still tells the truth about the
 * listings it did return.
 */
export function runCanEvictListings(run: RunContext): boolean {
  if (run.status !== 'SUCCESS') return false;
  if (run.listingsSeen === 0) return false;
  if (run.previousListingsSeen == null) return true;
  if (run.previousListingsSeen === 0) return true;
  return run.listingsSeen / run.previousListingsSeen >= ABSENCE_RULES.minCountRatio;
}

export interface AbsenceDecision {
  missedRunCount: number;
  shouldMarkDelisted: boolean;
}

/**
 * Advance (or reset) a listing's absence counter for one run.
 *
 * `seenThisRun` resets the counter to zero — a listing that reappears has un-delisted
 * itself, and we want it to require the full two misses again before we act.
 */
export function evaluateAbsence(
  current: { missedRunCount: number; removedAt: Date | null },
  seenThisRun: boolean,
  run: RunContext,
): AbsenceDecision {
  if (seenThisRun) {
    return { missedRunCount: 0, shouldMarkDelisted: false };
  }
  if (!runCanEvictListings(run)) {
    return { missedRunCount: current.missedRunCount, shouldMarkDelisted: false };
  }

  const missedRunCount = current.missedRunCount + 1;
  const shouldMarkDelisted =
    current.removedAt == null &&
    missedRunCount >= ABSENCE_RULES.requiredConsecutiveMisses;

  return { missedRunCount, shouldMarkDelisted };
}

/**
 * Canary check: catch the failure mode where a source starts returning structurally
 * valid but empty/wrong data after an upstream change.
 *
 * A tracker that silently stops noticing price drops is worse than one that visibly
 * breaks, because you keep trusting it. So we alert on silence, not just on errors.
 */
export interface CanaryResult {
  ok: boolean;
  reason?: string;
}

export function checkCanary(opts: {
  listingsSeen: number;
  previousListingsSeen: number | null;
  /** sourceListingIds we have high confidence should appear in this area. */
  expectedSourceIds: string[];
  seenSourceIds: Set<string>;
}): CanaryResult {
  if (opts.listingsSeen === 0) {
    return { ok: false, reason: 'Run returned zero listings — source may have changed shape' };
  }

  if (
    opts.previousListingsSeen != null &&
    opts.previousListingsSeen >= 10 &&
    opts.listingsSeen / opts.previousListingsSeen < 0.5
  ) {
    return {
      ok: false,
      reason: `Run returned ${opts.listingsSeen}, down from ${opts.previousListingsSeen} — suspicious drop`,
    };
  }

  const missing = opts.expectedSourceIds.filter((id) => !opts.seenSourceIds.has(id));
  if (opts.expectedSourceIds.length > 0 && missing.length === opts.expectedSourceIds.length) {
    return {
      ok: false,
      reason: `None of ${missing.length} known-good canary listings were returned`,
    };
  }

  return { ok: true };
}
