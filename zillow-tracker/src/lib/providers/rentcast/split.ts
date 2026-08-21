/**
 * Recursive area splitting.
 *
 * The technique comes from scrapers of Zillow's internal map API: ask for a rectangle,
 * and if the answer comes back at the per-query cap you know it was truncated, so split
 * the rectangle and ask again for each piece. Repeat until every piece answers below the
 * cap. A depth bound stops a dense city from subdividing until the budget is gone.
 *
 * The important part is the trigger, and it is worth being precise about why it works:
 * a response AT the cap is not evidence that the area holds exactly that many homes, it
 * is evidence that the count is unknown and at least that large. Splitting is how an
 * unknown becomes known. A response below the cap is a complete answer for that area and
 * needs no split — which is what keeps this from being an exhaustive grid crawl.
 *
 * RentCast searches circles rather than rectangles, so the split covers a circle with
 * four smaller circles instead of four quadrants. Same recursion, different shape.
 */

export interface Circle {
  lat: number;
  lng: number;
  radiusMiles: number;
}

/** Miles per degree of latitude. Constant enough at any latitude for this purpose. */
const MILES_PER_DEG_LAT = 69.0;

/**
 * Four circles that together cover the parent.
 *
 * The parent's bounding square has side 2r. Cutting it into four squares of side r and
 * circumscribing each takes radius r·√2/2 ≈ 0.707r, centred at (±r/2, ±r/2). The union
 * covers the parent completely, with deliberate overlap at the seams: a home exactly on
 * a boundary must land in at least one child, and a duplicate is free to remove while a
 * gap is invisible.
 */
export function splitCircle(c: Circle): Circle[] {
  const childRadius = (c.radiusMiles * Math.SQRT2) / 2;
  const offsetMiles = c.radiusMiles / 2;

  const dLat = offsetMiles / MILES_PER_DEG_LAT;
  // Longitude degrees shrink toward the poles. Ignoring this makes children too narrow
  // at high latitude and opens real gaps between them.
  const cosLat = Math.cos((c.lat * Math.PI) / 180);
  const dLng = offsetMiles / (MILES_PER_DEG_LAT * Math.max(cosLat, 0.01));

  return [
    { lat: c.lat + dLat, lng: c.lng - dLng, radiusMiles: childRadius },
    { lat: c.lat + dLat, lng: c.lng + dLng, radiusMiles: childRadius },
    { lat: c.lat - dLat, lng: c.lng - dLng, radiusMiles: childRadius },
    { lat: c.lat - dLat, lng: c.lng + dLng, radiusMiles: childRadius },
  ];
}

export interface SplitSearchOptions<T> {
  /** Fetch everything the source will give for one circle, already paginated. */
  fetch: (circle: Circle) => Promise<T[]>;
  /** Stable identity, so overlap between children collapses instead of duplicating. */
  keyOf: (item: T) => string;
  /**
   * The per-query result cap. A response of exactly this size is treated as truncated.
   * Getting this wrong in the safe direction (too low) costs queries; too high silently
   * accepts truncated answers as complete, so it must match the source's real cap.
   */
  cap: number;
  /** How many times a circle may be subdivided. 0 disables splitting. */
  maxLevel: number;
  /** Ceiling on total fetches, so a pathological area cannot run forever. */
  maxRequests: number;
  onProgress?: (p: { requests: number; found: number; level: number }) => void;
  signal?: AbortSignal;
}

export interface SplitSearchResult<T> {
  items: T[];
  requests: number;
  /** Circles that came back at the cap and could not be split further. */
  truncated: Circle[];
  /** Deepest level reached. */
  maxLevelReached: number;
}

/**
 * Searches a circle, splitting wherever the source truncates.
 *
 * `truncated` is the honest part: any circle still at the cap when the depth or request
 * budget ran out is reported, not silently dropped. That is the difference between "here
 * is the market" and "here is the market except these four neighbourhoods, which I could
 * not finish" — and the caller can surface the second rather than implying the first.
 */
export async function splitSearch<T>(
  root: Circle,
  opts: SplitSearchOptions<T>,
): Promise<SplitSearchResult<T>> {
  const byKey = new Map<string, T>();
  const truncated: Circle[] = [];
  let requests = 0;
  let maxLevelReached = 0;

  const queue: Array<{ circle: Circle; level: number }> = [{ circle: root, level: 0 }];

  while (queue.length > 0) {
    if (requests >= opts.maxRequests) {
      // Everything still queued is unexplored; report it rather than pretending it was
      // covered. These are areas, not failures, and the caller says so.
      truncated.push(...queue.map((q) => q.circle));
      break;
    }
    opts.signal?.throwIfAborted();

    const { circle, level } = queue.shift()!;
    maxLevelReached = Math.max(maxLevelReached, level);

    const items = await opts.fetch(circle);
    requests++;

    for (const item of items) byKey.set(opts.keyOf(item), item);
    opts.onProgress?.({ requests, found: byKey.size, level });

    // Below the cap, this circle is fully answered and needs no children.
    if (items.length < opts.cap) continue;

    if (level >= opts.maxLevel) {
      truncated.push(circle);
      continue;
    }
    for (const child of splitCircle(circle)) queue.push({ circle: child, level: level + 1 });
  }

  return { items: [...byKey.values()], requests, truncated, maxLevelReached };
}
