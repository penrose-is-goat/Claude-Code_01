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
The month is split: days before the meeting run at the "old" rate, days from
(meeting day + 1) to month-end run at the "new" rate.

```
impliedAvg = (d_before/N) * rateStart + (d_after/N) * rateEnd
```
- `N` = days in month
- `d_before` = days before and including meeting day
- `d_after` = N - d_before

Solve for the expected post-meeting rate:
```
rateEnd = (N * impliedAvg - d_before * rateStart) / d_after
```
Where `rateStart` comes from the prior month's contract (or current EFFR for
the front month).

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

For multi-meeting horizons, chain the probabilities: each later meeting's
distribution is conditional on each earlier outcome (probability tree). For
a simple tracker, computing the unconditional expected rate per meeting and
mapping to the two nearest 25bp levels is what CME FedWatch shows per-meeting.

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

## Display conventions (match CME/Investing.com)

- Per-meeting card: meeting date, days until, probability bars per target
  range bucket (e.g. "375-400: 62.3%"), colored green for cuts / red for
  hikes / gray for hold.
- Probability bars: horizontal, sorted by rate level descending.
- Show "current target range" prominently at top.
- Show the futures data date ("Based on ZQ futures as of ...").
- A summary strip: "Next meeting: Sep 17 - 68% chance of 25bp cut".

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
