import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  harvestArea, splitBounds, isDegenerate,
  type BoundsBox, type HarvestQuery,
} from '../../src/lib/providers/zillow/harvest';

/**
 * The market these tests run against is real: 1,737 for-sale homes in the DC / Silver
 * Spring metro, captured from Zillow's public map-search data through a signed-in
 * browser, with provenance recorded in the fixture itself. Only zpid and coordinates are
 * used — the harvester partitions on geometry and nothing else.
 *
 * Real coordinates matter here rather than being decoration. Subdivision is a response to
 * DENSITY, and a real metro's density is wildly uneven: a few dense cores inside a large
 * sparse area. Evenly scattered invented points would let a broken traversal pass.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/dc-metro-coordinates.json'), 'utf8'),
) as { homes: Array<{ zpid: string; lat: number; lng: number }> };

const HOMES = fixture.homes;

const AREA: BoundsBox = { north: 39.08, south: 38.92, east: -76.92, west: -77.12 };

/**
 * A stand-in for Zillow that enforces the constraint that makes subdivision necessary:
 * it will not serve past `pageCap` pages for one box, however many homes are inside.
 *
 * That cap is the entire problem. Without it a single query would return the market and
 * none of this code would need to exist.
 */
function fakeZillow(opts: { pageSize?: number; pageCap?: number } = {}) {
  const pageSize = opts.pageSize ?? 40;
  const pageCap = opts.pageCap ?? 20;
  let requests = 0;

  const inside = (b: BoundsBox) =>
    HOMES.filter((h) => h.lat <= b.north && h.lat > b.south && h.lng <= b.east && h.lng > b.west);

  const query: HarvestQuery = async (bounds, page) => {
    requests++;
    const all = inside(bounds);
    const truePages = Math.max(1, Math.ceil(all.length / pageSize));
    // Zillow reports the real page count even when it refuses to serve them all — which
    // is exactly what makes "too dense, split it" a decision we can read rather than guess.
    const servable = Math.min(page, pageCap);
    const slice = all.slice((servable - 1) * pageSize, servable * pageSize);
    return {
      results: slice.map((h) => ({ zpid: h.zpid, lat: h.lat, lng: h.lng })),
      total: all.length,
      totalPages: truePages,
    };
  };

  return { query, requests: () => requests, inside };
}

describe('splitBounds', () => {
  it('quarters a box into four pieces that tile it exactly', () => {
    const b: BoundsBox = { north: 10, south: 0, east: 20, west: 0 };
    const kids = splitBounds(b);
    expect(kids).toHaveLength(4);
    // Every child inside the parent.
    for (const k of kids) {
      expect(k.north).toBeLessThanOrEqual(b.north);
      expect(k.south).toBeGreaterThanOrEqual(b.south);
      expect(k.east).toBeLessThanOrEqual(b.east);
      expect(k.west).toBeGreaterThanOrEqual(b.west);
    }
    // Areas sum to the parent's: no overlap, no gap.
    const area = (x: BoundsBox) => (x.north - x.south) * (x.east - x.west);
    expect(kids.reduce((s, k) => s + area(k), 0)).toBeCloseTo(area(b), 9);
  });

  it('halves each dimension, the way the observed capture did', () => {
    const kids = splitBounds({ north: 39.0722, south: 38.9998, east: -77.024, west: -77.1173 });
    for (const k of kids) {
      expect(k.north - k.south).toBeCloseTo(0.0724 / 2, 3);
      expect(k.east - k.west).toBeCloseTo(0.0933 / 2, 3);
    }
  });

  it('recognises a collapsed box so it is never split forever', () => {
    expect(isDegenerate({ north: 1, south: 1, east: 2, west: 0 })).toBe(true);
    expect(isDegenerate({ north: 2, south: 1, east: 2, west: 0 })).toBe(false);
  });
});

