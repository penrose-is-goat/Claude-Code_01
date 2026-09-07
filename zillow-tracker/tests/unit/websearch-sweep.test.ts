import { describe, expect, it, vi } from 'vitest';
import type { SearchBackend } from '../../src/lib/providers/websearch/backends';
import { resolveBackend } from '../../src/lib/providers/websearch/backends';
import {
  planFacetQueries, planStreetQueries, sweep, type SweepTarget,
} from '../../src/lib/providers/websearch/sweep';
import { toSweepTarget } from '../../src/lib/providers/websearch';
import type { SearchResult } from '../../src/lib/providers/websearch/parse';

const TARGET: SweepTarget = { city: 'Boulder', state: 'CO' };
const NOW = () => new Date('2026-08-21T12:00:00Z');

/**
 * A backend that answers from a table and counts calls. This is a test double for the
 * TRANSPORT — the network — not for the data: every assertion below is about the
 * sweep's own logic (budget, dedupe, coverage arithmetic), which is exactly the logic a
 * live run cannot be trusted to exercise deterministically.
 */
function fakeBackend(table: Record<string, SearchResult[]>, opts: { fail?: string } = {}) {
  const calls: string[] = [];
  const backend: SearchBackend = {
    id: 'fake',
    displayName: 'fake',
    setupHint: '',
    isConfigured: () => true,
    async search(query) {
      calls.push(query);
      if (opts.fail && query.includes(opts.fail)) throw new Error('backend exploded');
      return table[query] ?? matchBySubstring(table, query);
    },
  };
  return { backend, calls };
}

/** Lets a fixture key on a distinguishing fragment instead of a whole query string. */
function matchBySubstring(table: Record<string, SearchResult[]>, query: string): SearchResult[] {
  // Longest matching key wins. Otherwise `~homes for sale` fires on every query that
  // also matches a more specific key like `~2 beds homes for sale`, which was the
  // hidden reason the fixture-driven tests kept coming back empty.
  const hits = Object.entries(table)
    .filter(([key]) => key.startsWith('~'))
    .filter(([key]) => query.includes(key.slice(1)))
    .sort((a, b) => b[0].length - a[0].length);
  return hits.length > 0 ? hits[0][1] : [];
}

function home(zpid: string, address: string, price: number): SearchResult {
  return {
    url: `https://www.zillow.com/homedetails/${address.replace(/\s+/g, '-')}-Boulder-CO-80302/${zpid}_zpid/`,
    title: `${address}, Boulder, CO 80302 | MLS #${zpid} | Zillow`,
    description: `Zillow has 5 photos of this $${price.toLocaleString('en-US')} 3 beds, 2 baths, ` +
      `1,800 Square Feet single family home located at ${address}, Boulder, CO 80302 built in 1998.`,
  };
}

