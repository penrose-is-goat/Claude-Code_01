# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.4`
- Provider: `Twelve Data`
- Goal: stable live quote/history lookup, portfolio builder, compare, and backtest foundation with cache-first behavior for free-tier testing plus clearer diagnostics and safer local caching

## Current Status

What Batch 1 v1.1.4 is meant to handle well:

- Live ticker lookup
- Price charts across multiple ranges
- Portfolio builder and saved allocations
- Backtesting against benchmark tickers
- Multi-ticker comparison
- Correlation and risk/return views
- Cached fallback via the in-browser SQLite/localStorage database
- Diagnostics that show the last provider request/error instead of a blank `undefined` message
- Safe local DB writes when provider fields are missing

What is still deferred to Batch 2:

- Full fundamentals coverage for all tickers
- Methodology alignment against the attached Portfolio Visualizer PDF
- More precise portfolio analytics and advanced modules

## Quick Start

### Recommended: VS Code + Live Server

1. Open this folder in VS Code:
   `C:\Users\thleg\OneDrive\Documents\New project\portfolio-analyzer-fixed`
2. Install the `Live Server` extension if needed
3. Right-click `index.html`
4. Click `Open with Live Server`
5. Open the `Settings` tab
6. Confirm the Twelve Data key is present or paste your own
7. Click `Test API`
8. Search `NVDA`, `AAPL`, or `SPY`

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

## Provider Notes

Batch 1 v1.1 uses Twelve Data for:

- Quotes
- Historical price series
- Symbol search

This is a much better fit for testing than the earlier Alpha Vantage build, but it is still only the first batch. Some metrics are derived from price history instead of coming from a full fundamentals endpoint.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test API` button passes
7. Footer shows `Batch 1 v1.1.4`

## v1.1.4 Fixes

- Sanitized SQLite bind params so `undefined` values become `null`
- Prevented local cache-save failures from breaking an otherwise successful live ticker lookup
- Kept diagnostics in place so DB-vs-provider failures are easier to distinguish

## Batch Folder Convention

Batch artifacts should live under:

- `batches/batch-1-v1.1/`
- `batches/batch-2/`
- etc.

The root folder is the active working copy. The `batches/` folder is for easier handoff and testing snapshots.

## Known Limitations

- Fundamentals are still incomplete for some symbols
- The methodology PDF has not been fully implemented yet
- Some advanced metrics are currently derived from price history only
- Browser-side API apps are still more fragile than a proper backend architecture

## Next Step

Batch 2 should focus on:

- fundamentals source integration
- methodology-accurate metrics
- tighter portfolio analytics
- validation against the attached methodology document
