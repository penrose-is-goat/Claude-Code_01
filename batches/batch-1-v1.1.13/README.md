# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.13`
- Provider: local Python `yfinance` backend
- Goal: live-first provider-exact ticker data from a backend instead of browser-side API stitching or cache-first behavior

## Roadmap

- `Batch 1.1.x`
  Stabilize live ticker lookup, provider-exact field mapping, yfinance backend behavior, ETF field handling, and diagnostics.
- `Batch 1.2.1`
  Build the portfolio analysis foundation: portfolio holdings engine, benchmark-aware analysis, saved portfolio workflows, and cleaner portfolio summary tables.
- `Batch 1.2.2`
  Tighten backtesting and comparison behavior: rebalancing controls, contribution assumptions, benchmark comparisons, drawdown tables, and exportable reports.
- `Batch 1.3.1`
  Add methodology-driven analytics: rolling returns, rolling volatility, risk metrics, correlation views, and closer Portfolio Visualizer-style statistics.
- `Batch 1.4.1`
  Expand persistence and customization: portfolio database workflows, saved screens, watchlists, presets, and import/export flows.
- `Batch 1.5.1`
  Final validation and polish: methodology cross-checks against the PDF, UI cleanup, performance tuning, and packaging/handoff improvements.

## Current Status

What Batch 1 v1.1.13 is meant to handle well:

- Live ticker lookup
- Price charts across multiple ranges
- Live ticker fundamentals sourced from `yfinance`
- ETF profile data sourced from `yfinance`
- Provider percent-field unit metadata so ETF yield / expense ratio / turnover render correctly
- ETF `NAV` sourced from `yfinance` when Yahoo exposes `navPrice`
- Provider beta shown separately from computed analytics
- Displayed `YTD`, `1Y`, `3Y`, and `5Y` returns computed from the backend's adjusted-close history path so the return windows use one consistent total-return definition
- Live-first fetches that do not rely on cached DB values when the user requests current data
- Portfolio builder and saved allocations
- Backtesting against benchmark tickers
- Multi-ticker comparison
- Correlation and risk/return views
- Cached fallback via the in-browser SQLite/localStorage database
- Diagnostics that show the last provider request/error instead of a blank `undefined` message
- Safe local DB writes when provider fields are missing

What is still deferred beyond Batch 1.1.x:

- Full fundamentals coverage for all tickers
- Methodology alignment against the attached Portfolio Visualizer PDF
- More precise portfolio analytics and advanced modules

## Quick Start

### Recommended: VS Code + Live Server + Python Backend

1. Open this folder in VS Code:
   `C:\Users\thleg\OneDrive\Documents\New project\portfolio-analyzer-fixed\batches\batch-1-v1.1.13`
2. Install Python 3.11+
3. In PowerShell, run:

```powershell
cd "C:\Users\thleg\OneDrive\Documents\New project\portfolio-analyzer-fixed\batches\batch-1-v1.1.13\backend"
python -m pip install -r .\requirements.txt
python .\server.py
```

4. Install the `Live Server` extension if needed
5. Right-click `index.html`
6. Click `Open with Live Server`
7. Open the `Settings` tab
8. Confirm the backend URL is `http://127.0.0.1:8765/api`
9. Click `Test Backend`
10. Search `NVDA`, `AAPL`, or `SPY`

### Faster start

From the project root, you can also run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-v1.1.13.ps1
```

Or just double-click:

```text
start-v1.1.13.bat
```

That opens a backend PowerShell window for you. Keep that window running while you use the site.

You only need to start the backend again if:

- the backend PowerShell window was closed
- `backend/server.py` changed
- Python packages were updated

If only the frontend changed, keep the backend running and just hard-refresh the browser.

### Rebuild the single-file deliverable

From PowerShell in this folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

## Files

- `index.html`
  The rebuilt single-file app for easy testing in Live Server
- `app-core.js`
  Config, database, API provider integration, financial math
- `app-features.js`
  Ticker lookup, metrics rendering, cached fallback, portfolio UI logic
- `app-backtest.js`
  Backtesting, comparison, dashboard
- `app-main.js`
  App bootstrapping, search, settings UI, API test button
- `build.ps1`
  Windows build script that assembles the deliverable
- `build.sh`
  Bash build script for non-Windows environments
- `portfolio_db.sql`
  Schema reference
- `backend/server.py`
  Local HTTP backend powered by `yfinance`
- `backend/requirements.txt`
  Python dependencies for the backend

## Provider Notes

Batch 1 v1.1.13 uses a local `yfinance` backend for:

- Quotes
- Historical price series
- Search
- Stock fundamentals
- ETF profile data
- ETF NAV
- Provider field source metadata
- Provider field unit metadata for percent-style ETF fields
- Fund holdings and sector-weighting normalization
- Backend health/version metadata so the frontend can detect stale backend sessions
- Trailing `YTD`, `1Y`, `3Y`, and `5Y` total returns computed from adjusted-close history when the direct Yahoo metadata fields do not represent the same public metric

The frontend still computes portfolio analytics in other parts of the app, but the ticker page is now biased toward provider-owned fields first. One important nuance: Yahoo/yfinance metadata such as `threeYearAverageReturn` and `fiveYearAverageReturn` does not match the public trailing `3Y`/`5Y` total-return figure users expect, so Batch `1.1.13` stops displaying those raw average-return fields as if they were trailing total returns.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test Backend` button passes
7. Footer shows `Batch 1 v1.1.13`
8. Settings diagnostics show the same backend version as the frontend batch
9. ETF top sectors / top holdings do not show `N/A` when Yahoo/yfinance returns them
10. ETF `NAV` is populated when Yahoo/yfinance exposes `navPrice`

## v1.1.13 Fixes

- Diagnosed that Yahoo/yfinance `threeYearAverageReturn` and `fiveYearAverageReturn` are not the same metric as trailing `3Y` and `5Y` total return, which is why those values kept looking wrong
- Moved displayed `YTD`, `1Y`, `3Y`, and `5Y` return windows onto a single backend path that computes trailing total return from adjusted-close history
- Added ETF `NAV` support from the provider `navPrice` field
- Expanded diagnostics so Settings shows the displayed return source in addition to field/unit metadata
- Updated the local DB schema so cached ETF records can store `NAV` and adjusted close correctly

## Batch Plan

Batch `1.1.x` remains the data-foundation and ticker-correctness phase.
Batch `1.2.1` should focus on portfolio analysis flows and saved portfolio behavior.
Batch `1.2.2` should focus on backtest/report parity and comparison-table improvements.
Batch `1.3.1` should focus on methodology-driven analytics and Portfolio Visualizer-style rolling metrics.
Batch `1.4.1` should focus on persistence, presets, and user workflows.
Batch `1.5.1` should focus on validation, polish, and handoff quality.

## Batch Folder Convention

Batch artifacts should live under:

- `batches/batch-1-v1.1/`
- `batches/batch-2/`
- etc.

The root folder is the active working copy. The `batches/` folder is for easier handoff and testing snapshots.

## Known Limitations

- Python is required locally to run the backend
- Some fields may still be unavailable if `yfinance`/Yahoo does not expose them for a symbol
- The methodology PDF has not been fully implemented yet
- Some advanced metrics are currently derived from price history only
- Browser-side API apps are still more fragile than a proper backend architecture