describe('sweep', () => {
  it('reports coverage against the count Zillow publishes, not against its own harvest', async () => {
    const { backend } = fakeBackend({
      '~homes for sale': [
        {
          url: 'https://www.zillow.com/boulder-co/houses/',
          title: 'Boulder CO Single Family Homes For Sale - 406 Homes | Zillow',
        },
      ],
      '~2 beds homes for sale': [home('1', '100 Pearl St', 900000)],
      '~3 beds homes for sale': [home('2', '200 Pearl St', 950000)],
    });

    const report = await sweep(backend, TARGET, { queryBudget: 40, minIntervalMs: 0, now: NOW });

    expect(report.coverage).toMatchObject({ found: 2, published: 406, scope: 'Boulder CO Single Family Homes For Sale' });
    // The honest reading of a thin harvest: a tiny ratio, stated, rather than "2 homes".
    expect(report.coverage!.ratio).toBeCloseTo(2 / 406, 6);
  });

  it('measures against the searched city, not the larger county that also publishes a count', async () => {
    const { backend } = fakeBackend({
      '~homes for sale': [
        {
          url: 'https://www.zillow.com/boulder-county-co/houses/',
          title: 'Boulder County CO Single Family Homes For Sale - 1042 Homes | Zillow',
        },
        {
          url: 'https://www.zillow.com/boulder-co/houses/',
          title: 'Boulder CO Single Family Homes For Sale - 406 Homes | Zillow',
        },
      ],
      '~2 beds homes for sale': [home('1', '100 Pearl St', 900000)],
    });

    const report = await sweep(backend, TARGET, { queryBudget: 40, minIntervalMs: 0, now: NOW });
    expect(report.coverage?.published).toBe(406);
    expect(report.coverage?.scope).toContain('Boulder CO');
  });

  it('leaves coverage undefined rather than implying completeness when no count was published', async () => {
    const { backend } = fakeBackend({ '~2 beds homes for sale': [home('1', '100 Pearl St', 900000)] });
    const report = await sweep(backend, TARGET, { queryBudget: 8, minIntervalMs: 0, now: NOW });
    expect(report.coverage).toBeUndefined();
    expect(report.listings).toHaveLength(1);
  });

  it('deduplicates the same home found through different slices', async () => {
    const duplicate = home('88908043', '1655 Walnut St', 1470000);
    const { backend } = fakeBackend({
      '~2 beds homes for sale': [duplicate],
      '~3 beds homes for sale': [duplicate],
      '~single family home for sale': [duplicate],
    });

    const report = await sweep(backend, TARGET, { queryBudget: 40, minIntervalMs: 0, now: NOW });
    expect(report.listings).toHaveLength(1);
    // Overlap is expected and is the evidence a slice was covered — the later queries
    // must report zero NEW listings rather than being suppressed.
    const productive = report.queries.filter((q) => q.newListings > 0);
    expect(productive).toHaveLength(1);
  });

  it('never exceeds the query budget', async () => {
    // A table that yields a new street from every query, so phase 3 would run forever.
    const { backend, calls } = fakeBackend({
      '~': [home('9', '900 Endless Ave', 100000)],
    });
    const report = await sweep(backend, TARGET, { queryBudget: 5, minIntervalMs: 0, now: NOW });
    expect(report.queriesSpent).toBe(5);
    expect(calls).toHaveLength(5);
  });

  it('discovers Zillow neighborhoods and ZIPs and slices by them', async () => {
    const { backend, calls } = fakeBackend({
      '~open houses': [
        {
          url: 'https://www.zillow.com/central-boulder-boulder-co/open-house/',
          title: 'Central Boulder Boulder Open Houses - 26 Upcoming | Zillow',
        },
        {
          url: 'https://www.zillow.com/boulder-co-80304/open-house/',
          title: '80304 Open Houses - 13 Upcoming | Zillow',
        },
      ],
    });

    await sweep(backend, TARGET, { queryBudget: 30, minIntervalMs: 0, now: NOW });

    expect(calls.some((q) => q.includes('Central Boulder Boulder'))).toBe(true);
    expect(calls.some((q) => q.includes('Boulder, CO 80304'))).toBe(true);
  });

  it('sweeps streets discovered from harvested addresses', async () => {
    const { backend, calls } = fakeBackend({
      '~3 beds': [home('1', '1655 Walnut St', 900000)],
    });
    const report = await sweep(backend, TARGET, { queryBudget: 25, minIntervalMs: 0, now: NOW });

    expect(calls.some((q) => q.includes('Walnut St') && q.includes('Boulder, CO'))).toBe(true);
    expect(report.queriesSpent).toBeLessThanOrEqual(25);
  });

  it('records a failing query without sinking the sweep', async () => {
    const { backend } = fakeBackend({ '~3 beds': [home('1', '100 Pearl St', 900000)] }, { fail: '2 beds' });
    const report = await sweep(backend, TARGET, { queryBudget: 40, minIntervalMs: 0, now: NOW });

    expect(report.queries.some((q) => q.error === 'backend exploded')).toBe(true);
    expect(report.listings).toHaveLength(1);
  });

  it('counts why results were dropped instead of discarding them silently', async () => {
    const { backend } = fakeBackend({
      '~2 beds': [
        home('1', '100 Pearl St', 900000),
        {
          url: 'https://www.zillow.com/homedetails/2300-75th-St-Boulder-CO-80301/13185000_zpid/',
          title: '2300 75th St, Boulder, CO 80301 | Zillow',
          description: 'Zillow has 25 photos of this 4 beds, 3 baths, 2,800 Square Feet home.',
        },
        { url: 'https://www.redfin.com/x', title: 'somewhere else' },
      ],
    });

    const report = await sweep(backend, TARGET, { queryBudget: 6, minIntervalMs: 0, now: NOW });
    const reasons = Object.keys(report.dropped).join(' | ');
    expect(reasons).toMatch(/not for sale/);
    expect(reasons).toMatch(/off-site|unrecognized/);
  });

  it('reports progress as it goes so a long sweep is not a black box', async () => {
    const { backend } = fakeBackend({ '~2 beds homes for sale': [home('1', '100 Pearl St', 900000)] });
    const onProgress = vi.fn();
    await sweep(backend, TARGET, { queryBudget: 4, minIntervalMs: 0, now: NOW, onProgress });
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)![0]).toMatchObject({ queryBudget: 4 });
  });
});

