# Side Tools

Two standalone finance tools. **The fastest way to use them is with a live
backend** — one command, then everything fetches its own data.

## Run them with live data (recommended)

```bash
cd side-tools
python3 serve.py
```

That starts a small local server and opens the tools in your browser:

| | |
|---|---|
| **FRED Tool** | http://localhost:8000/fred-tool.html |
| **Fed Tracker** | http://localhost:8000/fed-tracker.html |

With it running:

- **FRED Tool** — type *"sp500, the 10 year and 2 year treasury yields for the
  last 30 years"* and it charts them. No CSV downloading, no pasting.
- **Fed Tracker** — loads 30-Day Fed Funds (ZQ) settlements and your current
  target range automatically, then computes the FOMC probability distribution.

Nothing here needs an API key. Python has no CORS restriction, which is the
whole reason this server exists — the HTML files alone cannot call FRED or CME
from a browser.

Optional: set `FRED_API_KEY` to add the official FRED API as a fallback
(free key at fred.stlouisfed.org/docs/api/api_key.html).

## Data sources

| What | Source | Key? |
|---|---|---|
| FRED macro series | `fred.stlouisfed.org` public CSV export | no |
| FRED (fallback) | official FRED API | free key |
| Fed funds futures | CME public quote feed | no |
| Fed funds futures (fallback) | Yahoo Finance `ZQ*.CBT` | no |
| Current target range | derived from EFFR (`DFF`) | no |

Every response records which source it came from, and the UI shows it. If a
fetch fails you get the error — **no tool here ever substitutes invented
numbers for real ones.**

## Bake data in instead (offline copies)

```bash
python3 fetch_data.py
```

Writes `fred-tool-live.html` and `fed-tracker-live.html` with real data
embedded, plus `market_data.json`. These work with no server and no network.

## Without Python

Open the `.html` files directly. They still work, but you supply the data:

- **FRED Tool** — a failed query gives one-click CSV download links for exactly
  the series and date range you asked for; paste the files into the import box
  (several at once is fine).
- **Fed Tracker** — copy the quote table off CME's 30-Day Fed Funds page and
  paste it into the *Paste CME ZQ quotes* box, or type the prices in.

## Methodology (Fed Tracker)

Each ZQ price implies the average fed funds rate for its contract month
(`100 − price`). Where the next month has no FOMC meeting, that month's implied
average *is* the post-meeting rate; otherwise the meeting month is split at the
decision date and solved:

```
rate_after = (N·implied − days_before·rate_before) / days_after
```

That rate is mapped onto the 25bp target-range grid by linear interpolation,
and outcomes are chained meeting-to-meeting through a binomial tree, so
distributions widen with horizon — the CME FedWatch approach. Verified against
hand arithmetic to zero difference.

FOMC decision dates are editable inputs, since they drive the month split.

## Testing

Both tools are tested in real headless Chromium (Playwright), including under
the artifact publish wrapper and a strict CSP. Tests cover: no fabricated value
can reach the screen, the probability math against hand-computed arithmetic,
every control, poisoned `localStorage`, and the live-backend path against a
stubbed server.