describe('harvestArea', () => {
  it('recovers the whole market that a single un-subdivided box truncates', async () => {
    const expected = fakeZillow().inside(AREA).length;
    expect(expected).toBeGreaterThan(1_500); // the fixture really does cover this area

    // What the old code did: one box, paginate to the cap, stop.
    const flat = fakeZillow();
    const flatRows = [];
    for (let p = 1; p <= 20; p++) flatRows.push(...(await flat.query(AREA, p)).results);
    const flatFound = new Set(flatRows.map((r) => (r as { zpid: string }).zpid)).size;

    // What subdivision does.
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxPageReads: 500 });

    expect(report.stopReason).toBe('complete');
    expect(report.rows).toHaveLength(expected);
    expect(report.boxesSubdivided).toBeGreaterThan(0);
    // The point of the whole module: the flat scan cannot see the market, this can.
    expect(flatFound).toBeLessThan(expected);
    expect(report.rows.length).toBeGreaterThan(flatFound);
  });

  it('never returns the same home twice, however much the boxes overlap', async () => {
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxPageReads: 500 });
    const ids = report.rows.map((r) => (r as { zpid: string }).zpid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops subdividing at the depth limit and says the area may be incomplete', async () => {
    // maxDepth 0 forbids splitting at all, so the root box - far too dense to page
    // through - is the one that gets abandoned. (At maxDepth 1 the four children each
    // fit under the cap, so nothing is truncated and the harvest is genuinely complete;
    // that is the code being right, not the limit being untested.)
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxDepth: 0, maxPageReads: 500 });

    expect(report.boxesTruncated).toBeGreaterThan(0);
    expect(report.boxesSubdivided).toBe(0);
    // Page 1 of the abandoned box is still real data and is still returned.
    expect(report.rows.length).toBeGreaterThan(0);
    // And the harvest is honestly short of the market rather than claiming completeness.
    expect(report.rows.length).toBeLessThan(zillow.inside(AREA).length);
  });

  it('reports a complete harvest when one level of splitting is enough', async () => {
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxDepth: 1, maxPageReads: 500 });
    expect(report.boxesTruncated).toBe(0);
    expect(report.rows).toHaveLength(zillow.inside(AREA).length);
  });

  it('returns what it found when the request budget runs out', async () => {
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxPageReads: 5 });
    expect(report.stopReason).toBe('budget');
    expect(report.pageReads).toBeLessThanOrEqual(6);
    expect(report.rows.length).toBeGreaterThan(0);
  });

  it('returns what it found when the clock runs out', async () => {
    const slow: HarvestQuery = async (b, p) => {
      await new Promise((r) => setTimeout(r, 15));
      return fakeZillow().query(b, p);
    };
    const report = await harvestArea(slow, AREA, { deadlineMs: 120, maxPageReads: 500 });
    expect(report.stopReason).toBe('deadline');
    expect(report.rows.length).toBeGreaterThan(0);
  });

  it('stops promptly when the caller aborts, keeping what it had', async () => {
    const controller = new AbortController();
    const slow: HarvestQuery = async (b, p) => {
      await new Promise((r) => setTimeout(r, 10));
      return fakeZillow().query(b, p);
    };
    setTimeout(() => controller.abort(), 50);
    const report = await harvestArea(slow, AREA, { signal: controller.signal, maxPageReads: 500 });
    expect(report.stopReason).toBe('aborted');
    expect(report.rows.length).toBeGreaterThan(0);
  });

  it('keeps the homes from boxes that succeeded when one box errors', async () => {
    let n = 0;
    const flaky: HarvestQuery = async (b, p) => {
      // Fail one request in the middle; the rest of the traversal must survive it.
      if (++n === 3) throw new Error('challenge shown');
      return fakeZillow().query(b, p);
    };
    const report = await harvestArea(flaky, AREA, { maxPageReads: 500 });
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.error).toContain('challenge shown');
  });

  it('reports the source total so coverage can be stated honestly', async () => {
    const zillow = fakeZillow();
    const report = await harvestArea(zillow.query, AREA, { maxPageReads: 500 });
    expect(report.sourceTotal).toBeGreaterThan(0);
  });

  it('drops rows with no id rather than counting one home twice', async () => {
    const q: HarvestQuery = async () => ({
      results: [{ zpid: 'a' }, { nope: true }, { zpid: 'a' }],
      total: 3,
      totalPages: 1,
    });
    const report = await harvestArea(q, AREA);
    expect(report.rows).toHaveLength(1);
  });
});
