/**
 * Complete enumeration of a map area, by subdividing it until every piece fits.
 *
 * Zillow's search API answers a bounding box, and it will not page past a fixed number
 * of pages no matter how many homes are inside that box. So a single query over a dense
 * metro returns the cap and stops — silently, with no error and no gap marker. Asking a
 * whole county in one request and reporting what came back is how a market of 3,184
 * homes reads as a couple of hundred.
 *
 * The fix is the one Zillow's own web app uses when you zoom: when a box holds more than
 * pagination can reach, cut it into quadrants and ask each one. Recurse until every leaf
 * fits under the cap, and the union of the leaves is the whole market.
 *
 * Zillow states `totalPages` for every query, so the decision to split is read from its
 * own answer rather than guessed from how full a page looked.
 *
 * This module is deliberately free of Playwright: it takes a `query` function. That
 * keeps the traversal — the part with the arithmetic and the stopping conditions —
 * testable against a simulated market with a real page cap, which is the only way to
 * prove that subdivision actually recovers the homes a single box loses.
 */

export interface BoundsBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface HarvestQueryResult {
  results: unknown[];
  /** Zillow's own count for the whole box, when it reports one. */
  total?: number;
  /** Pages Zillow says exist for this box. The subdivision signal. */
  totalPages?: number;
}

/** One request for one box and one page. Supplied by the caller. */
export type HarvestQuery = (bounds: BoundsBox, page: number) => Promise<HarvestQueryResult>;

export interface HarvestOptions {
  /**
   * Pages the source will actually serve for one box. Past this, the only way to see
   * more homes is a smaller box. Zillow's is 20.
   */
  maxPagesPerBox?: number;
  /**
   * How many times a box may be quartered. A guard against a pathological area — a
   * single address with a thousand units — recursing forever. At depth 6 a metro-sized
   * box is already down to a few blocks.
   */
  maxDepth?: number;
  /** Hard ceiling on total requests, so a runaway traversal cannot spend the evening. */
  maxPageReads?: number;
  /**
   * Wall-clock ceiling. Same reasoning as the websearch sweep: whatever awaits this
   * gives up eventually, and a partial harvest returned is worth more than a complete
   * one thrown away. 0 disables it.
   */
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Pulls the stable id out of a row. Rows without one cannot be deduplicated. */
  idOf?: (row: unknown) => string | null;
  onProgress?: (p: { pageReads: number; found: number; boxes: number }) => void;
}

export interface HarvestReport {
  /** Every distinct row found, in discovery order. */
  rows: unknown[];
  pageReads: number;
  /** Leaves that were enumerated to completion. */
  boxesCompleted: number;
  /** Boxes too dense to page through, which were quartered instead. */
  boxesSubdivided: number;
  /** Boxes abandoned at the depth limit — the honest marker of a possible gap. */
  boxesTruncated: number;
  /** The largest total the source reported, i.e. its own claim about the market. */
  sourceTotal?: number;
  stopReason: 'complete' | 'deadline' | 'budget' | 'aborted' | 'error';
  /** Set when the traversal ended on an error rather than a limit. */
  error?: string;
}

const DEFAULTS = {
  maxPagesPerBox: 20,
  maxDepth: 6,
  maxPageReads: 400,
  deadlineMs: 0,
};

/** Quarters a box. The four pieces tile it exactly — no overlap, no gap. */
export function splitBounds(b: BoundsBox): BoundsBox[] {
  const midLat = (b.north + b.south) / 2;
  const midLng = (b.east + b.west) / 2;
  return [
    { north: b.north, south: midLat, west: b.west, east: midLng },
    { north: b.north, south: midLat, west: midLng, east: b.east },
    { north: midLat, south: b.south, west: b.west, east: midLng },
    { north: midLat, south: b.south, west: midLng, east: b.east },
  ];
}

/** True when a box has collapsed to a point, which would make splitting pointless. */
export function isDegenerate(b: BoundsBox): boolean {
  return !(b.north > b.south) || !(b.east > b.west);
}

