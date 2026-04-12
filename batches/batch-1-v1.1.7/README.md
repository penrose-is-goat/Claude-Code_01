# Portfolio Analyzer Pro

Portfolio-style analysis site inspired by Portfolio Visualizer, packaged as a browser app with a local in-browser SQLite cache and a single-file `index.html` deliverable.

This workspace is now organized by batches. The current stable target is:

- `Batch 1 v1.1.7`
- Providers: `Twelve Data` for live quote/history and `Alpha Vantage` for stock + ETF fundamentals
- Goal: stable live quote/history lookup plus populated stock and ETF stats with clearer return windows and computed risk metrics

## Current Status

What Batch 1 v1.1.7 is meant to handle well:

- Live ticker lookup
- Price charts across multiple ranges
- Ticker fundamentals such as P/E, forward P/E, market cap, EPS, dividend yield, moving averages, and shares outstanding
- ETF profile data such as net assets, expense ratio, turnover, inception date, top sector, and top holding
- Trailing 1D, 1M, 3M, and 1Y return labels plus a clearly labeled 1D price move
- Computed beta, alpha, delta, and gamma on trailing 1Y history aligned against `SPY`
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

This is a much better fit for testing than the earlier Alpha Vantage-only build, but it is still only the first batch. Some metrics are derived from price history, and some ETF valuation ratios still require a broader fundamentals source.

## Testing Checklist

Use this list before moving to Batch 2:

1. Ticker lookup works for `NVDA`, `AAPL`, `MSFT`, `SPY`
2. Price chart updates when changing ranges
3. Portfolio Builder can add holdings and save allocations
4. Backtest runs on at least `1Y` and `3Y`
5. Compare works for 2-4 symbols
6. Settings `Test API` button passes
7. Footer shows `Batch 1 v1.1.7`

## v1.1.7 Fixes

- Kept the lower-credit Twelve Data flow from `v1.1.6`
- Corrected the ticker page so computed beta/alpha/delta/gamma render after the DOM exists and are labeled as trailing `1Y vs SPY`
- Added clearer return windows so the displayed price move is explicitly `1D vs previous close`
- Added ETF-specific profile fields from Alpha Vantage `ETF_PROFILE`
- Added ETF columns to the base schema for fresh databases

## Batch Plan

Batch 1 remains the data-foundation and ticker-correctness phase.
Batch 2 should focus on stronger portfolio analytics, compare-table fundamentals parity, and methodology alignment against the attached PDF.

## Batch Folder Convention

Batch artifacts should live under:

- `batches/batch-1-v1.1/`
- `batches/batch-2/`
- etc.

The root folder is the active working copy. The `batches/` folder is for easier handoff and testing snapshots.

## Known Limitations

- Some ETF valuation ratios such as weighted P/E are still not available from the current free providers
- The methodology PDF has not been fully implemented yet
- Some advanced metrics are currently derived from price history only
- Browser-side API apps are still more fragile than a proper backend architecture

## Next Step

Batch 2 should focus on:

- fundamentals source integration
- methodology-accurate metrics
- tighter portfolio analytics
- validation against the attached methodology document