describe('planFacetQueries', () => {
  it('partitions by Zillow area when one was discovered, by city when none was', () => {
    expect(planFacetQueries(TARGET).every((q) => q.includes('Boulder, CO'))).toBe(true);

    const withAreas = planFacetQueries({ ...TARGET, postalCodes: ['80302'] });
    // With discovered ZIPs, every query mentions the ZIP rather than the bare city.
    expect(withAreas.some((q) => q.includes('Boulder, CO 80302'))).toBe(true);
    expect(withAreas.some((q) => /Boulder, CO(?![\s\d])/.test(q))).toBe(false);
  });

  it('switches to open-house queries when that is what was asked for', () => {
    const q = planFacetQueries(TARGET, { openHouseOnly: true });
    expect(q.every((s) => s.includes('open house'))).toBe(true);
  });

  it('generates only plain-English queries — no site: operator', () => {
    // A person searching Zillow does not type `site:zillow.com/homedetails`, and using
    // it strips the aggregator snippets that carry open-house times and price/beds
    // information. Every query should read like something a person would type.
    for (const q of [...planFacetQueries(TARGET), ...planStreetQueries(TARGET, ['Walnut St'])]) {
      expect(q, q).not.toContain('site:');
      expect(q, q).toContain('zillow');
    }
  });
});

describe('toSweepTarget', () => {
  it('uses a resolved city and state directly', () => {
    expect(toSweepTarget({ kind: 'cityRadius', city: 'Boulder', state: 'CO', radiusMiles: 5 }))
      .toEqual({ city: 'Boulder', state: 'CO' });
  });

  it('falls back to a place hint for a drawn shape the user named', () => {
    expect(toSweepTarget({ kind: 'bbox', minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }, 'Boulder, CO'))
      .toEqual({ city: 'Boulder', state: 'CO' });
  });

  it('says plainly that an unnamed drawn shape cannot be searched for', () => {
    expect(() => toSweepTarget({ kind: 'polygon', ring: [[0, 0], [1, 1], [0, 1]] }))
      .toThrow(/name the area/i);
  });
});

describe('resolveBackend', () => {
  const unconfigured: SearchBackend = {
    id: 'x', displayName: 'X', setupHint: 'Set X_KEY.',
    isConfigured: () => false, search: async () => [],
  };

  it('returns setup instructions rather than an empty result set', () => {
    const { backend, hints } = resolveBackend([unconfigured], undefined);
    expect(backend).toBeNull();
    expect(hints.join(' ')).toContain('Set X_KEY.');
  });

  it('honours an explicit override and complains about an unknown one', () => {
    expect(resolveBackend([unconfigured], 'nope').hints[0]).toMatch(/not a known backend/);
  });
});

/**
 * The stopping conditions the completeness engine adds.
 *
 * A sweep that stops at the budget when the market is actually covered wastes queries;
 * a sweep that never stops when every axis is dry burns them on nothing. Each end
 * condition here is what the report shows the user, so testing it is testing the truth
 * the report tells.
 */
describe('stopReason — the sweep knows why it ended', () => {
  // zpids must be numeric — parseHomedetailsUrl requires it. A base offset per prefix
  // keeps zpids unique across calls so successive queries don't collide on identity.
  let seq = 1;
  const homes = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => {
    const zpid = 100000 + seq * 1000 + i; seq++;
    return {
      url: `https://www.zillow.com/homedetails/${1 + i}-${prefix}-St-Boulder-CO-80302/${zpid}_zpid/`,
      title: `${1 + i} ${prefix} St, Boulder, CO 80302 | MLS #${zpid} | Zillow`,
      description: `Zillow has 3 photos of this $500,000 3 beds, 2 baths, 1,500 Square Feet single family home located at ${1 + i} ${prefix} St.`,
    };
  });

  it('reports "coverage" when the harvest reaches Zillow\'s published count', async () => {
    const { backend } = fakeBackend({
      '~homes for sale': [{
        url: 'https://www.zillow.com/boulder-co/houses/',
        title: 'Boulder CO Single Family Homes For Sale - 10 Homes | Zillow',
      }],
      '~2 beds homes for sale': homes(10, 'Peach'),
    });
    const report = await sweep(backend, TARGET, { queryBudget: 30, minIntervalMs: 0, now: NOW });
    expect(report.stopReason).toBe('coverage');
    expect(report.coverage!.ratio).toBeGreaterThanOrEqual(0.95);
  });

  it('reports "exhausted" when several queries in a row add nothing', async () => {
    // Only one query has any homes; the rest return duplicates or nothing. After a
    // dry streak the sweep stops rather than keep asking.
    const { backend } = fakeBackend({ '~2 beds homes for sale': homes(3, 'Peach') });
    const report = await sweep(backend, TARGET, { queryBudget: 40, minIntervalMs: 0, now: NOW });
    expect(report.stopReason).toBe('exhausted');
    // And it stopped well before the budget — proving the exit fired for the right reason.
    expect(report.queriesSpent).toBeLessThan(40);
  });

  it('reports "budget" only when there is real work left', async () => {
    // Every query returns fresh homes until the budget expires, so nothing else can end
    // the loop.
    let counter = 0;
    const backend = {
      id: 'productive', displayName: 'productive', setupHint: '', isConfigured: () => true,
      async search() {
        counter++;
        return homes(10, `Round${counter}`);
      },
    } satisfies SearchBackend;

    const report = await sweep(backend, TARGET, { queryBudget: 8, minIntervalMs: 0, now: NOW });
    expect(report.stopReason).toBe('budget');
    expect(report.queriesSpent).toBe(8);
  });
});