export async function harvestArea(
  query: HarvestQuery,
  area: BoundsBox,
  opts: HarvestOptions = {},
): Promise<HarvestReport> {
  const maxPagesPerBox = opts.maxPagesPerBox ?? DEFAULTS.maxPagesPerBox;
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;
  const maxPageReads = opts.maxPageReads ?? DEFAULTS.maxPageReads;
  const deadlineMs = opts.deadlineMs ?? DEFAULTS.deadlineMs;
  const deadlineAt = deadlineMs > 0 ? Date.now() + deadlineMs : Infinity;
  const idOf = opts.idOf ?? defaultIdOf;

  const byId = new Map<string, unknown>();
  const order: string[] = [];
  let pageReads = 0;
  let boxesCompleted = 0;
  let boxesSubdivided = 0;
  let boxesTruncated = 0;
  let sourceTotal: number | undefined;
  let stop: HarvestReport['stopReason'] | undefined;
  let errorMessage: string | undefined;

  const halted = (): boolean => {
    if (stop) return true;
    if (opts.signal?.aborted) stop = 'aborted';
    else if (Date.now() >= deadlineAt) stop = 'deadline';
    else if (pageReads >= maxPageReads) stop = 'budget';
    return stop !== undefined;
  };

  const keep = (rows: unknown[]): void => {
    for (const row of rows) {
      const id = idOf(row);
      // A row with no id cannot be deduplicated. Keeping it would double-count the same
      // home across two overlapping requests, so it is dropped rather than guessed at.
      if (!id || byId.has(id)) continue;
      byId.set(id, row);
      order.push(id);
    }
  };

  // Explicit stack rather than recursion: the traversal has to be interruptible at every
  // step, and an unwound call stack cannot report what it had already found.
  const stack: Array<{ box: BoundsBox; depth: number }> = [{ box: area, depth: 0 }];

  while (stack.length > 0) {
    if (halted()) break;
    const { box, depth } = stack.pop()!;

    let first: HarvestQueryResult;
    try {
      pageReads++;
      first = await query(box, 1);
    } catch (err) {
      // One box failing is not the harvest failing — the homes already found in other
      // boxes are real and are kept. The reason is reported rather than swallowed.
      errorMessage = err instanceof Error ? err.message : String(err);
      continue;
    }

    keep(first.results);
    if (typeof first.total === 'number') {
      sourceTotal = Math.max(sourceTotal ?? 0, first.total);
    }
    opts.onProgress?.({ pageReads, found: byId.size, boxes: boxesCompleted });

    const totalPages = first.totalPages ?? 1;

    // Too dense to page through: the only way to see the rest is a smaller box. Page 1's
    // rows are kept regardless — they are real homes, and discarding them because their
    // box was crowded is how a harvest loses data it already paid for.
    if (totalPages > maxPagesPerBox) {
      if (depth < maxDepth && !isDegenerate(box)) {
        boxesSubdivided++;
        for (const child of splitBounds(box)) stack.push({ box: child, depth: depth + 1 });
      } else {
        // Out of depth. Recorded, so the report can say the area may be incomplete
        // instead of implying it was fully covered.
        boxesTruncated++;
      }
      continue;
    }

    // Fits. Page through the rest of it.
    for (let p = 2; p <= Math.min(totalPages, maxPagesPerBox); p++) {
      if (halted()) break;
      try {
        pageReads++;
        const next = await query(box, p);
        keep(next.results);
        opts.onProgress?.({ pageReads, found: byId.size, boxes: boxesCompleted });
      } catch (err) {
        errorMessage = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    boxesCompleted++;
  }

  return {
    rows: order.map((id) => byId.get(id)!),
    pageReads,
    boxesCompleted,
    boxesSubdivided,
    boxesTruncated,
    sourceTotal,
    stopReason: stop ?? (errorMessage && byId.size === 0 ? 'error' : 'complete'),
    error: errorMessage,
  };
}

function defaultIdOf(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const zpid = (row as { zpid?: unknown }).zpid;
  if (typeof zpid === 'string' && zpid) return zpid;
  if (typeof zpid === 'number' && Number.isFinite(zpid)) return String(zpid);
  return null;
}
