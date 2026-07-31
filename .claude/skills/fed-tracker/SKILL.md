---
name: fed-tracker
description: Build or update a Fed rate tracker (like CME FedWatch or Investing.com's Fed Rate Monitor) that computes FOMC rate-change probabilities from 30-Day Fed Fund futures prices. Use when asked to add/modify Fed rate probability features, FOMC meeting odds, or fed funds futures analysis.
---

# Fed Rate Tracker Skill

How to build a CME FedWatch-style tool that computes the market-implied
probabilities of Fed rate changes at upcoming FOMC meetings.

## Core Methodology (same as CME FedWatch)

### 1. The instrument
30-Day Fed Fund futures (CME ticker ZQ) settle at `100 - average daily
effective federal funds rate (EFFR) for the contract month`.

So: `implied avg rate for month M = 100 - futures price for month M`

### 2. Months WITHOUT an FOMC meeting
The implied rate for that month IS the expected fed funds rate for the whole
month (no meeting = no change possible). These months anchor the calculation.

### 3. Months WITH an FOMC meeting
Prefer the CLEAN READ: if the month AFTER the meeting has no FOMC meeting,
that month's implied average IS the expected post-meeting rate. Store the
FULL monthly contract strip (not just meeting months) to enable this.

Only when the next month also has a meeting, split the meeting month:
```
impliedAvg = (d_before/N) * rateStart + (d_after/N) * rateEnd
rateEnd = (N * impliedAvg - d_before * rateStart) / d_after
```
- `N` = days in month, `d_before` = days up to and including meeting day,
  `d_after` = N - d_before, `rateStart` = chained expected rate going in.

WARNING: for meetings late in the month (e.g. the 27th), d_after is tiny
(3-4 days) and the split solve amplifies price noise into wild rate swings.
That is exactly why the clean next-month read must take priority - CME does
the same.

### 4. Converting expected rate to probabilities
The Fed moves in 25bp increments. IMPORTANT: the bucket grid must be anchored
at the CURRENT target-range midpoint (e.g. 4.375 for a 4.25-4.50% range), not
at absolute 0.25 multiples - possible outcomes are currentMid + k*0.25.

```
k     = floor((rateEnd - currentMid) / 0.25)
lower = currentMid + k * 0.25          // a valid target-range midpoint
upper = lower + 0.25                   // the next midpoint up
p(upper) = (rateEnd - lower) / 0.25
p(lower) = 1 - p(upper)
```

Label each midpoint as its range: mid 4.375 -> "4.25-4.50%".

For multi-meeting horizons, chain a BINOMIAL TREE on the 25bp grid so
distributions widen for later meetings (like real FedWatch):

```
dist = {0: 1}                       // key = 25bp steps from current mid
for each meeting (expected rates E_1..E_n, E_0 = current mid):
  move = E_i - E_{i-1}
  newDist = {}
  for (k, p) of dist:
    target = currentMid + k*0.25 + move
    kf = floor((target - currentMid)/0.25); frac = (target - (currentMid+kf*0.25))/0.25
    newDist[kf]   += p * (1-frac)
    newDist[kf+1] += p * frac
  dist = newDist                    // meeting i's outcome distribution
```
Meeting 1 reduces to the simple two-bucket split; meeting 4+ shows 3-5
buckets. Verify every meeting's distribution sums to exactly 1.

### 5. Current target range
The Fed targets a 25bp RANGE (e.g. 4.25-4.50%). The EFFR sits near the
midpoint. Display probabilities as target-range buckets, e.g. "425-450".

## Data sources (in preference order)

1. **Manual/stored futures prices** - always works, no key. Store prices for
   the next 8-12 monthly ZQ contracts. Prices change slowly enough for
   educational use; refresh when the user updates them.
2. **CME FedWatch API** - official, $25/month, JSON REST, not CORS-friendly.
3. **Scraping** - blocked by CORS in browsers; do not rely on it.

For a static/browser app: ship with recent futures prices as demo data,
provide a UI for the user to update prices manually, and show probabilities
computed client-side. Label the data date clearly.

## FOMC meeting dates

Hardcode the published FOMC calendar (fed publishes 2 years ahead at
federalreserve.gov/monetarypolicy/fomccalendars.htm). Store as
`[{date:'YYYY-MM-DD'}, ...]`. Only the SECOND day of each 2-day meeting
matters (decision day).

2025 remaining + 2026 decision days (update as Fed publishes):
- 2025: Jan 29, Mar 19, May 7, Jun 18, Jul 30, Sep 17, Oct 29, Dec 10
- 2026: Jan 28, Mar 18, Apr 29, Jun 17, Jul 29, Sep 16, Oct 28, Dec 9

## Reference implementation

```javascript
function fedProbabilities(cfg) {
  // cfg: { currentRateMid, meetings:[{date, futuresPrice, prevMonthPrice}] }
  const results = [];
  let rateStart = cfg.currentRateMid;             // e.g. 4.375 for 4.25-4.50%
  for (const m of cfg.meetings) {
    const d = new Date(m.date + 'T12:00:00Z');
    const N = new Date(d.getUTCFullYear(), d.getUTCMonth()+1, 0).getDate();
    const dBefore = d.getUTCDate();               // days at old rate
    const dAfter = N - dBefore;
    const impliedAvg = 100 - m.futuresPrice;
    let rateEnd;
    if (dAfter === 0) rateEnd = impliedAvg;       // meeting on last day
    else rateEnd = (N * impliedAvg - dBefore * rateStart) / dAfter;
    // Map to 25bp buckets anchored at current target midpoint
    const k = Math.floor((rateEnd - cfg.currentRateMid) / 0.25);
    const lower = cfg.currentRateMid + k * 0.25;
    const upper = lower + 0.25;
    const pUpper = Math.min(Math.max((rateEnd - lower) / 0.25, 0), 1);
    results.push({
      date: m.date, expectedRate: rateEnd,
      buckets: [
        { level: lower, prob: 1 - pUpper },
        { level: upper, prob: pUpper }
      ],
      changeFromCurrent: rateEnd - cfg.currentRateMid
    });
    rateStart = rateEnd;                          // chain to next meeting
  }
  return results;
}
```

## Display conventions (blend of CME + Investing.com)

The layout blends both references deliberately:
1. **Summary strip** (top): current target range, next FOMC date with
   countdown, market-consensus stat ("81% probability of 25bp cut"),
   data-as-of tile.
2. **CME-style selected meeting** (main card): meeting tab selector
   (each tab shows date + days + E[rate]); vertical bar HISTOGRAM of the
   probability distribution (bars colored green=cut / blue=hold /
   red=hike, animated height); CME-style TABLE underneath: target range |
   move tag | horizontal probability bar | percent.
3. **Investing.com-style all-meetings matrix** (second card): one table,
   rows = every FOMC meeting, columns = union of target ranges sorted
   descending, cells = probability with heat-colored background (alpha
   scales with probability, hue = move direction). All meetings visible in
   ONE scroll - no clicking between graphs.
4. **Inputs card**: current-target-range dropdown + editable full contract
   strip (each row tagged with its FOMC meeting or "no meeting");
   everything recomputes on change. Mark unpublished meeting dates with *
   as tentative.

## Testing the math

Validate with a known example: if EFFR = 4.33%, meeting on the 17th of a
30-day month, futures at 95.75 (implied 4.25%):
rateEnd = (30*4.25 - 17*4.33)/13 = (127.5 - 73.61)/13 = 4.145
-> between 4.00 and 4.25 -> p(4.25) = (4.145-4.0)/0.25 = 58%, p(4.00) = 42%
Meaning: ~58% chance rates hold near current, 42% chance of a 25bp cut.

## Integration notes for Portfolio Analyzer Pro

- Add as new module `PA.FedTracker` in app-core.js or its own script section.
- New tab "Fed Tracker" in the tab bar + panel in build.sh HTML.
- Store futures prices + FOMC dates in the `settings` table (JSON blob) so
  user edits persist via the existing localStorage DB save.
- Demo mode: ship with bundled recent futures prices (label the date).
- Rebuild with `bash build.sh` after editing source files.