/**
 * The failure these cover is the one that made the app look broken: a sweep bounded only
 * by a query COUNT runs for minutes, the caller awaiting it gives up, and every home
 * already found dies with the request. "Times out after only a few results."
 *
 * A slow backend is the honest way to test it — the delay is in the transport, exactly
 * where real latency lives, and the assertions are all about the sweep returning its
 * accumulated harvest instead of nothing.
 */
function slowBackend(perCallMs: number, results: (n: number) => SearchResult[]) {
  let calls = 0;
  const backend: SearchBackend = {
    id: 'slow',
    displayName: 'slow',
    setupHint: '',
    isConfigured: () => true,
    async search() {
      calls++;
      await new Promise((r) => setTimeout(r, perCallMs));
      return results(calls);
    },
  };
  return { backend, calls: () => calls };
}

describe('sweep — time budget', () => {
  it('returns the homes it already found when the clock runs out, instead of nothing', async () => {
    // Each query costs 20ms and yields one distinct home; a 120ms deadline can only
    // afford a handful of the 40 the budget would otherwise allow.
    const { backend } = slowBackend(20, (n) => [home(String(n), `${n} Pearl St`, 900000)]);

    const report = await sweep(backend, TARGET, {
      queryBudget: 40,
      minIntervalMs: 0,
      deadlineMs: 120,
      now: NOW,
    });

    expect(report.stopReason).toBe('deadline');
    // The point of the whole change: a short harvest, not an empty one.
    expect(report.listings.length).toBeGreaterThan(0);
    // And it genuinely stopped early rather than running the full budget.
    expect(report.queriesSpent).toBeLessThan(40);
  });

  it('does not let the between-query wait outlive the deadline', async () => {
    // A 10s interval against a 150ms deadline: the old code would sleep the full
    // interval and blow through the deadline by two orders of magnitude.
    const { backend } = slowBackend(5, (n) => [home(String(n), `${n} Pearl St`, 900000)]);

    const startedAt = Date.now();
    const report = await sweep(backend, TARGET, {
      queryBudget: 40,
      minIntervalMs: 10_000,
      deadlineMs: 150,
      now: NOW,
    });
    const elapsed = Date.now() - startedAt;

    expect(report.stopReason).toBe('deadline');
    expect(elapsed).toBeLessThan(2_000);
  });

  it('stops promptly when the caller aborts, and still reports what it found', async () => {
    const { backend } = slowBackend(10, (n) => [home(String(n), `${n} Pearl St`, 900000)]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const startedAt = Date.now();
    const report = await sweep(backend, TARGET, {
      queryBudget: 40,
      // A long interval proves the sleep itself is abort-aware: without that, aborting
      // would not be felt until the full interval elapsed.
      minIntervalMs: 5_000,
      deadlineMs: 0,
      signal: controller.signal,
      now: NOW,
    });
    const elapsed = Date.now() - startedAt;

    expect(report.stopReason).toBe('aborted');
    expect(elapsed).toBeLessThan(2_000);
    expect(report.listings.length).toBeGreaterThan(0);
  });

  it('runs to completion when the deadline is disabled, for a CLI harvest', async () => {
    const { backend } = fakeBackend({
      '~homes for sale': [home('1', '100 Pearl St', 900000)],
    });

    const report = await sweep(backend, TARGET, {
      queryBudget: 6,
      minIntervalMs: 0,
      deadlineMs: 0,
      now: NOW,
    });

    // No deadline means the old stopping conditions still decide, unchanged.
    expect(['budget', 'exhausted', 'coverage']).toContain(report.stopReason);
  });
});
